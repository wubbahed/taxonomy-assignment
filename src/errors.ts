/**
 * Error envelope + `AppError` helpers.
 *
 * All non-2xx responses follow the shape defined in `§ Error Envelope` of
 * `assignment/api-contract.md`:
 *
 *     { "error": { "code": string, "message": string, "details"?: object } }
 *
 * Route handlers throw `AppError` (or a `ZodError` via Zod parse) and the
 * Fastify error handler in `src/plugins/errorHandler.ts` serializes them
 * into the envelope. Never `reply.status(...).send({...})` directly for
 * errors — it bypasses the envelope and secret redaction.
 *
 * Error code catalogue
 * --------------------
 * These are the `code` values this service emits. Stable; clients may
 * branch on them. If you add a new code, add it here AND in the README's
 * assumptions section so the set stays discoverable.
 *
 *   validation_error      400  Input failed Zod or per-field validation.
 *                              `details.fields` often carries a per-field
 *                              map when the offender can be localized.
 *   not_found             404  Resource (taxonomy / entity / route) does
 *                              not exist. `details.resource` + `details.id`
 *                              when a resource was named.
 *   conflict              409  Mutation would violate invariants — e.g.
 *                              duplicate id, taxonomy deletion blocked by
 *                              entities or inbound refs, PATCH taxonomy
 *                              incompatible with existing entities, or
 *                              ambiguous to_one during /data traversal.
 *   response_too_large    413  Request is well-formed but would produce a
 *                              response past server limits — emitted when
 *                              the relationship-graph builder blows past
 *                              its node budget on a deep/branching DAG.
 *   not_implemented       501  Feature wired but not yet built. (No
 *                              current endpoint returns this, but the
 *                              helper is retained for stubs.)
 *   internal_error        500  Unhandled throw. The envelope hides stack
 *                              traces; see logs for the actual `err`.
 *   unavailable           503  Dependency (Postgres) unreachable. Emitted
 *                              by `/readyz` only.
 *
 * Path-level codes (returned INSIDE a 200 `/resolve` response, not as an
 * envelope):
 *
 *   field_not_found           Terminal segment names something that isn't
 *                             a field on the current taxonomy.
 *   relationship_not_found    Non-terminal segment names something that
 *                             isn't a relationship.
 *   invalid_path              Segment exists but is the wrong kind (field
 *                             at non-terminal, relationship at terminal,
 *                             or an empty segment from `..`).
 *   ambiguous_to_one          A `to_one` hop matched more than one entity.
 *   taxonomy_not_found        Target taxonomy of a relationship has been
 *                             deleted out from under an entity.
 */

import type { ErrorEnvelope } from "./shared/index.js";

/**
 * Structured error with the contract's three required pieces: a machine-
 * readable `code`, a human-readable `message`, and optional structured
 * `details`. `status` maps to HTTP response code when this error reaches
 * the Fastify error handler.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/** 400 — bad input. Use for Zod-adjacent parse failures, query-param
 *  rejections, and per-field validation errors. Pass `details.fields`
 *  when the issue is field-specific so clients can highlight. */
export const validationError = (
  message: string,
  details?: Record<string, unknown>,
) => new AppError("validation_error", message, 400, details);

/** 404 — named resource missing. Fills in `details.resource` / `details.id`
 *  so clients can tell which identifier was wrong when multiple are
 *  present in the URL. */
export const notFound = (resource: string, id: string) =>
  new AppError("not_found", `${resource} '${id}' not found`, 404, {
    resource,
    id,
  });

/** 409 — mutation conflicts with existing state. Prefer this over 400
 *  when the request itself is well-formed but the current DB state
 *  forbids the operation. */
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError("conflict", message, 409, details);

/** 413 — response would exceed server limits. Used when input is valid
 *  but the produced output would blow past a safety budget (e.g. a
 *  deep/branching relationship graph request). */
export const payloadTooLarge = (
  message: string,
  details?: Record<string, unknown>,
) => new AppError("response_too_large", message, 413, details);

/** 501 — stub retained for future endpoint scaffolding. No current
 *  handler returns this. */
export const notImplemented = (feature: string) =>
  new AppError("not_implemented", `${feature} is not implemented yet`, 501);

/** 503 — a required dependency is unreachable. Emitted by `/readyz` when
 *  the Postgres liveness probe fails so load balancers stop routing. */
export const unavailable = (
  message: string,
  details?: Record<string, unknown>,
) => new AppError("unavailable", message, 503, details);

/** Serialize an `AppError` into the contract envelope. `details` is only
 *  included when present so empty-details responses stay clean. */
export function toEnvelope(err: AppError): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}
