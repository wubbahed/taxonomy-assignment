/**
 * Expression-index reconciler for `entities.attributes`.
 *
 * Match clauses on relationships almost always land on a target
 * taxonomy's `is_key: true` field. Those are the values traversal
 * queries probe — `WHERE attributes->>'<key>' = $val` (single-field
 * match) or `WHERE attributes @> '{"<key>":"<val>"}'` (multi-field).
 * The `@>` form already rides the GIN index on `attributes`, but a
 * B-tree expression index on `(attributes->>'<key>')` is materially
 * faster for single-key equality at scale.
 *
 * This module keeps the set of expression indexes in sync with the
 * set of `is_key` fields declared across all taxonomies. Called at
 * boot (after migrations, before fixture load) and fire-and-forget
 * after any taxonomy mutation that might change the is_key set.
 *
 * Indexes are named `entities_attr_<safe_key>_idx`; Postgres identifiers
 * are capped at 63 bytes, so long keys are hashed-and-truncated to stay
 * within the limit while remaining unique.
 */

import { sql } from "drizzle-orm";
import crypto from "node:crypto";
import type { Database } from "../db/client.js";
import type { Taxonomy } from "../shared/index.js";

const INDEX_NAME_PREFIX = "entities_attr_";
const INDEX_NAME_SUFFIX = "_idx";
const MAX_IDENTIFIER_BYTES = 63;

export interface ReconcileOptions {
  /** If true, use `CREATE INDEX CONCURRENTLY` so the entities table isn't
   *  write-blocked during index creation. Must be false during boot — the
   *  migration runner's transaction forbids CONCURRENT DDL. */
  concurrent?: boolean;
}

export interface ReconcileResult {
  created: string[];
  dropped: string[];
}

/**
 * Reconcile expression indexes against the set of `is_key` fields in the
 * current taxonomy schema. Idempotent. Returns the names of indexes it
 * created and dropped so callers can log the delta.
 */
export async function reconcileEntityAttributeIndexes(
  db: Database,
  taxonomies: Taxonomy[],
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const desiredByIndex = new Map<string, string>(); // indexName → fieldKey
  for (const t of taxonomies) {
    for (const field of t.fields) {
      if (!field.is_key) continue;
      desiredByIndex.set(indexNameFor(field.key), field.key);
    }
  }

  const existingIndexes = await listManagedIndexes(db);

  const created: string[] = [];
  const dropped: string[] = [];
  const concurrent = opts.concurrent ?? false;

  for (const [name, fieldKey] of desiredByIndex) {
    if (existingIndexes.has(name)) continue;
    await createIndex(db, name, fieldKey, concurrent);
    created.push(name);
  }
  for (const name of existingIndexes) {
    if (desiredByIndex.has(name)) continue;
    await dropIndex(db, name, concurrent);
    dropped.push(name);
  }

  return { created, dropped };
}

/**
 * Postgres-safe identifier for a given field key. Plain keys use the raw
 * key; non-alphanumeric content and long keys fall back to a hash suffix
 * so collisions and identifier-length violations are impossible.
 */
export function indexNameFor(fieldKey: string): string {
  const sanitized = fieldKey.replace(/[^a-zA-Z0-9]/g, "_");
  const candidate = `${INDEX_NAME_PREFIX}${sanitized}${INDEX_NAME_SUFFIX}`;
  if (sanitized === fieldKey && candidate.length <= MAX_IDENTIFIER_BYTES) {
    return candidate;
  }
  // Hash-suffix form: truncate the sanitized part, append 8 hex chars of
  // a stable hash of the original key.
  const hash = crypto
    .createHash("sha1")
    .update(fieldKey)
    .digest("hex")
    .slice(0, 8);
  const budget =
    MAX_IDENTIFIER_BYTES -
    INDEX_NAME_PREFIX.length -
    INDEX_NAME_SUFFIX.length -
    1 -
    hash.length;
  const truncated = sanitized.slice(0, Math.max(0, budget));
  return `${INDEX_NAME_PREFIX}${truncated}_${hash}${INDEX_NAME_SUFFIX}`;
}

async function listManagedIndexes(db: Database): Promise<Set<string>> {
  const rows = await db.execute<{ indexname: string }>(sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'entities'
      AND indexname LIKE ${`${INDEX_NAME_PREFIX}%${INDEX_NAME_SUFFIX}`}
  `);
  return new Set(rows.rows.map((r) => r.indexname));
}

async function createIndex(
  db: Database,
  name: string,
  fieldKey: string,
  concurrent: boolean,
): Promise<void> {
  // Postgres DDL does not permit bound parameters inside the index
  // expression, so we embed `fieldKey` as a quoted string literal with
  // single-quote escaping. `indexNameFor` already guarantees `name` is
  // identifier-safe; we double-quote it defensively anyway.
  const concurrently = concurrent ? "CONCURRENTLY " : "";
  const literal = `'${fieldKey.replace(/'/g, "''")}'`;
  const quotedName = `"${name.replace(/"/g, '""')}"`;
  await db.execute(
    sql.raw(
      `CREATE INDEX ${concurrently}IF NOT EXISTS ${quotedName} ON entities ((attributes->>${literal}))`,
    ),
  );
}

async function dropIndex(
  db: Database,
  name: string,
  concurrent: boolean,
): Promise<void> {
  const concurrently = concurrent ? "CONCURRENTLY " : "";
  const quotedName = `"${name.replace(/"/g, '""')}"`;
  await db.execute(
    sql.raw(`DROP INDEX ${concurrently}IF EXISTS ${quotedName}`),
  );
}
