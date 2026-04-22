/**
 * Drizzle table definitions.
 *
 * Two tables, both narrow: `taxonomies` and `entities`. The user-facing
 * shape lives inside JSONB columns (`fields`, `relationships`,
 * `attributes`). This is deliberate — taxonomies are user-defined at
 * runtime, so modelling `attributes` as real columns would mean a
 * migration on every taxonomy edit. The tradeoff is that value-level
 * invariants (attribute keys are valid field keys, values match field
 * types, etc.) can't be enforced at the DB layer — the application
 * validation pipeline is the sole source of truth. See the README
 * "Assumptions & tradeoffs" section for the full argument.
 *
 * The FK `entities.taxonomy_id → taxonomies.id ON DELETE restrict` is
 * belt-and-suspenders: the route handler already returns a friendly
 * 409 when you try to delete a taxonomy that still has entities, but
 * the FK means a direct SQL attempt fails the same way.
 */

import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  Relationship,
  TaxonomyField,
  AttributeValue,
} from "../shared/index.js";

export const taxonomies = pgTable(
  "taxonomies",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    archived: boolean("archived").notNull().default(false),
    fields: jsonb("fields").$type<TaxonomyField[]>().notNull().default([]),
    relationships: jsonb("relationships")
      .$type<Relationship[]>()
      .notNull()
      .default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // GIN index with jsonb_path_ops: accelerates `@>` containment queries
    // against `relationships`. Used by `TaxonomyRepo.referencedBy` to find
    // inbound references to a taxonomy without a sequential scan.
    // `jsonb_path_ops` is smaller and faster than the default `jsonb_ops`
    // and sufficient for the containment queries we run.
    relationshipsGinIdx: index("taxonomies_relationships_gin_idx").using(
      "gin",
      table.relationships.op("jsonb_path_ops"),
    ),
  }),
);

export const entities = pgTable(
  "entities",
  {
    id: text("id").primaryKey(),
    // ON DELETE restrict: the app layer returns 409 for delete-with-entities
    // first, but if something bypasses the handler the FK fires too.
    taxonomyId: text("taxonomy_id")
      .notNull()
      .references(() => taxonomies.id, { onDelete: "restrict" }),
    archived: boolean("archived").notNull().default(false),
    attributes: jsonb("attributes")
      .$type<Record<string, AttributeValue>>()
      .notNull()
      .default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Every read path filters by taxonomy_id (list, traversal, resolve).
    taxonomyIdIdx: index("entities_taxonomy_id_idx")
      .on(table.taxonomyId)
      .where(sql`archived = false`),
    // GIN on `attributes` with the default `jsonb_ops` opclass (NOT
    // `jsonb_path_ops` — we need `?` and `?|` key-existence operators,
    // which `jsonb_path_ops` does not support). Used by the PATCH
    // taxonomy compatibility checks to narrow entity scans from the
    // whole table to just rows whose attributes contain a given key.
    attributesGinIdx: index("entities_attributes_gin_idx")
      .using("gin", table.attributes)
      .where(sql`archived = false`),
  }),
);

export type TaxonomyRow = typeof taxonomies.$inferSelect;
export type EntityRow = typeof entities.$inferSelect;
