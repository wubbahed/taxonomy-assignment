import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";
import { buildServer } from "../server.js";
import { DATABASE_URL, setupTestDb, truncateAll } from "../test/testDb.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import { MAX_GRAPH_NODES } from "../services/graph.js";
import type { Relationship, Taxonomy } from "../shared/index.js";

/**
 * Gated: opt in with RUN_STRESS=1. These tests seed enough taxonomies
 * to exercise the node-budget ceiling via a real DB-backed request,
 * which is too slow to pay for on every test run. The related unit
 * tests in `graph.depth.test.ts` prove the same boundary through the
 * synthetic map path.
 */
const runStress =
  DATABASE_URL && process.env.RUN_STRESS === "1" ? describe : describe.skip;

/** A leaf taxonomy — no relationships, one placeholder field. */
function leafTaxonomy(id: string): Taxonomy {
  return {
    id,
    name: id,
    archived: false,
    fields: [{ key: "k", type: "string", required: true, is_key: true }],
    relationships: [],
  };
}

/** A root taxonomy that points at `n` leaves via `n` to_one relationships. */
function rootWithNLeaves(n: number): Taxonomy {
  const relationships: Relationship[] = Array.from({ length: n }, (_, i) => ({
    key: `r${i}`,
    target_taxonomy_id: `leaf-${i}`,
    cardinality: "to_one",
    match: [{ source_field: "k", target_field: "k" }],
  }));
  return {
    id: "root",
    name: "root",
    archived: false,
    fields: [{ key: "k", type: "string", required: true, is_key: true }],
    relationships,
  };
}

runStress("GET /taxonomies/:id/relationship-graph (stress)", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let taxRepo: TaxonomyRepo;

  beforeAll(async () => {
    handle = await setupTestDb();
    app = buildServer({ db: handle.db, logger: false });
    await app.ready();
    taxRepo = new TaxonomyRepo(handle.db);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  beforeEach(async () => {
    await truncateAll(handle);
  });

  it("returns 413 when the graph would exceed MAX_GRAPH_NODES nodes", async () => {
    // Root + (MAX + 1) leaves → total = MAX + 2 nodes. The builder throws
    // the moment count hits MAX + 1, so this is comfortably over budget.
    const n = MAX_GRAPH_NODES + 1;
    const leaves = Array.from({ length: n }, (_, i) =>
      leafTaxonomy(`leaf-${i}`),
    );
    await taxRepo.upsertMany(leaves);
    await taxRepo.upsert(rootWithNLeaves(n));

    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/root/relationship-graph?depth=2",
    });
    expect(res.statusCode).toBe(413);
    const body = res.json() as {
      error: { code: string; details?: { max_nodes?: number } };
    };
    expect(body.error.code).toBe("response_too_large");
    expect(body.error.details?.max_nodes).toBe(MAX_GRAPH_NODES);
  }, 60_000);

  it("succeeds at exactly MAX_GRAPH_NODES nodes", async () => {
    // Root + (MAX - 1) leaves = MAX total. Builder counts 1..MAX, does
    // not throw.
    const n = MAX_GRAPH_NODES - 1;
    const leaves = Array.from({ length: n }, (_, i) =>
      leafTaxonomy(`leaf-${i}`),
    );
    await taxRepo.upsertMany(leaves);
    await taxRepo.upsert(rootWithNLeaves(n));

    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/root/relationship-graph?depth=2",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      taxonomy_id: string;
      depth: number;
      graph: Record<string, unknown>;
    };
    expect(body.taxonomy_id).toBe("root");
    expect(body.depth).toBe(2);
    // One nested node per leaf relationship.
    const relKeys = Object.keys(body.graph).filter((k) => k.startsWith("r"));
    expect(relKeys).toHaveLength(n);
  }, 60_000);
});
