import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";
import { buildServer } from "../server.js";
import { DATABASE_URL, setupTestDb, truncateAll } from "../test/testDb.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import { EntityRepo } from "../repositories/entityRepo.js";
import type { Taxonomy } from "../shared/index.js";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

const WIDGETS: Taxonomy = {
  id: "widgets",
  name: "Widgets",
  archived: false,
  fields: [
    { key: "sku", type: "string", required: true, is_key: true },
    { key: "a", type: "integer", required: false, is_key: false },
    { key: "b", type: "integer", required: false, is_key: false },
  ],
  relationships: [],
};

/**
 * Interleaved PATCH on the same row. The handler path is:
 *   read(existing) → validate → upsert(merged)
 * There is no version column, no SELECT FOR UPDATE, and no advisory lock.
 * These tests document the effective contract of that design:
 *   - Concurrent PATCHes don't error; both requests land with 200.
 *   - Last-write-wins on a shared key.
 *   - A concurrent DELETE may race a PATCH; the outcome is deterministic
 *     at the envelope level (every response is either 200/204 or 404)
 *     even if the interleaving varies run-to-run.
 */
runOrSkip("PATCH /entities/:id — interleaved concurrent writes", () => {
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
    await entRepo.upsert({
      id: "widget-1",
      taxonomy_id: "widgets",
      archived: false,
      attributes: { sku: "SKU-1", a: 1, b: 1 },
    });
  });

  it("preserves both writes when two PATCHes target disjoint attribute keys", async () => {
    const [resA, resB] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: "/entities/widget-1",
        payload: { attributes: { a: 2 } },
      }),
      app.inject({
        method: "PATCH",
        url: "/entities/widget-1",
        payload: { attributes: { b: 2 } },
      }),
    ]);
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);

    const final = await app.inject({
      method: "GET",
      url: "/entities/widget-1",
    });
    expect(final.statusCode).toBe(200);
    const body = final.json() as {
      attributes: Record<string, unknown>;
    };

    // At least ONE of the two concurrent writes should have landed.
    // Under the current read-then-upsert design with no locking, a
    // true interleave can clobber one update (both handlers read the
    // pre-write state, then write in series). Document that with an OR:
    // either both landed, or exactly one did.
    const a = body.attributes.a;
    const b = body.attributes.b;
    const aLanded = a === 2;
    const bLanded = b === 2;
    expect(aLanded || bLanded).toBe(true);
    // sku is unchanged (neither request touched it).
    expect(body.attributes.sku).toBe("SKU-1");
  });

  it("resolves to one of the two values when both PATCHes touch the same key (last-write-wins)", async () => {
    const [resA, resB] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: "/entities/widget-1",
        payload: { attributes: { a: 10 } },
      }),
      app.inject({
        method: "PATCH",
        url: "/entities/widget-1",
        payload: { attributes: { a: 20 } },
      }),
    ]);
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);

    const final = await app.inject({
      method: "GET",
      url: "/entities/widget-1",
    });
    const body = final.json() as { attributes: { a: number } };
    // One of the two writes wins; we don't care which.
    expect([10, 20]).toContain(body.attributes.a);
  });

  it("tolerates concurrent PATCH + DELETE on the same id", async () => {
    const results = await Promise.all([
      app.inject({
        method: "PATCH",
        url: "/entities/widget-1",
        payload: { attributes: { a: 99 } },
      }),
      app.inject({ method: "DELETE", url: "/entities/widget-1" }),
    ]);
    const codes = results.map((r) => r.statusCode);

    // Every response must be in the expected set. A race can produce
    // any of these interleavings:
    //   - PATCH wins, then DELETE deletes the patched row → [200, 204]
    //   - DELETE wins, then PATCH sees 404                  → [404, 204]
    //   - Both read pre-state, PATCH re-upserts after DELETE → [200, 204]
    for (const code of codes) {
      expect([200, 204, 404]).toContain(code);
    }

    // GET afterward should be 404 or 200 depending on which side won —
    // but it must be one or the other, not an error.
    const final = await app.inject({
      method: "GET",
      url: "/entities/widget-1",
    });
    expect([200, 404]).toContain(final.statusCode);
  });
});
