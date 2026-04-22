/**
 * Drizzle migration runner.
 *
 * Called from `src/index.ts` at boot BEFORE the fixture loader runs — any
 * schema changes have to land first or the seed will fail against a stale
 * structure. Migrations are generated with `npm run db:generate`; do not
 * hand-edit the SQL files under `drizzle/`.
 */

import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type Database } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Apply any pending migrations against `db`. Idempotent — Drizzle tracks
 *  applied migrations in the `__drizzle_migrations` table. */
export async function runMigrations(db: Database): Promise<void> {
  const migrationsFolder = path.resolve(__dirname, "../../drizzle");
  await migrate(db, { migrationsFolder });
}

// Self-execute when invoked directly via `npm run db:migrate` (tsx resolves
// this module as main). The service's boot path imports `runMigrations`
// and doesn't re-trigger this block — import.meta.url guards against
// double-application.
if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://aviary:aviary@localhost:5432/aviary";
  const { db, close } = createDb(databaseUrl);
  runMigrations(db)
    .then(async () => {
      console.log("[migrate] applied pending migrations");
      await close();
    })
    .catch(async (err) => {
      console.error("[migrate] failed:", err);
      await close();
      process.exit(1);
    });
}
