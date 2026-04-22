/**
 * Fastify error handler + not-found handler.
 *
 * Every non-2xx response goes through here, and everything produced here
 * conforms to the contract envelope shape (`{error: {code, message, details?}}`).
 * Route handlers throw; the error handler serializes.
 *
 * Dispatch precedence:
 *   1. `AppError`               — our own — use its code/status/details
 *   2. `ZodError`                — schema parse failure → 400 validation_error
 *   3. `statusCode: 400` thrown — typically from Fastify's JSON body parser
 *      on malformed JSON → rewrap as a 400 validation_error
 *   4. anything else             — log the raw error and return a generic
 *                                  500 internal_error envelope with NO
 *                                  leaked internals
 *
 * Secrets invariant: unhandled errors never expose their stack, cause, or
 * details to the client. Inspect server logs (keyed by `request_id`) for
 * the full trace.
 */

import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError, toEnvelope } from "../errors.js";

function hasStatusCode(err: unknown, status: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode: unknown }).statusCode === status
  );
}

/** Attach the error and not-found handlers. Called once per app from
 *  `buildServer()`. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send(toEnvelope(err));
    }

    if (err instanceof ZodError) {
      return reply.status(400).send(
        toEnvelope(
          new AppError(
            "validation_error",
            "Request body failed validation",
            400,
            {
              issues: err.issues,
            },
          ),
        ),
      );
    }

    // Fastify's built-in JSON parser throws with `statusCode: 400` when
    // the body is malformed; rewrap as a validation_error so the envelope
    // is consistent rather than letting Fastify's default shape through.
    if (hasStatusCode(err, 400)) {
      return reply
        .status(400)
        .send(toEnvelope(new AppError("validation_error", err.message, 400)));
    }

    app.log.error({ err }, "unhandled error");
    return reply
      .status(500)
      .send(
        toEnvelope(
          new AppError("internal_error", "Internal server error", 500),
        ),
      );
  });

  // Unknown route → envelope, not Fastify's default {error, message, statusCode}.
  app.setNotFoundHandler((_req, reply) => {
    return reply
      .status(404)
      .send(toEnvelope(new AppError("not_found", "Route not found", 404)));
  });
}
