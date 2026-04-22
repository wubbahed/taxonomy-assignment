/**
 * Postgres connection factory. Wraps a `pg.Pool` in a Drizzle client and
 * returns both plus a `close()` that drains the pool — used by
 * `src/index.ts` during graceful shutdown.
 */

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

/** Drizzle client typed against the schema in `./schema`. */
export type Database = NodePgDatabase<typeof schema>;

/** The pair of things boot needs: the Drizzle client to pass into repos,
 *  and the pool plus a drain function for shutdown. */
export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/**
 * Build a Drizzle client backed by a fresh pg Pool. Call once at boot;
 * pass `db` into repos and services, and call `close()` during shutdown
 * to drain in-flight connections cleanly.
 */
export function createDb(databaseUrl: string): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}
