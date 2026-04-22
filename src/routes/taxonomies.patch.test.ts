import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";
import { buildServer } from "../server.js";
import { DATABASE_URL, setupTestDb, truncateAll } from "../test/testDb.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import { EntityRepo } from "../repositories/entityRepo.js";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

/**
 * PATCH /taxonomies/:id with a `fields` change should validate every
 * existing entity against the merged taxonomy. Incompatible changes get
 * 409 with a per-entity breakage map; compatible changes are applied.
 */
runOrSkip("PATCH /taxonomies/:id — entity compatibility guard", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let taxRepo: TaxonomyRepo;
  let entRepo: EntityRepo;

  beforeAll(async () => {
    handle = await setupTestDb();
    app = buildServer({ db: handle.db, logger: false });
    await app.ready();
    taxRepo = new TaxonomyRepo(handle.db);
    entRepo = new EntityRepo(handle.db);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  beforeEach(async () => {
    await truncateAll(handle);
    await taxRepo.upsert({
      id: "widgets",
      name: "Widgets",
      archived: false,
      fields: [
        { key: "sku", type: "string", required: true, is_key: true },
        { key: "count", type: "integer", required: true, is_key: false },
        { key: "on_sale", type: "boolean", required: false, is_key: false },
      ],
      relationships: [],
    });
    await entRepo.upsert({
      id: "widget-1",
      taxonomy_id: "widgets",
      archived: false,
      attributes: { sku: "SKU-1", count: 10, on_sale: true },
    });
    await entRepo.upsert({
      id: "widget-2",
      taxonomy_id: "widgets",
      archived: false,
      attributes: { sku: "SKU-2", count: 20, on_sale: false },
    });
  });

  it("allows a purely additive field change (new optional field) without entity churn", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/taxonomies/widgets",
      payload: {
        fields: [
          { key: "sku", type: "string", required: true, is_key: true },
          { key: "count", type: "integer", required: true, is_key: false },
          { key: "on_sale", type: "boolean", required: false, is_key: false },
          { key: "color", type: "string", required: false, is_key: false },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects removing a field that entities are still using (409)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/taxonomies/widgets",
      payload: {
        fields: [
          { key: "sku", type: "string", required: true, is_key: true },
          { key: "count", type: "integer", required: true, is_key: false },
          // on_sale removed
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: {
        code: string;
        details?: { entities?: Record<string, { on_sale?: string }> };
      };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details?.entities?.["widget-1"]?.on_sale).toBeDefined();
    expect(body.error.details?.entities?.["widget-2"]?.on_sale).toBeDefined();
  });

  it("rejects a type change that invalidates existing entity values (409)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/taxonomies/widgets",
      payload: {
        fields: [
          { key: "sku", type: "string", required: true, is_key: true },
          // count was integer with values 10, 20; date rejects them all
          { key: "count", type: "date", required: true, is_key: false },
          { key: "on_sale", type: "boolean", required: false, is_key: false },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: {
        details?: { entities?: Record<string, { count?: string }> };
      };
    };
    expect(body.error.details?.entities?.["widget-1"]?.count).toBeDefined();
  });

  it("rejects promoting an optional field to required when entities never set it (409)", async () => {
    // First add a new optional field via PATCH
    await app.inject({
      method: "PATCH",
      url: "/taxonomies/widgets",
      payload: {
        fields: [
          { key: "sku", type: "string", required: true, is_key: true },
          { key: "count", type: "integer", required: true, is_key: false },
          { key: "on_sale", type: "boolean", required: false, is_key: false },
          { key: "color", type: "string", required: false, is_key: false },
        ],
      },
    });

    // Now try to make `color` required — nobody has a value for it
    const res = await app.inject({
      method: "PATCH",
      url: "/taxonomies/widgets",
      payload: {
        fields: [
          { key: "sku", type: "string", required: true, is_key: true },
          { key: "count", type: "integer", required: true, is_key: false },
          { key: "on_sale", type: "boolean", required: false, is_key: false },
          { key: "color", type: "string", required: true, is_key: false },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: {
        details?: { entities?: Record<string, unknown> };
      };
    };
    expect(body.error.details?.entities?.["widget-1"]).toBeDefined();
  });

  it("checks archived entities too (they must remain valid for un-archive)", async () => {
    await entRepo.upsert({
      id: "widget-zombie",
      taxonomy_id: "widgets",
      archived: true,
      attributes: { sku: "SKU-Z", count: 99, on_sale: false },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/taxonomies/widgets",
      payload: {
        fields: [
          { key: "sku", type: "string", required: true, is_key: true },
          { key: "count", type: "integer", required: true, is_key: false },
          // on_sale removed; archived widget-zombie is still using it
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: {
        details?: { entities?: Record<string, unknown> };
      };
    };
    expect(body.error.details?.entities?.["widget-zombie"]).toBeDefined();
  });

  it("does not run the compatibility check when only `name` or `archived` changes", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/taxonomies/widgets",
      payload: { name: "Rebranded Widgets" },
    });
    expect(res.statusCode).toBe(200);
  });

  describe("scoping of the entity-compatibility map", () => {
    /**
     * The compatibility guard should list ONLY the entities that break —
     * not every entity in the taxonomy. These tests seed ~100 entities
     * where only a small subset is affected by the change and assert
     * that `details.entities` is correspondingly scoped.
     */

    const COUNT = 100;
    const AFFECTED = [
      "widget-affected-1",
      "widget-affected-2",
      "widget-affected-3",
    ];

    async function seedManyWidgets(): Promise<void> {
      // 100 widgets total. Three of them carry an extra `promo_code` attribute
      // that the base fixture doesn't know about — we'll add that field to the
      // taxonomy in-line, then test scoped failures against it.
      await app.inject({
        method: "PATCH",
        url: "/taxonomies/widgets",
        payload: {
          fields: [
            { key: "sku", type: "string", required: true, is_key: true },
            { key: "count", type: "integer", required: true, is_key: false },
            { key: "on_sale", type: "boolean", required: false, is_key: false },
            {
              key: "promo_code",
              type: "string",
              required: false,
              is_key: false,
            },
          ],
        },
      });

      // Clear the base beforeEach fixtures so we control exactly which
      // entities carry `promo_code`.
      await entRepo.delete("widget-1");
      await entRepo.delete("widget-2");

      for (let i = 0; i < COUNT; i++) {
        const baseAttrs = { sku: `SKU-${i}`, count: i, on_sale: i % 2 === 0 };
        if (i < AFFECTED.length) {
          await entRepo.upsert({
            id: AFFECTED[i]!,
            taxonomy_id: "widgets",
            archived: false,
            attributes: { ...baseAttrs, promo_code: `PROMO-${i}` },
          });
        } else {
          await entRepo.upsert({
            id: `widget-bulk-${i}`,
            taxonomy_id: "widgets",
            archived: false,
            attributes: baseAttrs,
          });
        }
      }
    }

    it("removing a field reports only the entities that actually use it", async () => {
      await seedManyWidgets();

      const res = await app.inject({
        method: "PATCH",
        url: "/taxonomies/widgets",
        payload: {
          fields: [
            { key: "sku", type: "string", required: true, is_key: true },
            { key: "count", type: "integer", required: true, is_key: false },
            { key: "on_sale", type: "boolean", required: false, is_key: false },
            // promo_code removed
          ],
        },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as {
        error: { details?: { entities?: Record<string, unknown> } };
      };
      const entities = body.error.details?.entities ?? {};
      const affectedIds = Object.keys(entities).sort();
      expect(affectedIds).toEqual(AFFECTED.slice().sort());
      // And definitely not the bulk entities.
      for (const id of affectedIds) {
        expect(id.startsWith("widget-bulk-")).toBe(false);
      }
    });

    it("promoting an optional field to required reports only the entities missing it", async () => {
      await seedManyWidgets();

      const res = await app.inject({
        method: "PATCH",
        url: "/taxonomies/widgets",
        payload: {
          fields: [
            { key: "sku", type: "string", required: true, is_key: true },
            { key: "count", type: "integer", required: true, is_key: false },
            { key: "on_sale", type: "boolean", required: false, is_key: false },
            // promo_code is now required — the 97 bulk entities don't have it
            {
              key: "promo_code",
              type: "string",
              required: true,
              is_key: false,
            },
          ],
        },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as {
        error: { details?: { entities?: Record<string, unknown> } };
      };
      const entities = body.error.details?.entities ?? {};
      // Exactly the bulk entities (97 of them) should be reported.
      const reportedIds = Object.keys(entities).sort();
      expect(reportedIds).toHaveLength(COUNT - AFFECTED.length);
      for (const id of reportedIds) {
        expect(id.startsWith("widget-bulk-")).toBe(true);
      }
      // The three that already carry promo_code are NOT reported.
      for (const id of AFFECTED) {
        expect(entities[id]).toBeUndefined();
      }
    });
  });

  it("does not run the compatibility check when only `relationships` changes", async () => {
    // Add another taxonomy to point at
    await taxRepo.upsert({
      id: "suppliers",
      name: "Suppliers",
      archived: false,
      fields: [{ key: "name", type: "string", required: true, is_key: true }],
      relationships: [],
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/taxonomies/widgets",
      payload: {
        relationships: [
          {
            key: "supplier",
            target_taxonomy_id: "suppliers",
            cardinality: "to_one",
            match: [{ source_field: "sku", target_field: "name" }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
