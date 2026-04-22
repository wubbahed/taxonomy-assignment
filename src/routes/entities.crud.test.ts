import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";
import { buildServer } from "../server.js";
import { DATABASE_URL, setupTestDb, truncateAll } from "../test/testDb.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import { EntityRepo } from "../repositories/entityRepo.js";
import type { Entity, Taxonomy } from "../shared/index.js";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

const WIDGETS: Taxonomy = {
  id: "widgets",
  name: "Widgets",
  archived: false,
  fields: [
    { key: "sku", type: "string", required: true, is_key: true },
    { key: "count", type: "integer", required: true, is_key: false },
    { key: "on_sale", type: "boolean", required: false, is_key: false },
  ],
  relationships: [],
};

runOrSkip("entity CRUD edge cases", () => {
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
    await taxRepo.upsert(WIDGETS);
  });

  describe("GET /entities", () => {
    it("requires taxonomy_id", async () => {
      const res = await app.inject({ method: "GET", url: "/entities" });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe("validation_error");
    });

    it("returns 404 when taxonomy_id does not exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/entities?taxonomy_id=ghost",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns entities in ascending id order", async () => {
      await entRepo.upsert({
        id: "w-zulu",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "Z", count: 1 },
      });
      await entRepo.upsert({
        id: "w-alpha",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "A", count: 1 },
      });
      await entRepo.upsert({
        id: "w-mike",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "M", count: 1 },
      });

      const res = await app.inject({
        method: "GET",
        url: "/entities?taxonomy_id=widgets",
      });
      const body = res.json() as { data: Entity[] };
      expect(body.data.map((e) => e.id)).toEqual([
        "w-alpha",
        "w-mike",
        "w-zulu",
      ]);
    });

    it("excludes archived entities by default, includes them with include_archived=true", async () => {
      await entRepo.upsert({
        id: "w-live",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "L", count: 1 },
      });
      await entRepo.upsert({
        id: "w-ghost",
        taxonomy_id: "widgets",
        archived: true,
        attributes: { sku: "G", count: 1 },
      });

      const liveOnly = (
        await app.inject({
          method: "GET",
          url: "/entities?taxonomy_id=widgets",
        })
      ).json() as { data: Entity[] };
      expect(liveOnly.data.map((e) => e.id)).toEqual(["w-live"]);

      const all = (
        await app.inject({
          method: "GET",
          url: "/entities?taxonomy_id=widgets&include_archived=true",
        })
      ).json() as { data: Entity[] };
      expect(all.data.map((e) => e.id)).toEqual(["w-ghost", "w-live"]);
    });
  });

  describe("GET /entities/:id", () => {
    it("returns 404 for missing entities", async () => {
      const res = await app.inject({ method: "GET", url: "/entities/nope" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /entities", () => {
    it("returns 404 when taxonomy_id does not exist", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/entities",
        payload: {
          id: "x",
          taxonomy_id: "ghost_taxonomy",
          archived: false,
          attributes: { anything: "at all" },
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 409 on duplicate entity id", async () => {
      const payload = {
        id: "w-dup",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "D", count: 1 },
      };
      const first = await app.inject({
        method: "POST",
        url: "/entities",
        payload,
      });
      expect(first.statusCode).toBe(201);
      const second = await app.inject({
        method: "POST",
        url: "/entities",
        payload,
      });
      expect(second.statusCode).toBe(409);
    });
  });

  describe("PATCH /entities/:id", () => {
    beforeEach(async () => {
      await entRepo.upsert({
        id: "w-1",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "A", count: 1, on_sale: false },
      });
    });

    it("merges new attribute keys into the existing attributes map", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/entities/w-1",
        payload: { attributes: { count: 99 } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Entity;
      expect(body.attributes).toEqual({ sku: "A", count: 99, on_sale: false });
    });

    it("allows setting optional attribute to null", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/entities/w-1",
        payload: { attributes: { on_sale: null } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Entity;
      expect(body.attributes.on_sale).toBeNull();
    });

    it("rejects a PATCH that tries to change id", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/entities/w-1",
        payload: { id: "w-other" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a PATCH that tries to change taxonomy_id", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/entities/w-1",
        payload: { taxonomy_id: "something_else" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for a missing entity", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/entities/does-not-exist",
        payload: { archived: true },
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects a PATCH whose attribute value is an object", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/entities/w-1",
        payload: { attributes: { count: { nested: 1 } } },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /entities/:id", () => {
    it("returns 204 on success and 404 afterwards", async () => {
      await entRepo.upsert({
        id: "w-del",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "D", count: 1 },
      });
      const del = await app.inject({
        method: "DELETE",
        url: "/entities/w-del",
      });
      expect(del.statusCode).toBe(204);

      const after = await app.inject({ method: "GET", url: "/entities/w-del" });
      expect(after.statusCode).toBe(404);
    });

    it("returns 404 when deleting a missing entity", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/entities/never-existed",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("non-ASCII attribute values", () => {
    it("round-trips Chinese, Japanese, Arabic, and emoji without corruption", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/entities",
        payload: {
          id: "w-intl",
          taxonomy_id: "widgets",
          archived: false,
          attributes: {
            sku: "SKU-山田-🎉",
            count: 3,
            on_sale: true,
          },
        },
      });
      expect(create.statusCode).toBe(201);

      const get = await app.inject({ method: "GET", url: "/entities/w-intl" });
      expect(get.statusCode).toBe(200);
      const body = get.json() as Entity;
      expect(body.attributes.sku).toBe("SKU-山田-🎉");
    });

    it("stores NFC-normalized strings even when the client sends NFD", async () => {
      // `café` in NFD — `e` + combining acute. 5 JS code units.
      const nfdSku = "caf\u0065\u0301";
      // Same visible string in NFC — `é` as precomposed. 4 JS code units.
      const nfcSku = "caf\u00e9";
      expect(nfdSku).not.toBe(nfcSku);

      const create = await app.inject({
        method: "POST",
        url: "/entities",
        payload: {
          id: "w-unicode",
          taxonomy_id: "widgets",
          archived: false,
          attributes: { sku: nfdSku, count: 1 },
        },
      });
      expect(create.statusCode).toBe(201);

      const get = await app.inject({
        method: "GET",
        url: "/entities/w-unicode",
      });
      const body = get.json() as Entity;
      // The server should have canonicalized on write.
      expect(body.attributes.sku).toBe(nfcSku);
      expect(body.attributes.sku).not.toBe(nfdSku);
    });

    it("makes NFD-written and NFC-written 'same' strings collide on listByTaxonomy filter", async () => {
      // Two entities written with the same logical sku, different byte forms.
      // Both should survive and be retrievable; the key point is neither is
      // corrupted or rejected by validation.
      const nfd = "resume\u0301-variant"; // "resumé-variant" NFD
      const nfc = "resum\u00e9-variant"; // same thing NFC
      await app.inject({
        method: "POST",
        url: "/entities",
        payload: {
          id: "w-resume-nfd",
          taxonomy_id: "widgets",
          archived: false,
          attributes: { sku: nfd, count: 1 },
        },
      });
      await app.inject({
        method: "POST",
        url: "/entities",
        payload: {
          id: "w-resume-nfc",
          taxonomy_id: "widgets",
          archived: false,
          attributes: { sku: nfc, count: 2 },
        },
      });

      const list = await app.inject({
        method: "GET",
        url: "/entities?taxonomy_id=widgets",
      });
      const body = list.json() as { data: Entity[] };
      const skus = body.data
        .filter((e) => e.id.startsWith("w-resume"))
        .map((e) => e.attributes.sku);
      // After NFC normalization on write, both stored values collapse to the
      // same canonical byte sequence — the "two encodings of the same string"
      // problem disappears at the storage layer.
      expect(skus).toHaveLength(2);
      expect(new Set(skus).size).toBe(1);
      expect(skus[0]).toBe(nfc);
    });

    it("preserves non-string attribute values while normalizing strings on PATCH", async () => {
      await app.inject({
        method: "POST",
        url: "/entities",
        payload: {
          id: "w-patch-intl",
          taxonomy_id: "widgets",
          archived: false,
          attributes: { sku: "ORIG", count: 0 },
        },
      });
      const patch = await app.inject({
        method: "PATCH",
        url: "/entities/w-patch-intl",
        payload: {
          attributes: {
            sku: "caf\u0065\u0301", // NFD
            count: 99,
          },
        },
      });
      expect(patch.statusCode).toBe(200);
      const body = patch.json() as Entity;
      expect(body.attributes.sku).toBe("caf\u00e9"); // NFC
      expect(body.attributes.count).toBe(99);
    });
  });
});
