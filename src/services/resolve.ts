import type { AttributeValue, Entity, Taxonomy } from "../shared/index.js";
import { resolvePathOutcomeCounter } from "../observability/metrics.js";
import type { EntityFetcher } from "./entityFetcher.js";
import { followRelationship, type TraversalContext } from "./relationships.js";

export type ResolveValue = AttributeValue | ResolveValue[];

export interface ResolveError {
  code: string;
  message: string;
}

export interface ResolveResult {
  entity_id: string;
  values: Record<string, ResolveValue>;
  errors: Record<string, ResolveError>;
}

export interface ResolveOptions {
  root: Entity;
  paths: string[];
  taxonomiesById: Map<string, Taxonomy>;
  fetcher: EntityFetcher;
}

type PathOutcome =
  | { kind: "ok"; value: ResolveValue }
  | { kind: "err"; error: ResolveError };

/**
 * Resolve a set of dot-notation paths against an entity. Returns 200-shaped
 * response with disjoint `values` and `errors` maps — never throws for
 * invalid paths; only path-level `errors[path]` is populated.
 *
 * Rules (unchanged from the contract):
 *  - every non-terminal segment must be a relationship key on the current
 *    taxonomy; the terminal segment must be a field key
 *  - a path that traverses only `to_one` relationships yields a scalar or
 *    `null` (no matches → `null`; ambiguous match → `ambiguous_to_one` error)
 *  - a path that traverses any `to_many` or `to_many_through` hop yields an
 *    array of scalars, ordered by related entity `id` asc, `[]` when empty
 *  - archived related entities are treated as missing
 *
 * Internally: each non-terminal hop calls into `followRelationship`, which
 * issues a targeted SQL query against the fetcher instead of scanning an
 * in-memory entity list. The traversal walks only the entities it needs to
 * reach the path's terminal segment.
 */
export async function resolvePaths(
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const ctx: TraversalContext = {
    taxonomiesById: opts.taxonomiesById,
    fetcher: opts.fetcher,
  };

  const values: Record<string, ResolveValue> = {};
  const errors: Record<string, ResolveError> = {};

  for (const path of opts.paths) {
    const outcome = await resolveOnePath(opts.root, path, ctx);
    resolvePathOutcomeCounter.add(1, {
      outcome: outcome.kind === "ok" ? "ok" : outcome.error.code,
    });
    if (outcome.kind === "ok") {
      values[path] = outcome.value;
    } else {
      errors[path] = outcome.error;
    }
  }

  return { entity_id: opts.root.id, values, errors };
}

async function resolveOnePath(
  root: Entity,
  path: string,
  ctx: TraversalContext,
): Promise<PathOutcome> {
  const segments = path.split(".");
  if (segments.some((s) => s.length === 0)) {
    return err("invalid_path", `Path '${path}' contains an empty segment`);
  }

  let current: Entity[] = [root];
  let taxonomy = ctx.taxonomiesById.get(root.taxonomy_id);
  if (!taxonomy) {
    return err(
      "taxonomy_not_found",
      `Taxonomy '${root.taxonomy_id}' not found for entity '${root.id}'`,
    );
  }

  let isArrayResult = false;

  // Walk non-terminal segments: each must be a relationship on the current
  // taxonomy, and each hop may fan out (to_many, to_many_through) or thin
  // out (no active matches).
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const rel = taxonomy.relationships.find((r) => r.key === key);
    if (!rel) {
      const asField = taxonomy.fields.find((f) => f.key === key);
      if (asField) {
        return err(
          "invalid_path",
          `'${key}' is a field on '${taxonomy.id}', not a relationship; non-terminal segments must be relationships`,
        );
      }
      return err(
        "relationship_not_found",
        `Relationship '${key}' does not exist on taxonomy '${taxonomy.id}'`,
      );
    }

    if (rel.cardinality !== "to_one") {
      isArrayResult = true;
    }

    const next: Entity[] = [];
    for (const entity of current) {
      const matches = await followRelationship(entity, rel, ctx);
      next.push(...matches);
    }
    current = dedupeAndSort(next);

    const nextTaxonomy = ctx.taxonomiesById.get(rel.target_taxonomy_id);
    if (!nextTaxonomy) {
      return err(
        "taxonomy_not_found",
        `Taxonomy '${rel.target_taxonomy_id}' referenced by '${taxonomy.id}.${rel.key}' does not exist`,
      );
    }
    taxonomy = nextTaxonomy;
  }

  // Terminal segment must be a field key on the current taxonomy.
  const terminal = segments[segments.length - 1]!;
  const field = taxonomy.fields.find((f) => f.key === terminal);
  if (!field) {
    const asRel = taxonomy.relationships.find((r) => r.key === terminal);
    if (asRel) {
      return err(
        "invalid_path",
        `'${terminal}' is a relationship on '${taxonomy.id}', not a field; the terminal segment must be a field`,
      );
    }
    return err(
      "field_not_found",
      `Field '${terminal}' does not exist on taxonomy '${taxonomy.id}'`,
    );
  }

  // Collect terminal field values. Missing keys in `attributes` → null.
  const rawValues = current.map((e) =>
    terminal in e.attributes ? e.attributes[terminal] : null,
  ) as AttributeValue[];

  if (isArrayResult) {
    return { kind: "ok", value: rawValues };
  }

  if (current.length === 0) {
    // Pure to_one chain with a broken link somewhere — scalar null.
    return { kind: "ok", value: null };
  }
  if (current.length > 1) {
    return err(
      "ambiguous_to_one",
      `Path '${segments.slice(0, -1).join(".")}' matched ${current.length} entities through to_one relationships; expected at most one`,
    );
  }
  return { kind: "ok", value: rawValues[0] ?? null };
}

function err(code: string, message: string): PathOutcome {
  return { kind: "err", error: { code, message } };
}

function dedupeAndSort(entities: Entity[]): Entity[] {
  const byId = new Map<string, Entity>();
  for (const e of entities) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}
