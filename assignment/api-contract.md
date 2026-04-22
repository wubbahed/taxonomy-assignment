# HTTP Contract

This document defines the required HTTP interface for the take-home service. It is intended to be fleshed out prompt to hand off to AI tools to aid you in setting up the fundamentals.

## Runtime Requirements

- The service must read fixtures from the directory specified by `FIXTURE_DIR`.
- The service must listen on `PORT`.
- If `PORT` is not set, default to `3000`.
- A DB-backed implementation is preferred, but the service may keep state in memory after startup.
- All responses must be JSON.

## General Rules

- Collections must be returned in ascending `id` order unless otherwise specified.
- Related entities in `to_many` traversal results must be ordered by related entity `id`, ascending.
- Unknown fields, unsupported field types, and invalid relationship definitions should return a validation error.
- Response bodies for non-2xx responses must use the error envelope described below.

## Error Envelope

For non-2xx responses, return:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Human-readable message",
    "details": {
      "field": "Optional structured detail"
    }
  }
}
```

Recommended status codes:

- `400` for validation errors
- `404` for missing resources
- `409` for conflicts

## Data Model

### Taxonomy

```json
{
  "id": "patients",
  "name": "Patients",
  "archived": false,
  "fields": [
    {
      "key": "patient_number",
      "type": "string",
      "required": true,
      "is_key": true
    },
    {
      "key": "date_of_birth",
      "type": "date",
      "required": true,
      "is_key": false
    }
  ],
  "relationships": [
    {
      "key": "care_team",
      "target_taxonomy_id": "care_teams",
      "cardinality": "to_one",
      "match": [
        {
          "source_field": "care_team_code",
          "target_field": "team_code"
        }
      ]
    },
    {
      "key": "coaching_sessions",
      "target_taxonomy_id": "coaching_sessions",
      "cardinality": "to_many_through",
      "through": ["current_enrollment", "coaching_sessions"]
    }
  ]
}
```

Rules:

- `id` must be unique across taxonomies.
- `fields[].key` must be unique within a taxonomy.
- `relationships[].key` must be unique within a taxonomy.
- Supported field types are:
  - `string`
  - `integer`
  - `boolean`
  - `float`
  - `date`
  - `datetime`
- `cardinality` must be one of:
  - `to_one`
  - `to_many`
  - `to_many_through`
- Every `match` entry must reference a source field on the current taxonomy and a target field on the target taxonomy.
- `match` may contain multiple entries. All entries must match for a related entity to count as a match.
- `to_many_through` relationships must declare:
  - `target_taxonomy_id`
  - `through`, an ordered array of relationship keys to follow from the current taxonomy
- `to_many_through` relationships do not use `match` directly. They compose existing relationships.

### Entity

```json
{
  "id": "patient-1001",
  "taxonomy_id": "patients",
  "archived": false,
  "attributes": {
    "patient_number": "P1001",
    "first_name": "John",
    "last_name": "Doe"
  }
}
```

Rules:

- `id` must be unique across entities.
- `taxonomy_id` must reference an existing taxonomy.
- `attributes` keys must be valid field keys on the entity's taxonomy.
- On create, all required fields must be present.
- Values must match the taxonomy field type unless the value is `null`.
- `taxonomy_id` is immutable after creation.

## Endpoints

### `GET /healthz`

Response:

```json
{
  "ok": true
}
```

### `GET /taxonomies`

Query params:

- `include_archived`: optional, `true` or `false`, default `false`

Response:

```json
{
  "data": [
    {
      "id": "patients",
      "name": "Patients",
      "archived": false,
      "fields": [],
      "relationships": []
    }
  ]
}
```

### `POST /taxonomies`

Request body: taxonomy object

Response:

- `201` with the created taxonomy

### `GET /taxonomies/:taxonomy_id`

Response:

- `200` with the taxonomy object
- `404` if missing

### `PATCH /taxonomies/:taxonomy_id`

Allowed top-level fields:

- `name`
- `archived`
- `fields`
- `relationships`

Patch semantics:

- provided scalar fields replace the existing value
- if `fields` is provided, it replaces the entire field list
- if `relationships` is provided, it replaces the entire relationship list
- `id` is immutable

Response:

- `200` with the updated taxonomy

### `DELETE /taxonomies/:taxonomy_id`

Required behavior:

- return `204` on success
- return `404` if missing
- return `409` if:
  - any entities still belong to the taxonomy, or
  - any other taxonomy still references it in a relationship

### `GET /entities`

Query params:

- `taxonomy_id`: required
- `include_archived`: optional, `true` or `false`, default `false`

Response:

```json
{
  "data": [
    {
      "id": "patient-1001",
      "taxonomy_id": "patients",
      "archived": false,
      "attributes": {}
    }
  ]
}
```

### `POST /entities`

Request body: entity object

Response:

- `201` with the created entity

### `GET /entities/:entity_id`

Response:

- `200` with the entity object
- `404` if missing

### `PATCH /entities/:entity_id`

Allowed top-level fields:

- `archived`
- `attributes`

Patch semantics:

- if `archived` is provided, replace the existing value
- if `attributes` is provided, merge keys into the existing attribute map
- keys present in `attributes` may be set to `null`
- `id` and `taxonomy_id` are immutable

Response:

- `200` with the updated entity

### `DELETE /entities/:entity_id`

Required behavior:

- return `204` on success
- return `404` if missing

Delete semantics:

- hard delete is acceptable

### `GET /taxonomies/:taxonomy_id/relationship-graph`

Query params:

- `depth`: optional integer, default `2`, minimum `1`

Depth semantics:

- `depth=1` means only the root taxonomy's own fields
- `depth=2` includes one relationship hop
- `depth=3` includes two relationship hops

Response shape:

```json
{
  "taxonomy_id": "patients",
  "depth": 2,
  "graph": {
    "taxonomy_id": "patients",
    "patient_number": "string",
    "first_name": "string",
    "last_name": "string",
    "care_team": {
      "taxonomy_id": "care_teams",
      "team_code": "string",
      "assigned_nurse": "string"
    }
  }
}
```

Rules:

- include the root `taxonomy_id` key at every nested taxonomy node
- field values in the graph should be the field type string
- archived taxonomies should be omitted from traversal
- cycle handling is required; traversal must not recurse forever

### `GET /entities/:entity_id/data`

Query params:

- `depth`: optional integer, default `2`, minimum `1`
- `include_to_many`: optional, `true` or `false`, default `false`
- `format`: optional, `nested` or `flat`, default `nested`

Response, `format=nested`:

```json
{
  "entity_id": "patient-1001",
  "taxonomy_id": "patients",
  "data": {
    "id": "patient-1001",
    "patient_number": "P1001",
    "first_name": "John",
    "care_team": {
      "id": "care-team-red",
      "team_code": "TEAM-RED",
      "assigned_nurse": "Nurse Joy"
    }
  }
}
```

Response, `format=flat`:

```json
{
  "entity_id": "patient-1001",
  "taxonomy_id": "patients",
  "data": {
    "id": "patient-1001",
    "patient_number": "P1001",
    "care_team.id": "care-team-red",
    "care_team.assigned_nurse": "Nurse Joy",
    "support_tickets.0.id": "ticket-1",
    "support_tickets.0.status": "open"
  }
}
```

Rules:

- include the root entity's `id` in traversal output
- `depth=1` returns only root attributes plus root `id`
- `to_one` relationships with no active match must serialize as `null` in nested format
- `to_many_through` relationships behave like `to_many` in output shape
- archived related entities must be treated as missing
- `to_many` relationships are omitted entirely unless `include_to_many=true`
- with `include_to_many=true`, `to_many` and `to_many_through` relationships serialize as arrays in nested format
- flattened arrays must use numeric dot-notation indices such as `support_tickets.0.status`
- if multiple related entities match a `to_one` relationship, return a `409` conflict

### `POST /resolve`

Request body:

```json
{
  "entity_id": "patient-1001",
  "paths": [
    "first_name",
    "care_team.assigned_nurse",
    "care_team.clinic.name",
    "support_tickets.status",
    "current_enrollment.assigned_coach",
    "coaching_sessions.engagement_score"
  ]
}
```

Response:

```json
{
  "entity_id": "patient-1001",
  "values": {
    "first_name": "John",
    "care_team.assigned_nurse": "Nurse Joy",
    "care_team.clinic.name": "South Loop Clinic",
    "support_tickets.status": ["open", "pending"],
    "current_enrollment.assigned_coach": "Coach Lee",
    "coaching_sessions.engagement_score": [0.82, 0.74]
  },
  "errors": {}
}
```

Rules:

- return `200` with both `values` and `errors`
- a direct field path is valid
- all non-terminal path segments must be relationship keys
- the terminal path segment must be a field key
- if a path traverses only `to_one` relationships, return a scalar value or `null`
- if a path traverses any `to_many` or `to_many_through` relationship, return an array of values
- for `to_many` and `to_many_through` paths, preserve deterministic ordering using related entity `id` ascending
- if no active related entities are found for a `to_many` or `to_many_through` path, return `[]`
- if an invalid path is requested, record it under `errors[path]`

Example invalid-path error:

```json
{
  "entity_id": "patient-1001",
  "values": {
    "first_name": "John"
  },
  "errors": {
    "care_team.unknown_field": {
      "code": "field_not_found",
      "message": "Field 'unknown_field' does not exist on taxonomy 'care_teams'"
    }
  }
}
```
