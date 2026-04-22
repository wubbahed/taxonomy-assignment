import type { Taxonomy } from "../shared/index.js";
import { payloadTooLarge } from "../errors.js";

/**
 * Shape of a single node in the relationship graph. Every node carries a
 * `taxonomy_id`; field keys map to their type string (`"string"`, `"integer"`,
 * ...); relationship keys map to the nested node for the target taxonomy.
 */
export type GraphNode = {
  taxonomy_id: string;
  [key: string]: string | GraphNode;
};

export interface GraphResponse {
  taxonomy_id: string;
  depth: number;
  graph: GraphNode;
}

export interface BuildGraphOptions {
  taxonomyId: string;
  depth: number;
  /** All taxonomies known to the system, keyed by id. */
  byId: Map<string, Taxonomy>;
}

/**
 * Hard ceiling on the `depth` query parameter. The traversal contract
 * allows any positive integer; this cap stops a single request from
 * producing a tree that's exponential in depth × fan-out. The route
 * layer rejects with 400 before any work is done — `buildRelationshipGraph`
 * itself trusts its input.
 */
export const MAX_DEPTH = 50;

/**
 * Hard ceiling on the number of `GraphNode`s the builder will allocate
 * before giving up with 413. A tree with ~10k nodes serializes to roughly
 * ~1MB of JSON — far beyond any legitimate graph-inspection use case,
 * while still a tiny fraction of node's memory headroom.
 *
 * Depth cap alone isn't enough: a DAG with fan-out b=4 hits 10^12 nodes
 * at depth=20, which the cap allows. The node budget catches the
 * dense-DAG case that the depth cap misses.
 */
export const MAX_GRAPH_NODES = 10_000;

/**
 * Build a relationship graph for a taxonomy.
 *
 * Contract semantics:
 *  - `depth=1`   → the root taxonomy's own fields, no relationships
 *  - `depth=2`   → includes one relationship hop
 *  - `depth=3`   → includes two hops, and so on
 *  - archived **target** taxonomies are skipped during recursion
 *  - cycles are broken via a per-path visited set keyed by `taxonomy_id`
 *  - returns `null` for the root when the taxonomy id is unknown; callers
 *    should translate that into a 404
 *
 * Throws a 413 `response_too_large` `AppError` if the node budget is
 * exceeded mid-traversal — the caller gets nothing rather than a truncated
 * graph, since a partial tree would be silently wrong.
 */
export function buildRelationshipGraph(
  opts: BuildGraphOptions,
): GraphResponse | null {
  const root = opts.byId.get(opts.taxonomyId);
  if (!root) return null;

  const budget = { count: 0 };
  const graph = expand(root, opts.depth, opts.byId, new Set(), budget);

  return {
    taxonomy_id: opts.taxonomyId,
    depth: opts.depth,
    graph,
  };
}

function expand(
  taxonomy: Taxonomy,
  remainingDepth: number,
  byId: Map<string, Taxonomy>,
  visited: ReadonlySet<string>,
  budget: { count: number },
): GraphNode {
  budget.count += 1;
  if (budget.count > MAX_GRAPH_NODES) {
    throw payloadTooLarge(
      `Relationship graph exceeds the server node budget (${MAX_GRAPH_NODES}); narrow the request with a lower \`depth\`.`,
      { max_nodes: MAX_GRAPH_NODES },
    );
  }

  const node: GraphNode = { taxonomy_id: taxonomy.id };

  // Fields first, preserving taxonomy-declared order.
  for (const field of taxonomy.fields) {
    node[field.key] = field.type;
  }

  if (remainingDepth <= 1) return node;

  // Extend the visited set for the subtree rooted here. Using a fresh Set
  // per branch (not a shared mutable one) means two sibling branches can
  // both visit the same taxonomy independently — we only break cycles
  // along a single path of descent.
  const nextVisited = new Set(visited).add(taxonomy.id);

  for (const rel of taxonomy.relationships) {
    const target = byId.get(rel.target_taxonomy_id);
    if (!target) continue; // unknown target — skip silently
    if (target.archived) continue; // archived target — contract says omit
    if (nextVisited.has(target.id)) continue; // cycle — break here

    node[rel.key] = expand(
      target,
      remainingDepth - 1,
      byId,
      nextVisited,
      budget,
    );
  }

  return node;
}
