import type { Taxonomy, AttributeValue } from "../shared/index.js";
import { validationError } from "../errors.js";
import { checkValueType } from "./valueTypes.js";

/**
 * Normalize every string attribute value to Unicode NFC in place.
 *
 * The same visible character can have multiple byte representations in
 * Unicode (e.g. `é` is U+00E9 as NFC or `e` + U+0301 as NFD). Postgres
 * text equality is byte-level, so an NFC-encoded `"café"` stored on one
 * write will fail to match an NFD-encoded `"café"` on the next —
 * silently breaking relationship matches that key off string values.
 *
 * Running every incoming attribute value through `.normalize("NFC")` at
 * the write boundary gives us a single canonical form in the DB. Queries
 * from clients that happen to emit NFD still match because both sides
 * normalize: we normalize on write, and the probe-builder for traversal
 * reads already-normalized values out of the DB.
 *
 * Non-string values pass through untouched.
 */
export function normalizeAttributes(
  attributes: Record<string, AttributeValue>,
): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string") {
      attributes[key] = value.normalize("NFC");
    }
  }
}

export interface AttributeValidationOptions {
  /** When true, every required field on the taxonomy must be present. Use on create. */
  requireAll: boolean;
}

/**
 * Validate an entity's attributes against its taxonomy.
 * Throws a 400 AppError with a per-field `details` map when anything is wrong.
 *
 * Enforced rules:
 *  - no unknown attribute keys
 *  - every value shape matches the declared field type (scalar only, no objects/arrays)
 *  - all required fields are present when `requireAll` is true
 *  - required fields may not be set to `null`
 */
export function validateAttributes(
  taxonomy: Taxonomy,
  attributes: Record<string, AttributeValue>,
  opts: AttributeValidationOptions,
): void {
  const issues: Record<string, string> = {};
  const fieldByKey = new Map(taxonomy.fields.map((f) => [f.key, f]));

  for (const [key, value] of Object.entries(attributes)) {
    const field = fieldByKey.get(key);
    if (!field) {
      issues[key] =
        `Field '${key}' does not exist on taxonomy '${taxonomy.id}'`;
      continue;
    }
    if (value === null && field.required) {
      issues[key] = `Field '${key}' is required and may not be null`;
      continue;
    }
    const check = checkValueType(field.type, value);
    if (!check.ok) {
      issues[key] = check.message ?? "invalid value";
    }
  }

  if (opts.requireAll) {
    for (const field of taxonomy.fields) {
      if (!field.required) continue;
      if (!(field.key in attributes)) {
        issues[field.key] = `Required field '${field.key}' is missing`;
        continue;
      }
      if (attributes[field.key] === null) {
        issues[field.key] =
          `Field '${field.key}' is required and may not be null`;
      }
    }
  }

  if (Object.keys(issues).length > 0) {
    throw validationError(`Invalid attributes for taxonomy '${taxonomy.id}'`, {
      taxonomy_id: taxonomy.id,
      fields: issues,
    });
  }
}
