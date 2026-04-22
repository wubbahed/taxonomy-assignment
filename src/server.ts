/**
 * Fastify app factory.
 *
 * `buildServer()` returns a configured `FastifyInstance` without calling
 * `listen()` — `src/index.ts` runs it for real; tests import the factory
 * directly and use `app.inject()` so they never bind a port. This is the
 * single assembly point for: logger config, request-id handling, the
 * error-handler plugin, and route registration.
 *
 * Request-id trust chain:
 *   - Inbound `x-request-id` header is honored when present so upstream
 *     traces (e.g. an API gateway) compose end-to-end.
 *   - Otherwise we mint a UUID per request.
 *   - The id is echoed back on the response and surfaced in every log
 *     line as `request_id`, so a single request can be grep'd server-side.
 *
 * Logger precedence: explicit `opts.logger` wins. Otherwise we pick a
 * default based on `nodeEnv` — silent in tests, info-level in prod,
 * debug in dev (overridable via `LOG_LEVEL`). Redact rules strip
 * common secret-bearing headers before logs leave the process.
 */

import crypto from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { Database } from "./db/client.js";
import { registerErrorHandler } from "./plugins/errorHandler.js";
import { docsPlugin } from "./plugins/docs.js";
import { TaxonomyRepo } from "./repositories/taxonomyRepo.js";
import { EntityRepo } from "./repositories/entityRepo.js";
import { healthRoutes } from "./routes/health.js";
import { taxonomyRoutes } from "./routes/taxonomies.js";
import { entityRoutes } from "./routes/entities.js";
import { resolveRoutes } from "./routes/resolve.js";

export interface BuildServerOptions {
  db: Database;
  /** Pass `false` to silence logs (tests). Pass `true` (default) for prod
   *  JSON logs. Pass a Fastify logger config to override. */
  logger?: boolean | NonNullable<FastifyServerOptions["logger"]>;
  /** NODE_ENV. Chooses default log level + pretty-printing when not set. */
  nodeEnv?: "development" | "test" | "production";
  /** Mount OpenAPI/Swagger UI at `/docs` and `/openapi.json`. Defaults to
   *  `true` (the spec is harmless to expose). Pass `false` for hardened
   *  deployments that must not publish their schema. */
  enableDocs?: boolean;
}

// `FastifyServerOptions["logger"]` includes `undefined`, which collides with
// `exactOptionalPropertyTypes: true` when the value is later passed back to
// `Fastify({ logger })`. NonNullable narrows it to exactly what the
// constructor accepts; keep this wrapper if you change the return shape.
function defaultLoggerConfig(
  nodeEnv: "development" | "test" | "production",
): NonNullable<FastifyServerOptions["logger"]> {
  if (nodeEnv === "test") return false;
  const level =
    nodeEnv === "production" ? "info" : (process.env.LOG_LEVEL ?? "debug");
  return {
    level,
    // Redact anything that looks like secrets before emitting to stdout.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-api-key']",
      ],
      censor: "[REDACTED]",
    },
  };
}

/**
 * Assemble the Fastify app: logger → request-id hooks → error handler →
 * route plugins. Does NOT call `listen()` — entrypoint or tests do that.
 */
export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const nodeEnv = opts.nodeEnv ?? "development";
  const logger =
    opts.logger === false
      ? false
      : opts.logger === true || opts.logger === undefined
        ? defaultLoggerConfig(nodeEnv)
        : opts.logger;

  const app = Fastify({
    logger,
    disableRequestLogging: false,
    // Attach a stable request id if the caller didn't provide one. We
    // trust an inbound `x-request-id` header when present so distributed
    // traces compose cleanly.
    genReqId(req) {
      const provided = req.headers["x-request-id"];
      if (typeof provided === "string" && provided.length > 0) return provided;
      return crypto.randomUUID();
    },
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "request_id",
  });

  // Echo the request id back to the caller so clients can correlate a
  // response with their server-side logs.
  app.addHook("onSend", async (req, reply) => {
    if (req.id) reply.header("x-request-id", String(req.id));
  });

  registerErrorHandler(app);

  if (opts.enableDocs ?? true) {
    app.register(docsPlugin);
  }

  const taxonomyRepo = new TaxonomyRepo(opts.db);
  const entityRepo = new EntityRepo(opts.db);

  app.register(healthRoutes({ db: opts.db }));
  app.register(taxonomyRoutes({ db: opts.db, taxonomyRepo, entityRepo }));
  app.register(entityRoutes({ taxonomyRepo, entityRepo }));
  app.register(resolveRoutes({ entityRepo, taxonomyRepo }));

  return app;
}
