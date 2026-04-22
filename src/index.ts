/**
 * Service entrypoint.
 *
 * Boot sequence, in order:
 *   1. `loadEnv()`                  — parse + validate process.env; fail
 *                                     hard on any missing var
 *   2. `createDb(DATABASE_URL)`     — open the pg pool + Drizzle client
 *   3. `runMigrations(db)`          — apply pending schema migrations
 *                                     BEFORE the fixture loader so it
 *                                     never runs against a stale table
 *   4. `loadFixtures({db, dir})`    — parse + fully-validate fixture
 *                                     files, upsert into DB; missing
 *                                     FIXTURE_DIR is logged and skipped
 *   5. `buildServer()`              — assemble Fastify: logger,
 *                                     request-ids, error handler, routes
 *   6. `SIGINT`/`SIGTERM` handlers  — close Fastify, drain pg pool,
 *                                     exit 0
 *   7. `app.listen()`               — bind the port; on failure, drain
 *                                     the pool before exit(1)
 *
 * Shutdown logs use `app.log` (structured pino) so operators get one
 * correlated trace per SIGTERM. The outer `.catch` is a last-resort
 * console log for pre-boot failures that happen before `app.log` exists.
 */

// Must be first: the OTel SDK self-starts at module load (guarded by
// NODE_ENV !== "test") so auto-instrumentation can patch fastify/pg/http
// before they're required by sibling imports below.
import { stopTelemetry } from "./observability/tracing.js";

import { loadEnv } from "./env.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadFixtures } from "./fixtures/loader.js";
import { buildServer } from "./server.js";
import { TaxonomyRepo } from "./repositories/taxonomyRepo.js";
import { reconcileEntityAttributeIndexes } from "./services/indexManager.js";

/**
 * Orchestrate the boot sequence above. Not exported — the module's
 * side-effectful import-and-run tail is the intended entrypoint.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);

  await runMigrations(db);
  await loadFixtures({ db, fixtureDir: env.FIXTURE_DIR });

  // Sync expression indexes on entity attribute `is_key` fields with the
  // current taxonomy schema. Non-concurrent at boot (transactional DDL
  // context forbids CONCURRENTLY). Runs after fixtures so any newly
  // seeded taxonomies' is_key fields are indexed before the first request.
  const taxonomyRepo = new TaxonomyRepo(db);
  const { created, dropped } = await reconcileEntityAttributeIndexes(
    db,
    await taxonomyRepo.list(true),
    { concurrent: false },
  );
  if (created.length > 0 || dropped.length > 0) {
    console.log(
      `[indexManager] reconciled expression indexes: +${created.length} / -${dropped.length}`,
    );
  }

  const app = buildServer({ db, nodeEnv: env.NODE_ENV });

  // Signal-handler shutdown: drain in-flight requests, close the pool,
  // then exit cleanly. Docker / k8s send SIGTERM; local Ctrl-C is SIGINT.
  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await close();
    await stopTelemetry();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    await close();
    process.exit(1);
  }
}

main().catch((err) => {
  // Fallback path when `main` rejects before `app.log` is available
  // (invalid env, migration failure, etc.). Bare console.error is
  // intentional — there's no logger yet.
  console.error("fatal:", err);
  process.exit(1);
});
