/**
 * Data access for the `taxonomies` table. Thin wrapper over Drizzle —
 * no business logic lives here. Route handlers and the fixture loader
 * call these methods; validation and contract concerns (ordering,
 * archived filtering, 409 conditions) belong to the layers above.
 */

import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Taxonomy } from "../shared/index.js";
import type { Database } from "../db/client.js";
import { taxonomies } from "../db/schema.js";

/** Drop the internal `updated_at` column; it's never exposed on the API. */
function rowToTaxonomy(row: typeof taxonomies.$inferSelect): Taxonomy {
  return {
    id: row.id,
    name: row.name,
    archived: row.archived,
    fields: row.fields,
    relationships: row.relationships,
  };
}

export class TaxonomyRepo {
  constructor(private readonly db: Database) {}

  /**
   * List all taxonomies in ascending `id` order (per contract
   * `§ General Rules`). When `includeArchived` is false (the route
   * default for `GET /taxonomies`), archived rows are dropped. Pass
   * `true` when you need the complete set — e.g., reference-integrity
   * validation at taxonomy create/update time.
   */
  async list(includeArchived: boolean): Promise<Taxonomy[]> {
    const rows = await this.db
      .select()
      .from(taxonomies)
      .where(includeArchived ? undefined : eq(taxonomies.archived, false))
      .orderBy(asc(taxonomies.id));
    return rows.map(rowToTaxonomy);
  }

  /**
   * Fetch a targeted subset by id. Used by validation paths that only
   * need the taxonomies a new/patched taxonomy references, not the full
   * table — turns an `O(T)` scan into an indexed `IN (...)` lookup on
   * the primary key. Does not filter archived; the caller decides.
   */
  async listByIds(ids: string[]): Promise<Taxonomy[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(taxonomies)
      .where(inArray(taxonomies.id, ids))
      .orderBy(asc(taxonomies.id));
    return rows.map(rowToTaxonomy);
  }

  /** Single lookup by id. Does NOT filter archived — an explicit GET
   *  still returns an archived taxonomy (contract: archived flags
   *  gate traversal, not direct lookup). */
  async get(id: string): Promise<Taxonomy | null> {
    const rows = await this.db
      .select()
      .from(taxonomies)
      .where(eq(taxonomies.id, id));
    const row = rows[0];
    return row ? rowToTaxonomy(row) : null;
  }

  /**
   * Insert-or-replace by `id`. Idempotent: the fixture loader relies on
   * this for safe re-seeding on every boot. On conflict, every mutable
   * column is overwritten including `fields` and `relationships`, so
   * higher layers must have already validated the merged shape.
   */
  async upsert(taxonomy: Taxonomy): Promise<Taxonomy> {
    const [row] = await this.db
      .insert(taxonomies)
      .values({
        id: taxonomy.id,
        name: taxonomy.name,
        archived: taxonomy.archived,
        fields: taxonomy.fields,
        relationships: taxonomy.relationships,
      })
      .onConflictDoUpdate({
        target: taxonomies.id,
        set: {
          name: taxonomy.name,
          archived: taxonomy.archived,
          fields: taxonomy.fields,
          relationships: taxonomy.relationships,
          updatedAt: new Date(),
        },
      })
      .returning();
    return rowToTaxonomy(row!);
  }

  /** Hard delete. The repo does NOT check for dependents — that's the
   *  route handler's job (entities exist → 409, inbound relationships
   *  from other taxonomies → 409). The DB-level FK would also abort
   *  the delete if entities reference it, as a safety net. */
  async delete(id: string): Promise<void> {
    await this.db.delete(taxonomies).where(eq(taxonomies.id, id));
  }

  /**
   * Return the first `{taxonomyId, relKey}` pair whose relationships
   * point at `id`, or `null` if nothing references it. Used by
   * `DELETE /taxonomies/:id` to emit a friendly 409.
   *
   * Uses JSONB `@>` containment on the `relationships` column, which the
   * `taxonomies_relationships_gin_idx` (jsonb_path_ops GIN) index
   * accelerates — Postgres narrows candidates to rows that actually
   * contain a matching relationship before expanding `jsonb_array_elements`
   * to extract the specific `rel_key`. At 100k taxonomies this turns a
   * full sequential scan into a handful of index hits.
   */
  async referencedBy(
    id: string,
  ): Promise<{ taxonomyId: string; relKey: string } | null> {
    const probe = JSON.stringify([{ target_taxonomy_id: id }]);
    const result = await this.db.execute<{
      taxonomy_id: string;
      rel_key: string;
    }>(sql`
      SELECT t.id AS taxonomy_id, rel->>'key' AS rel_key
      FROM taxonomies t, jsonb_array_elements(t.relationships) rel
      WHERE t.id <> ${id}
        AND t.relationships @> ${probe}::jsonb
        AND rel->>'target_taxonomy_id' = ${id}
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) return null;
    return { taxonomyId: row.taxonomy_id, relKey: row.rel_key };
  }

  /**
   * Bulk upsert. Single multi-row `INSERT ... ON CONFLICT DO UPDATE`
   * using `EXCLUDED.*` so all rows share one round-trip to Postgres.
   * Used by the fixture loader; dropping N sequential INSERTs to one
   * statement shrinks boot time linearly with fixture size.
   */
  async upsertMany(list: Taxonomy[]): Promise<void> {
    if (list.length === 0) return;
    await this.db
      .insert(taxonomies)
      .values(
        list.map((t) => ({
          id: t.id,
          name: t.name,
          archived: t.archived,
          fields: t.fields,
          relationships: t.relationships,
        })),
      )
      .onConflictDoUpdate({
        target: taxonomies.id,
        set: {
          name: sql`excluded.name`,
          archived: sql`excluded.archived`,
          fields: sql`excluded.fields`,
          relationships: sql`excluded.relationships`,
          updatedAt: new Date(),
        },
      });
  }
}
