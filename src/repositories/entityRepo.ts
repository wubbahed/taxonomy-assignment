/**
 * Data access for the `entities` table. Thin wrapper over Drizzle —
 * contract concerns (ordering, archived filtering, validation) are
 * handled by the layers above.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AttributeValue, Entity } from "../shared/index.js";
import type { Database } from "../db/client.js";
import { entities } from "../db/schema.js";

/** Drop the internal `updated_at` column; never exposed on the API. */
function rowToEntity(row: typeof entities.$inferSelect): Entity {
  return {
    id: row.id,
    taxonomy_id: row.taxonomyId,
    archived: row.archived,
    attributes: row.attributes,
  };
}

export class EntityRepo {
  constructor(private readonly db: Database) {}



  /**
   * Return entities for a single taxonomy in ascending `id` order (per
   * contract `§ General Rules`). Drops archived rows unless
   * `includeArchived` is true — the default behavior for
   * `GET /entities?taxonomy_id=...`.
   */
  async listByTaxonomy(
    taxonomyId: string,
    includeArchived: boolean,
  ): Promise<Entity[]> {
    const whereClause = includeArchived
      ? eq(entities.taxonomyId, taxonomyId)
      : and(eq(entities.taxonomyId, taxonomyId), eq(entities.archived, false));
    const rows = await this.db
      .select()
      .from(entities)
      .where(whereClause)
      .orderBy(asc(entities.id));
    return rows.map(rowToEntity);
  }

  /** Single lookup by id. Does not filter archived — explicit lookups
   *  still return archived entities (contract: archived rules gate
   *  traversal, not direct access). */
  async get(id: string): Promise<Entity | null> {
    const rows = await this.db
      .select()
      .from(entities)
      .where(eq(entities.id, id));
    const row = rows[0];
    return row ? rowToEntity(row) : null;
  }

  /**
   * Insert-or-replace by `id`. On conflict, `archived` + `attributes`
   * are overwritten but NOT `taxonomy_id` — the contract says
   * `taxonomy_id` is immutable after creation, and restricting the
   * conflict-update columns is the belt-and-suspenders enforcement.
   * (The route layer enforces it first via `patchEntitySchema.strict()`.)
   */
  async upsert(entity: Entity): Promise<Entity> {
    const [row] = await this.db
      .insert(entities)
      .values({
        id: entity.id,
        taxonomyId: entity.taxonomy_id,
        archived: entity.archived,
        attributes: entity.attributes,
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          archived: entity.archived,
          attributes: entity.attributes,
          updatedAt: new Date(),
        },
      })
      .returning();
    return rowToEntity(row!);
  }

  /** Hard delete per contract `§ DELETE /entities/:id` ("hard delete is
   *  acceptable"). For soft-delete, set `archived: true`. */
  async delete(id: string): Promise<void> {
    await this.db.delete(entities).where(eq(entities.id, id));
  }

  /**
   * Targeted lookup by a list of ids, used by the resolve fetcher's
   * per-request cache. `IN (...)` over the PK index is O(log E) per id.
   */
  async listByIds(ids: string[]): Promise<Entity[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(entities)
      .where(inArray(entities.id, ids))
      .orderBy(asc(entities.id));
    return rows.map(rowToEntity);
  }

  /**
   * Batch fetch for the BFS traversal fetcher. Finds entities in a
   * single `taxonomyId` whose `attributes` contain ANY of the given
   * probe objects. A probe matches when every key from the probe is
   * present on the entity with the exact same scalar value — i.e.,
   * JSONB `@>` containment. Probes OR together; fields within a probe
   * AND together.
   *
   * `@>` is accelerated by `entities_attributes_gin_idx`; Postgres uses
   * BitmapOr across the per-probe index probes when multiple are
   * supplied, so a batched call is materially cheaper than N single-
   * probe calls. The per-(taxonomy, is_key field) expression indexes
   * installed by `indexManager` give additional speedup for the common
   * single-field-match case — though the containment query still falls
   * back to GIN when an expression index isn't present.
   *
   * Archived rows are excluded by default: traversal contract says
   * "archived related entities are treated as missing". `opts.limit`
   * caps result size (default 10_000) so a badly-shaped probe can't
   * drain the heap.
   */
  async findByAttributeProbes(
    taxonomyId: string,
    probes: Record<string, AttributeValue>[],
    opts: { includeArchived?: boolean; limit?: number } = {},
  ): Promise<Entity[]> {
    if (probes.length === 0) return [];
    const limit = opts.limit ?? 10_000;
    const includeArchived = opts.includeArchived ?? false;

    const probeConditions = sql.join(
      probes.map((p) => sql`attributes @> ${JSON.stringify(p)}::jsonb`),
      sql` OR `,
    );
    const archivedFilter = includeArchived ? sql`` : sql`AND archived = false`;

    const result = await this.db.execute<{
      id: string;
      taxonomy_id: string;
      archived: boolean;
      attributes: Record<string, AttributeValue>;
    }>(sql`
      SELECT id, taxonomy_id, archived, attributes
      FROM entities
      WHERE taxonomy_id = ${taxonomyId}
        ${archivedFilter}
        AND (${probeConditions})
      ORDER BY id ASC
      LIMIT ${limit}
    `);

    return result.rows.map((r) => ({
      id: r.id,
      taxonomy_id: r.taxonomy_id,
      archived: r.archived,
      attributes: r.attributes,
    }));
  }

  /** Cheap existence probe. Used by the `DELETE /taxonomies/:id` route
   *  to fail fast with a 409 when any entity still belongs to the
   *  taxonomy — without loading every row. */
  async anyForTaxonomy(taxonomyId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.taxonomyId, taxonomyId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Find entities in a taxonomy whose `attributes` carry a given key
   * (regardless of value — including explicit JSON null). Used by the
   * PATCH taxonomy compatibility check to surface entities still using
   * a field that's being removed. The GIN index on `attributes` makes
   * the `?` probe fast at scale.
   *
   * `limit` caps result size so pathological patches fail fast rather
   * than scanning the whole taxonomy.
   */
  async entitiesWithAttributeKey(
    taxonomyId: string,
    key: string,
    limit: number,
  ): Promise<{ id: string }[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM entities
      WHERE taxonomy_id = ${taxonomyId}
        AND attributes ? ${key}
      LIMIT ${limit}
    `);
    return result.rows.map((r) => ({ id: r.id }));
  }

  /**
   * Find entities in a taxonomy whose `attributes` either lack a given
   * key entirely or have it set to JSON null. Used by the PATCH taxonomy
   * compatibility check for newly-required or tightened-required fields.
   *
   * The negation (`NOT (attributes ? key)`) can't use the GIN index, so
   * Postgres falls back to scanning entities within the taxonomy via
   * `entities_taxonomy_id_idx`. Cost is `O(E_taxonomy)` — fine at any
   * realistic per-taxonomy scale.
   */
  async entitiesMissingOrNullAttribute(
    taxonomyId: string,
    key: string,
    limit: number,
  ): Promise<{ id: string }[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM entities
      WHERE taxonomy_id = ${taxonomyId}
        AND (NOT (attributes ? ${key}) OR jsonb_typeof(attributes->${key}) = 'null')
      LIMIT ${limit}
    `);
    return result.rows.map((r) => ({ id: r.id }));
  }

  /**
   * Fetch entities in a taxonomy that have at least one of the given
   * attribute keys set, returning their id and full attribute payload.
   * Used by the PATCH taxonomy compatibility check to validate values
   * against a new field type in JS (since date/datetime format checks
   * can't be expressed cleanly in SQL).
   *
   * GIN-indexable via the `?|` any-of-keys operator.
   */
  async entitiesWithAnyAttributeKey(
    taxonomyId: string,
    keys: string[],
    limit: number,
  ): Promise<Entity[]> {
    if (keys.length === 0) return [];
    const keyConditions = sql.join(
      keys.map((k) => sql`attributes ? ${k}`),
      sql` OR `,
    );
    const result = await this.db.execute<{
      id: string;
      taxonomy_id: string;
      archived: boolean;
      attributes: Record<string, AttributeValue>;
    }>(sql`
      SELECT id, taxonomy_id, archived, attributes
      FROM entities
      WHERE taxonomy_id = ${taxonomyId}
        AND (${keyConditions})
      LIMIT ${limit}
    `);
    return result.rows.map((r) => ({
      id: r.id,
      taxonomy_id: r.taxonomy_id,
      archived: r.archived,
      attributes: r.attributes,
    }));
  }

  /**
   * Bulk upsert. Like the single-row variant, `taxonomy_id` is NOT
   * overwritten on conflict — the contract says it's immutable.
   * One round-trip regardless of input size; used by the fixture loader.
   */
  async upsertMany(list: Entity[]): Promise<void> {
    if (list.length === 0) return;
    await this.db
      .insert(entities)
      .values(
        list.map((e) => ({
          id: e.id,
          taxonomyId: e.taxonomy_id,
          archived: e.archived,
          attributes: e.attributes,
        })),
      )
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          archived: sql`excluded.archived`,
          attributes: sql`excluded.attributes`,
          updatedAt: new Date(),
        },
      });
  }
}
