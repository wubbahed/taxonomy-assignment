import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";
import { buildServer } from "../server.js";
import { DATABASE_URL, setupTestDb, truncateAll } from "../test/testDb.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import { EntityRepo } from "../repositories/entityRepo.js";
import type { Taxonomy } from "../shared/index.js";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

const BASE: Taxonomy = {
  id: "widgets",
  name: "Widgets",
  archived: false,
  fields: [
    { key: "sku", type: "string", required: true, is_key: true },
    { key: "count", type: "integer", required: true, is_key: false },
  ],
  relationships: [],
};

runOrSkip("taxonomy CRUD edge cases", () => {
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
  });

  describe("GET /taxonomies", () => {
    it("returns taxonomies in ascending id order", async () => {
      await taxRepo.upsert({ ...BASE, id: "zulu" });
      await taxRepo.upsert({ ...BASE, id: "alpha" });
      await taxRepo.upsert({ ...BASE, id: "mike" });

      const res = await app.inject({ method: "GET", url: "/taxonomies" });
      const body = res.json() as { data: Array<{ id: string }> };
      expect(body.data.map((t) => t.id)).toEqual(["alpha", "mike", "zulu"]);
    });

    it("excludes archived taxonomies by default", async () => {
      await taxRepo.upsert({ ...BASE, id: "active" });
      await taxRepo.upsert({ ...BASE, id: "ghost", archived: true });

      const res = await app.inject({ method: "GET", url: "/taxonomies" });
      const body = res.json() as { data: Array<{ id: string }> };
      expect(body.data.map((t) => t.id)).toEqual(["active"]);
    });

    it("includes archived taxonomies when include_archived=true", async () => {
      await taxRepo.upsert({ ...BASE, id: "active" });
      await taxRepo.upsert({ ...BASE, id: "ghost", archived: true });

      const res = await app.inject({
        method: "GET",
        url: "/taxonomies?include_archived=true",
      });
      const body = res.json() as { data: Array<{ id: string }> };
      expect(body.data.map((t) => t.id)).toEqual(["active", "ghost"]);
    });

    it("rejects an invalid include_archived value with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/taxonomies?include_archived=maybe",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /taxonomies", () => {
    it("returns 409 when the id already exists", async () => {
      await taxRepo.upsert(BASE);
      const res = await app.inject({
        method: "POST",
        url: "/taxonomies",
        payload: BASE,
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe("conflict");
    });

    it("returns 400 when fields contain duplicate keys", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/taxonomies",
        payload: {
          ...BASE,
          id: "dupes",
          fields: [
            { key: "a", type: "string", required: true, is_key: true },
            { key: "a", type: "integer", required: false, is_key: false },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PATCH /taxonomies/:id", () => {
    it("patching name alone preserves fields and relationships", async () => {
      await taxRepo.upsert(BASE);
      const res = await app.inject({
        method: "PATCH",
        url: "/taxonomies/widgets",
        payload: { name: "Widgets Renamed" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Taxonomy;
      expect(body.name).toBe("Widgets Renamed");
      expect(body.fields).toHaveLength(BASE.fields.length);
    });

    it("replaces the entire fields list when fields is provided", async () => {
      await taxRepo.upsert(BASE);
      const res = await app.inject({
        method: "PATCH",
        url: "/taxonomies/widgets",
        payload: {
          fields: [
            { key: "only", type: "string", required: true, is_key: true },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Taxonomy;
      expect(body.fields).toHaveLength(1);
      expect(body.fields[0]?.key).toBe("only");
    });

    it("rejects a PATCH attempting to change id", async () => {
      await taxRepo.upsert(BASE);
      const res = await app.inject({
        method: "PATCH",
        url: "/taxonomies/widgets",
        payload: { id: "other" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 when patching a missing taxonomy", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/taxonomies/does-not-exist",
        payload: { name: "x" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /taxonomies/:id", () => {
    it("returns 204 on success", async () => {
      await taxRepo.upsert(BASE);
      const res = await app.inject({
        method: "DELETE",
        url: "/taxonomies/widgets",
      });
      expect(res.statusCode).toBe(204);
      expect(await taxRepo.get("widgets")).toBeNull();
    });

    it("returns 404 when the taxonomy is missing", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/taxonomies/does-not-exist",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 409 when entities still belong to the taxonomy", async () => {
      await taxRepo.upsert(BASE);
      await entRepo.upsert({
        id: "w-1",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "A", count: 1 },
      });
      const res = await app.inject({
        method: "DELETE",
        url: "/taxonomies/widgets",
      });
      expect(res.statusCode).toBe(409);
    });

    it("returns 409 when another taxonomy references this one", async () => {
      await taxRepo.upsert(BASE);
      await taxRepo.upsert({
        id: "owners",
        name: "Owners",
        archived: false,
        fields: [
          { key: "id_field", type: "string", required: true, is_key: true },
          { key: "widget_sku", type: "string", required: true, is_key: false },
        ],
        relationships: [
          {
            key: "widget",
            target_taxonomy_id: "widgets",
            cardinality: "to_one",
            match: [{ source_field: "widget_sku", target_field: "sku" }],
          },
        ],
      });

      const res = await app.inject({
        method: "DELETE",
        url: "/taxonomies/widgets",
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as {
        error: { code: string; details?: { referenced_by?: string } };
      };
      expect(body.error.details?.referenced_by).toBe("owners.widget");
    });
  });
});
