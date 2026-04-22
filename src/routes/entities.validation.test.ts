import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";
import { buildServer } from "../server.js";
import { DATABASE_URL, setupTestDb } from "../test/testDb.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

runOrSkip("entity + taxonomy POST validation", () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = await setupTestDb();
    app = buildServer({ db: handle.db, logger: false });
    await app.ready();

    const repo = new TaxonomyRepo(handle.db);
    await repo.upsert({
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
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it("rejects an entity whose attribute value is an object", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/entities",
      payload: {
        id: "w-1",
        taxonomy_id: "widgets",
        archived: false,
        attributes: {
          sku: "SKU-1",
          count: 1,
          // nested object - must be rejected
          on_sale: { nested: true },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects an entity whose attribute value is an array", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/entities",
      payload: {
        id: "w-2",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: ["not", "scalar"], count: 1 },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an entity with an attribute key that is not on the taxonomy", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/entities",
      payload: {
        id: "w-3",
        taxonomy_id: "widgets",
        archived: false,
        attributes: {
          sku: "SKU-3",
          count: 1,
          unknown_field: "nope",
        },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: { code: string; details?: { fields?: Record<string, string> } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.fields?.unknown_field).toBeDefined();
  });

  it("rejects an entity missing a required attribute", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/entities",
      payload: {
        id: "w-4",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "SKU-4" },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: { details?: { fields?: Record<string, string> } };
    };
    expect(body.error.details?.fields?.count).toBeDefined();
  });

  it("rejects an entity whose integer field receives a string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/entities",
      payload: {
        id: "w-5",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "SKU-5", count: "not-a-number" },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a taxonomy with an unsupported field type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/taxonomies",
      payload: {
        id: "gadgets",
        name: "Gadgets",
        archived: false,
        fields: [{ key: "spec", type: "object", required: true, is_key: true }],
        relationships: [],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a taxonomy whose relationship match references a nonexistent field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/taxonomies",
      payload: {
        id: "bad_rel",
        name: "Bad Rel",
        archived: false,
        fields: [
          { key: "id_field", type: "string", required: true, is_key: true },
        ],
        relationships: [
          {
            key: "ref",
            target_taxonomy_id: "widgets",
            cardinality: "to_one",
            match: [{ source_field: "ghost_field", target_field: "sku" }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a valid entity end-to-end", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/entities",
      payload: {
        id: "w-ok",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "SKU-OK", count: 42, on_sale: true },
      },
    });
    expect(res.statusCode).toBe(201);
  });
});
