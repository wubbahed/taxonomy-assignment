import { validationError } from "../errors.js";

/**
 * Parse a query-string boolean. Fastify delivers query values as strings,
 * but tests that call `app.inject` may pass real booleans — accept both.
 * An absent / empty value falls back to `fallback`; anything else throws
 * a 400 so clients get a clear message instead of silent coercion.
 */
export function parseBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  throw validationError(`Expected boolean, got '${String(value)}'`);
}
