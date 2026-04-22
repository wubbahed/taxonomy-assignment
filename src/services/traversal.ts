import type { AttributeValue, Entity, Taxonomy } from "../shared/index.js";
import { conflict } from "../errors.js";
import type { EntityFetcher } from "./entityFetcher.js";
import { followRelationship, type TraversalContext } from "./relationships.js";

export type TraversalFormat = "nested" | "flat";

/**
 * A nested data node. `id` + flat scalar attributes + nested relationship keys.
 * Each relationship key is either:
 *   - another `DataNode` (to_one hop)
 *   - `null` (to_one with no active match)
 *   - an array of `DataNode` (to_many / to_many_through when include_to_many)
 */
export type DataNode = {
  id: string;
  [key: string]: AttributeValue | DataNode | DataNode[] | null;
};

export type FlatData = Record<string, AttributeValue>;

export interface TraversalResult {
  entity_id: string;
  taxonomy_id: string;
  data: DataNode | FlatData;
  /** Number of entity nodes produced (root + every followed hop). */
  visitedCount: number;
}

export interface TraversalOptions {
  root: Entity;
  depth: number;
  includeToMany: boolean;
  format: TraversalFormat;
  taxonomiesById: Map<string, Taxonomy>;
  fetcher: EntityFetcher;
}

/**
 * Build entity data via lazy BFS: each recursion calls the fetcher for
 * exactly the entities the next level needs.`.
 *
 * Contract semantics (unchanged):
 *  - depth=1 returns only the root's id + its own attributes (no relationships)
 *  - depth=N follows up to N-1 relationship hops
 *  - to_one with no active match → null (nested) / key omitted (flat)
 *  - to_one with multiple matches → 409 conflict (thrown)
 *  - to_many / to_many_through are omitted entirely unless include_to_many=true
 *  - archived related entities are treated as missing (fetcher filters them at
 *    the SQL layer; no post-filter walk needed)
 *  - flat format uses numeric dot-notation indices for arrays (foo.0.bar)
 */
export async function traverseEntityData(
  opts: TraversalOptions,
): Promise<TraversalResult> {
  const rootTaxonomy = opts.taxonomiesById.get(opts.root.taxonomy_id);
  if (!rootTaxonomy) {
    throw new Error(
      `Taxonomy '${opts.root.taxonomy_id}' for entity '${opts.root.id}' not found`,
    );
  }

  const ctx: TraversalContext = {
    taxonomiesById: opts.taxonomiesById,
    fetcher: opts.fetcher,
  };

  const nested = await buildNode(
    opts.root,
    rootTaxonomy,
    opts.depth,
    opts,
    ctx,
  );

  return {
    entity_id: opts.root.id,
    taxonomy_id: opts.root.taxonomy_id,
    data: opts.format === "flat" ? flatten(nested) : nested,
    visitedCount: countNodes(nested),
  };
}

/**
 * Count every DataNode in a nested traversal tree — the root plus every
 * followed to_one / to_many hop. Null to_one branches contribute 0.
 * Exported for metrics instrumentation in the route layer.
 */
export function countNodes(node: DataNode): number {
  let n = 1;
  for (const [key, value] of Object.entries(node)) {
    if (key === "id") continue;
    if (value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && "id" in item) {
          n += countNodes(item as DataNode);
        }
      }
      continue;
    }
    if (typeof value === "object" && "id" in value) {
      n += countNodes(value as DataNode);
    }
  }
  return n;
}

async function buildNode(
  entity: Entity,
  taxonomy: Taxonomy,
  remainingDepth: number,
  opts: TraversalOptions,
  ctx: TraversalContext,
): Promise<DataNode> {
  const node: DataNode = { id: entity.id };

  // Attributes first, in field-declaration order. Unknown keys in the
  // attributes map (shouldn't happen given validation, but defensive) are
  // preserved; missing keys serialize as null.
  for (const field of taxonomy.fields) {
    node[field.key] =
      field.key in entity.attributes ? entity.attributes[field.key]! : null;
  }

  if (remainingDepth <= 1) return node;

  for (const rel of taxonomy.relationships) {
    if (rel.cardinality === "to_one") {
      const matches = await followRelationship(entity, rel, ctx);
      if (matches.length === 0) {
        node[rel.key] = null;
        continue;
      }
      if (matches.length > 1) {
        throw conflict(
          `Relationship '${taxonomy.id}.${rel.key}' on entity '${entity.id}' matched ${matches.length} entities; to_one requires at most one`,
          {
            entity_id: entity.id,
            relationship: rel.key,
            matched_ids: matches.map((m) => m.id),
          },
        );
      }
      const [target] = matches as [Entity];
      const targetTaxonomy = opts.taxonomiesById.get(target.taxonomy_id);
      if (!targetTaxonomy) {
        // Orphan match — taxonomy was deleted. Treat as missing.
        node[rel.key] = null;
        continue;
      }
      node[rel.key] = await buildNode(
        target,
        targetTaxonomy,
        remainingDepth - 1,
        opts,
        ctx,
      );
      continue;
    }

    // to_many + to_many_through
    if (!opts.includeToMany) continue;

    const matches = await followRelationship(entity, rel, ctx);
    const targetTaxonomy = opts.taxonomiesById.get(rel.target_taxonomy_id);
    if (!targetTaxonomy) {
      node[rel.key] = [];
      continue;
    }
    node[rel.key] = await Promise.all(
      matches.map((m) =>
        buildNode(m, targetTaxonomy, remainingDepth - 1, opts, ctx),
      ),
    );
  }

  return node;
}

/**
 * Flatten a DataNode into contract-shaped dot-notation. Arrays use numeric
 * indices: `support_tickets.0.status`, `support_tickets.1.status`, …
 * Null values for to_one hops are omitted (no `foo.bar` key is emitted when
 * `foo` is null) — the absence of the subtree IS the signal.
 */
function flatten(node: DataNode): FlatData {
  const out: FlatData = {};
  walk(node, "", out);
  return out;
}

function walk(value: unknown, prefix: string, out: FlatData): void {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = value === undefined ? null : value;
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const next = prefix ? `${prefix}.${i}` : String(i);
      walk(item, next, out);
    });
    return;
  }
  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${key}` : key;
      // A null relationship subtree becomes… nothing in flat form. There's
      // no way to distinguish `{ care_team: null }` from `{ }` in flat form
      // anyway, and the contract example shows null relationships omitted.
      if (v === null) continue;
      walk(v, next, out);
    }
    return;
  }
  // scalar
  if (prefix) out[prefix] = value as AttributeValue;
}
