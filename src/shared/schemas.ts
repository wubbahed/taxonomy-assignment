/**
 * Zod schemas for every shape that crosses the HTTP boundary or the fixture
 * file boundary. These are the single source of truth for input validation —
 * routes import them, fixture loader imports them, and the TS types in
 * `types.ts` are the inferred counterparts.
 *
 * Conventions worth knowing:
 *   - `.strict()` on PATCH schemas: unknown top-level keys are rejected.
 *     This is how `id` / `taxonomy_id` immutability is enforced (those
 *     keys aren't declared, so PATCHing them is a 400).
 *   - `relationshipSchema` is a discriminated union on `cardinality` — the
 *     three variants have different required shape (`match` vs `through`).
 *   - `attributeValueSchema` enforces the "scalar only" contract rule.
 *     Objects and arrays fail parse, which produces a `validation_error`.
 */

import { z } from "zod";

/** The six supported field types, verbatim from the contract's Data Model
 *  section. Anything else is rejected at taxonomy create/update time. */
export const fieldTypeSchema = z.enum([
  "string",
  "integer",
  "boolean",
  "float",
  "date",
  "datetime",
]);

export const taxonomyFieldSchema = z.object({
  key: z.string().min(1),
  type: fieldTypeSchema,
  required: z.boolean(),
  is_key: z.boolean(),
});

const relationshipMatchSchema = z.object({
  source_field: z.string().min(1),
  target_field: z.string().min(1),
});

const directRelationshipSchema = z.object({
  key: z.string().min(1),
  target_taxonomy_id: z.string().min(1),
  cardinality: z.enum(["to_one", "to_many"]),
  match: z.array(relationshipMatchSchema).min(1),
});

const throughRelationshipSchema = z.object({
  key: z.string().min(1),
  target_taxonomy_id: z.string().min(1),
  cardinality: z.literal("to_many_through"),
  through: z.array(z.string().min(1)).min(1),
});

/** Discriminated union on `cardinality`. `to_one` and `to_many` require
 *  `match` (direct); `to_many_through` requires `through` (composed). */
export const relationshipSchema = z.discriminatedUnion("cardinality", [
  directRelationshipSchema.extend({ cardinality: z.literal("to_one") }),
  directRelationshipSchema.extend({ cardinality: z.literal("to_many") }),
  throughRelationshipSchema,
]);

export const taxonomySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  archived: z.boolean(),
  fields: z.array(taxonomyFieldSchema),
  relationships: z.array(relationshipSchema),
});

/** POST /taxonomies body. `archived` defaults to `false` when omitted. */
export const createTaxonomySchema = taxonomySchema.extend({
  archived: z.boolean().default(false),
});

/** PATCH /taxonomies/:id body. `.strict()` rejects `id` or any other
 *  undeclared key — that's how immutability is enforced. The route layer
 *  merges declared keys onto the existing record and then re-validates
 *  structure + references + entity compatibility. */
export const patchTaxonomySchema = z
  .object({
    name: z.string().min(1).optional(),
    archived: z.boolean().optional(),
    fields: z.array(taxonomyFieldSchema).optional(),
    relationships: z.array(relationshipSchema).optional(),
  })
  .strict();

/** Per the contract, attributes are scalar only. This schema is the gate
 *  — objects and arrays fail parse here, producing a `validation_error`
 *  envelope at the HTTP layer. See `src/validation/valueTypes.ts` for the
 *  per-field-type checks that run next. */
export const attributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const entitySchema = z.object({
  id: z.string().min(1),
  taxonomy_id: z.string().min(1),
  archived: z.boolean(),
  attributes: z.record(z.string(), attributeValueSchema),
});

/** POST /entities body. `archived` defaults to `false`. Additional
 *  validation (attribute keys valid for the taxonomy, values match field
 *  types, required fields present) happens in `validateAttributes`. */
export const createEntitySchema = entitySchema.extend({
  archived: z.boolean().default(false),
});

/** PATCH /entities/:id body. `.strict()` rejects `id` and `taxonomy_id`
 *  — both immutable per contract. Declared attribute keys are merged
 *  onto the existing attribute map; `null` values are legal for
 *  non-required fields. */
export const patchEntitySchema = z
  .object({
    archived: z.boolean().optional(),
    attributes: z.record(z.string(), attributeValueSchema).optional(),
  })
  .strict();

/** POST /resolve body. `paths` is a non-empty list of dot-notation path
 *  strings. Per-path parsing happens in `services/resolve.ts`. */
export const resolveRequestSchema = z.object({
  entity_id: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
});

/** Fixture file shapes. `FIXTURE_DIR/taxonomies.json` and
 *  `FIXTURE_DIR/entities.json`. Loaded once on boot and upserted. */
export const fixtureTaxonomyFileSchema = z.array(taxonomySchema);
export const fixtureEntityFileSchema = z.array(entitySchema);
