import type {
  AttributeValue,
  Entity,
  Relationship,
  Taxonomy,
} from "../shared/index.js";
import type { EntityFetcher } from "./entityFetcher.js";

/**
 * Read-time context shared across traversal services (`/resolve`,
 * `/entities/:id/data`). Carries the taxonomy map and the entity
 * fetcher; no more pre-materialized entity list. Each service walks
 * its own sub-slice of the graph and calls `fetcher.fetchMatching()`
 * on demand.
 */
export interface TraversalContext {
  taxonomiesById: Map<string, Taxonomy>;
  fetcher: EntityFetcher;
}

/**
 * Resolve a relationship from a single source entity to the set of
 * matching target entities. Archived targets are excluded. Results are
 * deduped by id and sorted ascending — every caller gets contract-
 * mandated stable ordering for free.
 *
 * Handles all three cardinalities:
 *  - `to_one` / `to_many`: direct field-matching on `match` clauses
 *  - `to_many_through`: walks the `through` chain, resolving each hop
 *    via recursive calls (each hop is itself a direct relationship on
 *    the cursor taxonomy's schema).
 */
export async function followRelationship(
  source: Entity,
  relationship: Relationship,
  ctx: TraversalContext,
): Promise<Entity[]> {
  if (relationship.cardinality === "to_many_through") {
    return followThroughChain(source, relationship.through, ctx);
  }
  return followDirect(source, relationship, ctx);
}

/**
 * Batched form: resolve a single relationship from a SET of source
 * entities in one query. The BFS traversal engine uses this so a level
 * with N siblings at the same taxonomy emits one SQL call per relationship,
 * not N.
 *
 * Returns `Map<sourceId, Entity[]>` so callers can attach the results
 * back to each source entity in the tree.
 */
export async function followRelationshipBatch(
  sources: Entity[],
  relationship: Relationship,
  ctx: TraversalContext,
): Promise<Map<string, Entity[]>> {
  const result = new Map<string, Entity[]>();
  if (sources.length === 0) return result;

  if (relationship.cardinality === "to_many_through") {
    // Through-chain: each source walks independently. While we could theoretically
    // merge the per-hop fetches across sources, doing so requires complex grouping
    // by intermediate cursor. We deliberately chose not to over-optimize this:
    // the current approach is much simpler, highly readable, and performant enough
    // since each hop is still just a single SQL query per source.
    for (const source of sources) {
      result.set(
        source.id,
        await followThroughChain(source, relationship.through, ctx),
      );
    }
    return result;
  }

  // Direct relationship: one batched query covers every source at once.
  const probes: Record<string, AttributeValue>[] = [];
  const probeToSourceIds = new Map<string, string[]>();
  for (const source of sources) {
    const probe = buildProbe(source, relationship.match);
    if (probe === null) continue; // source has a null/missing source field — no matches
    const key = JSON.stringify(probe);
    const existing = probeToSourceIds.get(key);
    if (existing) {
      existing.push(source.id);
    } else {
      probes.push(probe);
      probeToSourceIds.set(key, [source.id]);
    }
  }

  if (probes.length === 0) {
    for (const source of sources) result.set(source.id, []);
    return result;
  }

  const targets = await ctx.fetcher.fetchMatching(
    relationship.target_taxonomy_id,
    probes,
  );

  // Post-filter per source: a single batched query returns every target
  // whose attributes contain ANY probe. Each source's result is the
  // targets matching that source's specific probe.
  for (const source of sources) {
    const probe = buildProbe(source, relationship.match);
    if (probe === null) {
      result.set(source.id, []);
      continue;
    }
    const matched = targets.filter((t) => targetMatchesProbe(t, probe));
    result.set(source.id, dedupeAndSort(matched));
  }
  return result;
}

async function followDirect(
  source: Entity,
  relationship: Extract<Relationship, { cardinality: "to_one" | "to_many" }>,
  ctx: TraversalContext,
): Promise<Entity[]> {
  const probe = buildProbe(source, relationship.match);
  if (probe === null) return [];
  const matches = await ctx.fetcher.fetchMatching(
    relationship.target_taxonomy_id,
    [probe],
  );
  return dedupeAndSort(matches);
}

async function followThroughChain(
  source: Entity,
  through: string[],
  ctx: TraversalContext,
): Promise<Entity[]> {
  let current: Entity[] = [source];
  let cursorTaxonomy = ctx.taxonomiesById.get(source.taxonomy_id);

  for (const hopKey of through) {
    if (!cursorTaxonomy) return [];
    const hop = cursorTaxonomy.relationships.find((r) => r.key === hopKey);
    if (!hop) return [];

    // Batched walk for this hop: one query across all current sources.
    const hopResults = await followRelationshipBatch(current, hop, ctx);
    const next: Entity[] = [];
    for (const list of hopResults.values()) next.push(...list);
    current = dedupeAndSort(next);
    cursorTaxonomy = ctx.taxonomiesById.get(hop.target_taxonomy_id);
  }
  return current;
}

/**
 * Build a probe from a source entity + match clauses. Returns null if
 * any source field is null/undefined — a missing source field never
 * matches, and returning null lets the caller skip the probe entirely.
 */
function buildProbe(
  source: Entity,
  clauses: ReadonlyArray<{ source_field: string; target_field: string }>,
): Record<string, AttributeValue> | null {
  const probe: Record<string, AttributeValue> = {};
  for (const clause of clauses) {
    const value = source.attributes[clause.source_field];
    if (value === null || value === undefined) return null;
    probe[clause.target_field] = value;
  }
  return probe;
}

/** JS-side containment check mirroring the SQL `@>` semantics. Used to
 *  route results of a batched fetch back to individual source entities. */
function targetMatchesProbe(
  target: Entity,
  probe: Record<string, AttributeValue>,
): boolean {
  for (const [k, v] of Object.entries(probe)) {
    if (!(k in target.attributes)) return false;
    if (target.attributes[k] !== v) return false;
  }
  return true;
}

function dedupeAndSort(entities: Entity[]): Entity[] {
  const byId = new Map<string, Entity>();
  for (const e of entities) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}
