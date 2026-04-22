import type { Taxonomy } from "../shared/index.js";
import { validationError } from "../errors.js";

/**
 * Validate taxonomy structure that doesn't require knowing about other taxonomies:
 *  - field keys are unique
 *  - relationship keys are unique
 *  - `to_one` / `to_many` relationships reference real source fields on this taxonomy
 *  - `to_many_through` relationships have a non-empty `through` chain and those
 *    relationship keys exist on this taxonomy (first hop)
 */
export function validateTaxonomyStructure(taxonomy: Taxonomy): void {
  const issues: Record<string, string> = {};

  const fieldSeen = new Set<string>();
  for (const field of taxonomy.fields) {
    if (fieldSeen.has(field.key)) {
      issues[`fields.${field.key}`] = `Duplicate field key '${field.key}'`;
    }
    fieldSeen.add(field.key);
  }

  const ownFieldKeys = new Set(taxonomy.fields.map((f) => f.key));
  const ownRelKeys = new Set(taxonomy.relationships.map((r) => r.key));

  const relSeen = new Set<string>();
  for (const rel of taxonomy.relationships) {
    if (relSeen.has(rel.key)) {
      issues[`relationships.${rel.key}`] =
        `Duplicate relationship key '${rel.key}'`;
    }
    relSeen.add(rel.key);

    if (rel.cardinality === "to_many_through") {
      if (rel.through.length === 0) {
        issues[`relationships.${rel.key}`] = `'through' must not be empty`;
        continue;
      }
      const firstHop = rel.through[0]!;
      if (!ownRelKeys.has(firstHop)) {
        issues[`relationships.${rel.key}`] =
          `'through' references unknown relationship '${firstHop}' on '${taxonomy.id}'`;
      }
    } else {
      for (const match of rel.match) {
        if (!ownFieldKeys.has(match.source_field)) {
          issues[`relationships.${rel.key}.source_field`] =
            `Field '${match.source_field}' does not exist on '${taxonomy.id}'`;
        }
      }
    }
  }

  if (Object.keys(issues).length > 0) {
    throw validationError(`Invalid taxonomy structure for '${taxonomy.id}'`, {
      taxonomy_id: taxonomy.id,
      issues,
    });
  }
}

/**
 * Internal signal used by `resolveThroughTarget` to surface chain-validation
 * errors. Caught and folded into the shared `issues` map so we can still
 * report one aggregated validation error per taxonomy.
 */
class ChainValidationError extends Error {}

/**
 * Walk a `to_many_through` chain starting at `start.relationships[relKey]`,
 * expanding any intermediate `to_many_through` hops recursively so we can
 * detect cycles. `stack` carries the `"taxonomyId.relKey"` frames we're
 * currently inside — a repeat frame means the chain loops back on itself.
 *
 * Returns the taxonomy the chain resolves to.
 */
function resolveThroughTarget(
  start: Taxonomy,
  relKey: string,
  byId: Map<string, Taxonomy>,
  stack: string[],
): Taxonomy {
  const frame = `${start.id}.${relKey}`;
  if (stack.includes(frame)) {
    throw new ChainValidationError(
      `Circular 'through' chain: ${[...stack, frame].join(" -> ")}`,
    );
  }

  const rel = start.relationships.find((r) => r.key === relKey);
  if (!rel) {
    throw new ChainValidationError(
      `'through' hop '${relKey}' not found on '${start.id}'`,
    );
  }

  if (rel.cardinality !== "to_many_through") {
    const next = byId.get(rel.target_taxonomy_id);
    if (!next) {
      throw new ChainValidationError(
        `'through' hop '${relKey}' targets unknown taxonomy '${rel.target_taxonomy_id}'`,
      );
    }
    return next;
  }

  // to_many_through: expand its own chain recursively with this frame pushed.
  const nextStack = [...stack, frame];
  let cursor: Taxonomy = start;
  for (const innerKey of rel.through) {
    cursor = resolveThroughTarget(cursor, innerKey, byId, nextStack);
  }
  if (cursor.id !== rel.target_taxonomy_id) {
    throw new ChainValidationError(
      `'through' chain ends at '${cursor.id}', expected '${rel.target_taxonomy_id}'`,
    );
  }
  return cursor;
}

/**
 * Validate relationship references that depend on other taxonomies:
 *  - `target_taxonomy_id` points at a real taxonomy
 *  - for direct relationships, each `target_field` exists on the target taxonomy
 *  - for `to_many_through`, each hop resolves, the chain ends at
 *    `target_taxonomy_id`, and the chain is acyclic (no `to_many_through`
 *    directly or transitively references itself)
 */
export function validateTaxonomyReferences(
  taxonomy: Taxonomy,
  byId: Map<string, Taxonomy>,
): void {
  const issues: Record<string, string> = {};

  // Make sure self-references resolve against the taxonomy we're validating
  // (which on PATCH may be a newer version than whatever's in `byId`).
  const augmented = new Map(byId);
  augmented.set(taxonomy.id, taxonomy);

  // Memoize target-field Sets by taxonomy id. A single taxonomy with
  // multiple relationships to the same target (or two relationships with
  // overlapping match targets) would otherwise rebuild the same Set N
  // times; pure waste on hub taxonomies.
  const targetFieldsByTaxonomy = new Map<string, Set<string>>();
  const fieldsFor = (target: Taxonomy): Set<string> => {
    const cached = targetFieldsByTaxonomy.get(target.id);
    if (cached) return cached;
    const fresh = new Set(target.fields.map((f) => f.key));
    targetFieldsByTaxonomy.set(target.id, fresh);
    return fresh;
  };

  for (const rel of taxonomy.relationships) {
    if (rel.cardinality === "to_many_through") {
      try {
        resolveThroughTarget(taxonomy, rel.key, augmented, []);
      } catch (err) {
        if (err instanceof ChainValidationError) {
          issues[`relationships.${rel.key}`] = err.message;
          continue;
        }
        throw err;
      }
    } else {
      const target = augmented.get(rel.target_taxonomy_id);
      if (!target) {
        issues[`relationships.${rel.key}`] =
          `Target taxonomy '${rel.target_taxonomy_id}' does not exist`;
        continue;
      }
      const targetFieldKeys = fieldsFor(target);
      for (const match of rel.match) {
        if (!targetFieldKeys.has(match.target_field)) {
          issues[`relationships.${rel.key}.target_field`] =
            `Field '${match.target_field}' does not exist on '${target.id}'`;
        }
      }
    }
  }

  if (Object.keys(issues).length > 0) {
    throw validationError(`Invalid taxonomy references for '${taxonomy.id}'`, {
      taxonomy_id: taxonomy.id,
      issues,
    });
  }
}

/**
 * Collect only the taxonomies a given root actually references — the
 * targeted input for `validateTaxonomyReferences`. Fetches via a caller-
 * supplied batch lookup (typically `TaxonomyRepo.listByIds`), so the
 * route layer avoids pulling the entire taxonomies table on every
 * POST/PATCH.
 *
 * Semantics:
 *  - Direct relationships need the target's **fields** → fetch direct
 *    targets (one batch query).
 *  - `to_many_through` chains walk across multiple taxonomies' own
 *    relationships → BFS from direct targets until the closure is
 *    reached. In practice one or two extra hops.
 *  - `iterationCap` is a safety bound on the BFS (10 is well past any
 *    sane through-chain depth).
 *
 * The returned map always contains `root` under its own id so
 * self-references resolve against the version being validated.
 */
export async function collectValidationDeps(
  root: Taxonomy,
  fetcher: (ids: string[]) => Promise<Taxonomy[]>,
  iterationCap = 10,
): Promise<Map<string, Taxonomy>> {
  const known = new Map<string, Taxonomy>([[root.id, root]]);

  const directDeps = [
    ...new Set(
      root.relationships
        .map((r) => r.target_taxonomy_id)
        .filter((id) => id !== root.id),
    ),
  ];
  if (directDeps.length === 0) return known;

  const firstBatch = await fetcher(directDeps);
  for (const t of firstBatch) known.set(t.id, t);

  // If the root has no `to_many_through`, one batch is all chain-walking
  // needs — direct validation only consults target `fields`.
  const hasThrough = root.relationships.some(
    (r) => r.cardinality === "to_many_through",
  );
  if (!hasThrough) return known;

  // Chain walking may need intermediate taxonomies' own relationships.
  // Expand BFS-style, bounded.
  let frontier = new Set<string>();
  for (const t of firstBatch) {
    for (const rel of t.relationships) {
      if (!known.has(rel.target_taxonomy_id)) {
        frontier.add(rel.target_taxonomy_id);
      }
    }
  }

  for (let i = 0; i < iterationCap && frontier.size > 0; i++) {
    const toFetch = [...frontier];
    frontier = new Set();
    const batch = await fetcher(toFetch);
    for (const t of batch) {
      known.set(t.id, t);
      for (const rel of t.relationships) {
        if (!known.has(rel.target_taxonomy_id)) {
          frontier.add(rel.target_taxonomy_id);
        }
      }
    }
  }
  return known;
}
