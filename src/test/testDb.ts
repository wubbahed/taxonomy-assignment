import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { entities, taxonomies } from "../db/schema.js";

export const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Absolute path to the canonical public fixture set. Tests use app.inject()
// with a fixture-seeded DB, so pointing at the on-disk JSON is the shortest
// path to realistic data. Kept here so a repo layout change is one edit.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_FIXTURES = path.resolve(
  __dirname,
  "../../assignment/fixtures/public",
);

export function requireTestDb(): string {
  if (!DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL (or DATABASE_URL) must be set to run DB-backed tests",
    );
  }
  return DATABASE_URL;
}

export async function setupTestDb(): Promise<DbHandle> {
  const url = requireTestDb();
  const handle = createDb(url);
  await runMigrations(handle.db);
  await handle.db.delete(entities);
  await handle.db.delete(taxonomies);
  return handle;
}

export async function truncateAll(handle: DbHandle): Promise<void> {
  // Order matters — entities FK taxonomies.
  await handle.db.delete(entities);
  await handle.db.delete(taxonomies);
}
