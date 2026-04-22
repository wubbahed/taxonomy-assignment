/**
 * Per-field-type value validation.
 *
 * The contract declares exactly six scalar field types (`§ Data Model`):
 * string, integer, boolean, float, date, datetime. Nothing else is legal.
 * This module is the gate where a runtime value is checked against one
 * declared type — used by both `validateAttributes` (entity create/PATCH)
 * and the fixture loader.
 *
 * The "scalar only" invariant is enforced first via `isScalar` — objects,
 * arrays, and `undefined` all fail before per-type logic runs, which means
 * any nested attribute value (`{ nested: 1 }`, `[1, 2]`) gets a clean
 * "expected scalar X, got Y" message regardless of declared type.
 *
 * `null` is always accepted here; whether `null` is actually legal at the
 * field level (i.e., nullable vs required) is checked by the caller.
 */

import type { FieldType, AttributeValue } from "../shared/index.js";

export interface TypeCheckResult {
  ok: boolean;
  message?: string;
}

/** Strict YYYY-MM-DD. Regex matches shape; `Date.parse` catches semantic
 *  nonsense like `2026-13-01`. Both must pass — the regex alone would
 *  accept impossible dates, and `Date.parse` alone would accept many
 *  looser formats the contract doesn't promise to support. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isScalar(value: unknown): value is AttributeValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  );
}

/**
 * Validate that `value` is a permissible runtime shape for a field
 * declared as `type`. Returns `{ok: false, message}` with a human-
 * readable reason when it isn't — callers aggregate these into a
 * per-field map in the final `validation_error` envelope.
 *
 * Notable strictness choices:
 *  - `integer` rejects non-integer numbers (e.g. 5.1) AND non-finite
 *    numbers (NaN, Infinity). The DB column is JSONB, so there's no
 *    upstream coercion to lean on.
 *  - `float` rejects non-finite numbers for the same reason.
 *  - `boolean` does NOT accept 0/1 — the contract says boolean, not
 *    "truthy". Booleans-as-numbers breed bugs on read.
 *  - `date` requires strict YYYY-MM-DD; `datetime` is ISO-8601-ish via
 *    `Date.parse`. No timezone normalization happens here.
 */
export function checkValueType(
  type: FieldType,
  value: unknown,
): TypeCheckResult {
  if (value === null) return { ok: true };

  if (!isScalar(value)) {
    return {
      ok: false,
      message: `expected scalar ${type}, got ${Array.isArray(value) ? "array" : typeof value}`,
    };
  }

  switch (type) {
    case "string":
      return typeof value === "string"
        ? { ok: true }
        : { ok: false, message: `expected string, got ${typeof value}` };

    case "integer":
      return typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value)
        ? { ok: true }
        : { ok: false, message: `expected integer, got ${describe(value)}` };

    case "float":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true }
        : { ok: false, message: `expected float, got ${describe(value)}` };

    case "boolean":
      return typeof value === "boolean"
        ? { ok: true }
        : { ok: false, message: `expected boolean, got ${typeof value}` };

    case "date":
      return typeof value === "string" &&
        DATE_RE.test(value) &&
        !Number.isNaN(Date.parse(value))
        ? { ok: true }
        : {
            ok: false,
            message: `expected date (YYYY-MM-DD), got ${JSON.stringify(value)}`,
          };

    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? { ok: true }
        : {
            ok: false,
            message: `expected ISO datetime, got ${JSON.stringify(value)}`,
          };
  }
}

/** `typeof NaN === "number"`, so the plain typeof isn't enough when we
 *  want to say "non-finite number" in the error message. */
function describe(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value))
    return "non-finite number";
  return typeof value;
}
