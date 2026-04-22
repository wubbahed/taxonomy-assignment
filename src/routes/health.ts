import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { unavailable } from "../errors.js";

interface Deps {
  db: Database;
}

/**
 * - `/healthz`: liveness. Returns `{ok: true}` regardless of DB state.
 * - `/readyz`: readiness. Pings the DB with `SELECT 1`; returns 503 if the
 *   DB is down so load balancers can stop routing traffic without killing
 *   the pod (which liveness would do).
 */
export function healthRoutes(deps: Deps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/healthz", async () => ({ ok: true }));

    app.get("/readyz", async () => {
      try {
        await deps.db.execute(sql`SELECT 1`);
        return { ok: true, db: "ok" };
      } catch (err) {
        app.log.error({ err }, "readiness check failed");
        throw unavailable("database is not reachable");
      }
    });
  };
}
