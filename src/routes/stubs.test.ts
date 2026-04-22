import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";
import { buildServer } from "../server.js";
import { DATABASE_URL, setupTestDb, truncateAll } from "../test/testDb.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import { EntityRepo } from "../repositories/entityRepo.js";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

runOrSkip(
  "traversal endpoints — precondition precedence (404/400 before service call)",
  () => {
    let handle: DbHandle;
    let app: FastifyInstance;

    beforeAll(async () => {
      handle = await setupTestDb();
      app = buildServer({ db: handle.db, logger: false });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
      await handle.close();
    });

    beforeEach(async () => {
      await truncateAll(handle);
      const taxRepo = new TaxonomyRepo(handle.db);
      const entRepo = new EntityRepo(handle.db);
      await taxRepo.upsert({
        id: "widgets",
        name: "Widgets",
        archived: false,
        fields: [{ key: "sku", type: "string", required: true, is_key: true }],
        relationships: [],
      });
      await entRepo.upsert({
        id: "w-1",
        taxonomy_id: "widgets",
        archived: false,
        attributes: { sku: "A" },
      });
    });

    describe("GET /taxonomies/:id/relationship-graph", () => {
      it("returns 404 for a missing taxonomy before the 501 stub fires", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/taxonomies/ghost/relationship-graph",
        });
        expect(res.statusCode).toBe(404);
      });

      it("rejects depth=0 with 400 before the 501 stub fires", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/taxonomies/widgets/relationship-graph?depth=0",
        });
        expect(res.statusCode).toBe(400);
      });

      it("rejects non-integer depth with 400", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/taxonomies/widgets/relationship-graph?depth=abc",
        });
        expect(res.statusCode).toBe(400);
      });

      it("rejects depth above MAX_DEPTH with 400", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/taxonomies/widgets/relationship-graph?depth=10000",
        });
        expect(res.statusCode).toBe(400);
        const body = res.json() as {
          error: { code: string; details?: { max_depth: number } };
        };
        expect(body.error.code).toBe("validation_error");
        expect(body.error.details?.max_depth).toBeGreaterThan(0);
      });

      // /relationship-graph is now implemented; see graph.test.ts for coverage.
    });

    describe("GET /entities/:id/data", () => {
      it("returns 404 for a missing entity before the 501 stub fires", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/entities/ghost/data",
        });
        expect(res.statusCode).toBe(404);
      });

      it("rejects an unknown format with 400", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/entities/w-1/data?format=weird",
        });
        expect(res.statusCode).toBe(400);
      });

      // /entities/:id/data is now implemented; see traversal.test.ts and data.integration.test.ts
    });

    describe("POST /resolve", () => {
      it("returns 400 for a missing body", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/resolve",
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      });

      it("returns 404 for a missing entity before the 501 stub fires", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/resolve",
          payload: { entity_id: "ghost", paths: ["anything"] },
        });
        expect(res.statusCode).toBe(404);
      });

      it("rejects an empty paths array", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/resolve",
          payload: { entity_id: "w-1", paths: [] },
        });
        expect(res.statusCode).toBe(400);
      });

      // /resolve is now implemented; see resolver.test.ts and resolve.integration.test.ts
    });
  },
);
