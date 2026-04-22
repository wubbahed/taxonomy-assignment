/**
 * Domain vocabulary
 * -----------------
 *
 * Everything in this service revolves around four terms. They're defined once
 * in the contract (`assignment/api-contract.md`) and restated here so code
 * readers don't have to bounce between files.
 *
 *   Taxonomy      A user-defined "kind of thing" — the schema for a set of
 *                 entities. Declares a name, a list of fields, and a list of
 *                 relationships to other taxonomies. Taxonomies are data, not
 *                 code: users create them at runtime.
 *
 *   Field         A typed attribute slot on a taxonomy. `key` is the
 *                 attribute name on entities; `type` is one of the six
 *                 supported scalar types; `required` gates presence on
 *                 create; `is_key` marks the field as the taxonomy's
 *                 canonical identifier (informational only — primary
 *                 uniqueness is the entity `id`).
 *
 *   Entity        A record belonging to exactly one taxonomy. `attributes`
 *                 is a flat map of scalar values keyed by field keys.
 *                 There is no nested data model — structured sub-records
 *                 are modelled as separate entities linked by relationships.
 *
 *   Relationship  A rule describing how entities of one taxonomy relate to
 *                 entities of another. Three flavors:
 *                   - to_one / to_many: resolved at read time by comparing
 *                     `source_field` values on this taxonomy to
 *                     `target_field` values on the other.
 *                   - to_many_through: compose an existing chain of
 *                     relationships, e.g. patient → enrollment → sessions.
 *                 There are no FKs between entities; every traversal is a
 *                 re-resolution.
 *
 *   MatchClause   `{ source_field, target_field }` pair. All clauses in a
 *                 relationship's `match` array must hold for a target
 *                 entity to be considered a match.
 *
 *   Cardinality   "to_one" | "to_many" | "to_many_through". Determines the
 *                 shape of traversal output (scalar vs array) and whether
 *                 multiple matches are an error (to_one ambiguity → 409
 *                 on /data, `ambiguous_to_one` error on /resolve).
 */

/** Supported scalar field types. Attribute values are always one of these
 *  at runtime (plus `null` when the field is nullable). No object or array
 *  types — nesting is modelled via relationships. */
export type FieldType =
  | "string"
  | "integer"
  | "boolean"
  | "float"
  | "date"
  | "datetime";

/** Relationship flavor. Drives traversal output shape and match semantics. */
export type Cardinality = "to_one" | "to_many" | "to_many_through";

/** One column definition on a taxonomy. */
export interface TaxonomyField {
  key: string;
  type: FieldType;
  required: boolean;
  is_key: boolean;
}

/** A single equality clause used by direct relationships. All clauses on a
 *  relationship must hold for a target entity to match. */
export interface RelationshipMatch {
  source_field: string;
  target_field: string;
}

/** `to_one` / `to_many` — resolved at read time by value-matching on
 *  declared `match` clauses. */
export interface DirectRelationship {
  key: string;
  target_taxonomy_id: string;
  cardinality: "to_one" | "to_many";
  match: RelationshipMatch[];
}

/** `to_many_through` — composes existing relationships. `through` is an
 *  ordered list of relationship keys starting from THIS taxonomy and
 *  walking to `target_taxonomy_id`. Does not declare its own `match`. */
export interface ThroughRelationship {
  key: string;
  target_taxonomy_id: string;
  cardinality: "to_many_through";
  through: string[];
}

/** Discriminated union on `cardinality`. Consumers narrow before accessing
 *  `match` (direct) or `through` (composed). */
export type Relationship = DirectRelationship | ThroughRelationship;

/** A taxonomy record as stored and exposed on the API. `fields` and
 *  `relationships` are user-defined and may evolve over time (see the
 *  PATCH /taxonomies/:id contract + entity-compatibility guard). */
export interface Taxonomy {
  id: string;
  name: string;
  archived: boolean;
  fields: TaxonomyField[];
  relationships: Relationship[];
}

/** The scalar-only invariant. Objects, arrays, and `undefined` are all
 *  rejected by the validator. `null` means "absent/unset" and is only
 *  valid on non-required fields. */
export type AttributeValue = string | number | boolean | null;

/** An entity record. `attributes` must be a flat map whose keys are a
 *  subset of its taxonomy's declared field keys — enforced in the
 *  validation layer, not the DB (attributes is JSONB). */
export interface Entity {
  id: string;
  taxonomy_id: string;
  archived: boolean;
  attributes: Record<string, AttributeValue>;
}

/** The shape of every non-2xx response body. See `src/errors.ts` for the
 *  catalogue of `code` values and `src/plugins/errorHandler.ts` for how
 *  this envelope is produced. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
