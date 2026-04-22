import type { Taxonomy, TaxonomyField } from "../shared/index.js";
import { AppError, conflict } from "../errors.js";
import type { EntityRepo } from "../repositories/entityRepo.js";
import { validateAttributes } from "../validation/entity.js";

/** Per-category cap on how many breaking entities we report. Pathological
 *  patches against enormous taxonomies fail fast with a representative
 *  sample rather than scanning indefinitely. */
const MAX_BREAKAGES_PER_CATEGORY = 100;

interface FieldDiff {
  /** Fields in new but not old, non-required. Always compatible. */
  addedOptional: TaxonomyField[];
  /** Fields in new but not old, required. Every entity must have this
   *  key set with a valid non-null value. */
  addedRequired: TaxonomyField[];
  /** Fields in old but not new. Entities still carrying these break. */
  removed: TaxonomyField[];
  /** Field existed, type changed. Existing values must validate against
   *  the new type. */
  typeChanged: { prev: TaxonomyField; next: TaxonomyField }[];
  /** Field existed, required went false → true. Existing entities must
   *  have a non-null value. Type is unchanged so values themselves don't
   *  need re-validation. */
  tightenedRequired: TaxonomyField[];
}

function diffFields(
  oldFields: TaxonomyField[],
  newFields: TaxonomyField[],
): FieldDiff {
  const oldByKey = new Map(oldFields.map((f) => [f.key, f]));
  const newByKey = new Map(newFields.map((f) => [f.key, f]));

  const diff: FieldDiff = {
    addedOptional: [],
    addedRequired: [],
    removed: [],
    typeChanged: [],
    tightenedRequired: [],
  };

  for (const nf of newFields) {
    const prev = oldByKey.get(nf.key);
    if (!prev) {
      (nf.required ? diff.addedRequired : diff.addedOptional).push(nf);
      continue;
    }
    if (prev.type !== nf.type) {
      diff.typeChanged.push({ prev, next: nf });
    }
    if (!prev.required && nf.required) {
      diff.tightenedRequired.push(nf);
    }
  }
  for (const prev of oldFields) {
    if (!newByKey.has(prev.key)) {
      diff.removed.push(prev);
    }
  }
  return diff;
}

function isTriviallyCompatible(diff: FieldDiff): boolean {
  return (
    diff.addedRequired.length === 0 &&
    diff.removed.length === 0 &&
    diff.typeChanged.length === 0 &&
    diff.tightenedRequired.length === 0
  );
}

type BreakageMap = Record<string, Record<string, string>>;

function recordBreakage(
  breakages: BreakageMap,
  entityId: string,
  fieldKey: string,
  message: string,
): void {
  const entry = breakages[entityId] ?? {};
  entry[fieldKey] = message;
  breakages[entityId] = entry;
}

/**
 * Schema-evolution guard for PATCH /taxonomies/:id when `fields` changed.
 *
 * Fast path: a strictly additive change (only new optional fields; no
 * removals, no type changes, no required-tightening) is always compatible
 * with existing entities — no DB work at all.
 *
 * Slow path: for each category of risky change, issue an indexed SQL
 * query (LIMIT-capped) to surface the specific breaking entities:
 *  - removed fields → entities that still carry the key
 *  - added-required / tightened-required → entities missing the key or
 *    with JSON null
 *  - type changes → entities with the key set, values re-validated in
 *    JS against the new type (one query covers all type-changed keys)
 *
 * Previously this function loaded every entity (archived included) into
 * memory and iterated — quadratic behavior on big taxonomies. Now the
 * worst-case bound is `MAX_BREAKAGES_PER_CATEGORY` rows per offending
 * field, regardless of taxonomy size.
 */
export async function assertFieldChangeIsCompatible(
  oldFields: TaxonomyField[],
  merged: Taxonomy,
  entityRepo: EntityRepo,
): Promise<void> {
  const diff = diffFields(oldFields, merged.fields);
  if (isTriviallyCompatible(diff)) return;

  const breakages: BreakageMap = {};

  // Removed fields: anyone still carrying the key is broken.
  for (const removed of diff.removed) {
    const rows = await entityRepo.entitiesWithAttributeKey(
      merged.id,
      removed.key,
      MAX_BREAKAGES_PER_CATEGORY,
    );
    for (const row of rows) {
      recordBreakage(
        breakages,
        row.id,
        removed.key,
        `Field '${removed.key}' does not exist on taxonomy '${merged.id}'`,
      );
    }
  }

  // Required fields (newly-added or tightened): entities missing the
  // key or with JSON null are broken.
  for (const req of [...diff.addedRequired, ...diff.tightenedRequired]) {
    const rows = await entityRepo.entitiesMissingOrNullAttribute(
      merged.id,
      req.key,
      MAX_BREAKAGES_PER_CATEGORY,
    );
    for (const row of rows) {
      recordBreakage(
        breakages,
        row.id,
        req.key,
        `Required field '${req.key}' is missing`,
      );
    }
  }

  // Type changes: fetch entities with any type-changed key set and
  // re-validate values against the merged taxonomy. `validateAttributes`
  // handles the per-type checks (including date format), so we reuse it
  // directly — but now scoped to only the entities that actually have
  // one of the affected keys, and capped at the breakage limit.
  if (diff.typeChanged.length > 0) {
    const changedKeys = diff.typeChanged.map((c) => c.next.key);
    const entities = await entityRepo.entitiesWithAnyAttributeKey(
      merged.id,
      changedKeys,
      // Over-fetch a bit: a single entity might have several changed keys
      // and we want the first K *distinct* breaking entities per field.
      // Cap is still bounded — scales with number of changed fields, not
      // total entities.
      MAX_BREAKAGES_PER_CATEGORY * Math.max(1, diff.typeChanged.length),
    );
    for (const entity of entities) {
      try {
        validateAttributes(merged, entity.attributes, { requireAll: false });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        const fields =
          (err.details as { fields?: Record<string, string> } | undefined)
            ?.fields ?? {};
        for (const [key, message] of Object.entries(fields)) {
          // Only record failures for keys that actually changed type —
          // ignore secondary complaints about unrelated fields.
          if (changedKeys.includes(key)) {
            recordBreakage(breakages, entity.id, key, message);
          }
        }
      }
    }
  }

  const count = Object.keys(breakages).length;
  if (count > 0) {
    throw conflict(
      `Taxonomy change is incompatible with ${count} existing entity(ies)`,
      {
        taxonomy_id: merged.id,
        entities: breakages,
      },
    );
  }
}
