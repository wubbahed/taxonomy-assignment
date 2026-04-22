# Assignment - Taxonomies & Entities

An HTTP service that manages user-defined taxonomies (schemas) and entities (records) with relationship traversal and dot-notation path resolution.

Original assignment: [assignment/README.md](assignment/README.md). Contract: [assignment/api-contract.md](assignment/api-contract.md).

## Technical Stack

- **TypeScript** on **Node 20**
- **Fastify** for HTTP
- **Drizzle ORM** on **PostgreSQL 16** (JSONB-backed storage for flexible `fields`, `relationships`, `attributes`)
- **Zod** for request validation
- **Vitest** for tests
- **ESLint** (flat config) + **Prettier**
- **Docker Compose** for local development

## Repo layout

```
src/                      # the HTTP service
  index.ts                #   boot: tracing → loadEnv → migrate → seed → indexManager → listen
  server.ts               #   buildServer() factory (used by index and tests)
  env.ts                  #   Zod-validated env
  db/                     #   drizzle client + schema + migrations runner
  routes/                 #   Fastify handlers (health, taxonomies, entities, resolve)
  services/               #   graph, resolve, traversal, relationships, entityFetcher,
                          #     indexManager, taxonomyEvolution
  validation/             #   valueTypes, entity, taxonomy validators
  repositories/           #   data access
  observability/          #   OpenTelemetry: Prometheus metrics + OTLP traces
  plugins/                #   error handler + Swagger UI
  shared/                 #   Zod schemas + TS types reused at the HTTP boundary
  fixtures/               #   startup loader
  test/                   #   test db helpers
openapi/openapi.yaml      # hand-authored OpenAPI 3.1 spec (served at /docs)
drizzle/                  # generated SQL migrations (three so far)
assignment/
  README.md               # original assignment prompt
  api-contract.md         # HTTP contract (authoritative spec)
  fixtures/public/        # seed data (taxonomies.json, entities.json)
Dockerfile                # multi-stage build
docker-compose.yml        # api + db
```

## Build & run — Docker (recommended)

Requires Docker Desktop (or any Docker + Compose).

```bash
npm install           # one-time
npm run local         # docker compose up --build
```

This starts:

- `db` — `postgres:16-alpine` on `localhost:5432`
- `api` — contains multiple things, including:
  - the service on http://localhost:3000
  - Prometheus metrics exported on http://localhost:9464/metrics
  - Interactive API docs at http://localhost:3000/docs
  - the raw OpenAPI spec at http://localhost:3000/openapi.json

On boot, the API runs migrations, then idempotently seeds taxonomies and entities from the `FIXTURE_DIR` directory into Postgres. Restarts are safe since the loader does an upsert.

Tear down:

```bash
npm run local:down    # docker compose down -v (drops the DB volume too)
```

## Build & run — local (no Docker)

You need Node 20 and a running Postgres.

```bash
cp .env.example .env
# edit DATABASE_URL / FIXTURE_DIR if needed

npm install
npm run build
npm start
# or, for dev with auto-reload:
npm run dev
```

## Running tests

```bash
npm test                  # unit tests only; integration tests skip without a DB
npm run test:integration  # unit + integration (points at the compose DB)
```

> **Note for auto-runners / first-time setup:** plain `npm test` skips
> integration tests when `TEST_DATABASE_URL` / `DATABASE_URL` is unset
> (intentional — keeps the default run infrastructure-free). To exercise
> the full suite, start Postgres (`docker compose up -d db`) and use
> `npm run test:integration`, which presets
> `TEST_DATABASE_URL=postgres://aviary:aviary@localhost:5432/aviary`.

Tests are split into three tiers and sit alongside the code files, e.g.:

- **Unit tests** (`*.test.ts`) — validators, services, error handler. No DB.
- **Integration tests** (`*.integration.test.ts`, `*.crud.test.ts`,
  `*.concurrency.test.ts`, `*.patch.test.ts`, etc.) — require Postgres.
  Skipped automatically unless `TEST_DATABASE_URL` or `DATABASE_URL` is set.
- **Stress tests** (`*.stress.test.ts`) — additionally gated on `RUN_STRESS=1`.
  Run with `npm run test:stress`.

To run the full (non-stress) suite locally against the compose DB:

```bash
docker compose up -d db
npm run test:integration
```

CI runs the full suite in GitHub Actions against a Postgres service container — see [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Example commands

Assumes the service is running on `localhost:3000` and fixtures are seeded.

### Health

```bash
curl -s http://localhost:3000/healthz
# {"ok":true}

curl -s http://localhost:3000/readyz
# {"ok":true,"db":"ok"}
```

### API docs & observability

```bash
# Swagger UI (browser)
open http://localhost:3000/docs

# Raw OpenAPI 3.1 spec
curl -s http://localhost:3000/openapi.json | jq '.info'

# Prometheus metrics (separate port)
curl -s http://localhost:9464/metrics | head -40
```

### List taxonomies

```bash
curl -s http://localhost:3000/taxonomies | jq '.data[].id'
# "care_teams"
# "clinics"
# "coaching_sessions"
# "patients"
# "program_enrollments"
# "support_tickets"
```

### Get one taxonomy

```bash
curl -s http://localhost:3000/taxonomies/patients | jq
```

### Create a taxonomy

```bash
curl -s -X POST http://localhost:3000/taxonomies \
  -H 'content-type: application/json' \
  -d '{
    "id": "widgets",
    "name": "Widgets",
    "archived": false,
    "fields": [
      { "key": "sku",    "type": "string",  "required": true,  "is_key": true  },
      { "key": "count",  "type": "integer", "required": true,  "is_key": false },
      { "key": "on_sale","type": "boolean", "required": false, "is_key": false }
    ],
    "relationships": []
  }'
```

### List entities of a taxonomy

```bash
curl -s 'http://localhost:3000/entities?taxonomy_id=patients' | jq
```

### Create an entity

```bash
curl -s -X POST http://localhost:3000/entities \
  -H 'content-type: application/json' \
  -d '{
    "id": "widget-1",
    "taxonomy_id": "widgets",
    "archived": false,
    "attributes": { "sku": "SKU-1", "count": 42, "on_sale": true }
  }'
```

### See validation in action

```bash
# Nested object as an attribute value → 400 validation_error
curl -s -X POST http://localhost:3000/entities \
  -H 'content-type: application/json' \
  -d '{
    "id": "widget-bad",
    "taxonomy_id": "widgets",
    "archived": false,
    "attributes": { "sku": "SKU-X", "count": { "nested": true } }
  }' | jq
```

### Relationship graph

```bash
curl -s 'http://localhost:3000/taxonomies/patients/relationship-graph?depth=3' | jq
```

### Entity data traversal

```bash
# Nested, include to-many relationships
curl -s 'http://localhost:3000/entities/patient-1001/data?depth=3&include_to_many=true&format=nested' | jq

# Flat format with dot-notation keys
curl -s 'http://localhost:3000/entities/patient-1001/data?depth=3&include_to_many=true&format=flat' | jq
```

### Path resolution

```bash
curl -s -X POST http://localhost:3000/resolve \
  -H 'content-type: application/json' \
  -d '{
    "entity_id": "patient-1001",
    "paths": [
      "first_name",
      "care_team.assigned_nurse",
      "care_team.clinic.name",
      "support_tickets.status",
      "coaching_sessions.engagement_score",
      "care_team.unknown_field"
    ]
  }' | jq
```

Valid paths land in `values`; invalid paths land in `errors` — response is always 200.

## Project scripts

| script                      | purpose                                                 |
| --------------------------- | ------------------------------------------------------- |
| `npm run local`             | build and start api + db in Docker Compose              |
| `npm run local:down`        | stop containers, drop the DB volume                     |
| `npm run build`             | `tsc -p tsconfig.json`                                  |
| `npm run dev`               | tsx watch on `src/index.ts`                             |
| `npm start`                 | run the built service (`dist/index.js`)                 |
| `npm test`                  | vitest (unit only without a DB; integration tests skip) |
| `npm run test:watch`        | vitest in watch mode                                    |
| `npm run test:integration`  | vitest with `TEST_DATABASE_URL` preset to the compose DB |
| `npm run test:stress`       | vitest with `RUN_STRESS=1` — unlocks `*.stress.test.ts` |
| `npm run typecheck`         | `tsc --noEmit`                                          |
| `npm run lint` / `lint:fix` | eslint (flat config at `eslint.config.mjs`)             |
| `npm run format`            | prettier                                                |
| `npm run db:generate`       | `drizzle-kit generate` from `src/db/schema.ts`          |
| `npm run db:migrate`        | apply pending migrations against `DATABASE_URL`         |

## Environment variables

| var                           | required | default                       | purpose                                                                    |
| ----------------------------- | -------- | ----------------------------- | -------------------------------------------------------------------------- |
| `PORT`                        | no       | `3000`                        | HTTP listen port                                                           |
| `FIXTURE_DIR`                 | yes      | —                             | path to directory containing `taxonomies.json` and `entities.json`         |
| `DATABASE_URL`                | yes      | —                             | Postgres connection string                                                 |
| `NODE_ENV`                    | no       | `development`                 | `development` / `test` / `production` — drives log level + pretty-printing |
| `LOG_LEVEL`                   | no       | `debug` (dev) / `info` (prod) | override log level                                                         |
| `TEST_DATABASE_URL`           | no       | —                             | overrides `DATABASE_URL` for `npm test` only                               |
| `RUN_STRESS`                  | no       | —                             | set to `1` to include `*.stress.test.ts` in the run                        |
| `OTEL_SERVICE_NAME`           | no       | `aviary-api`                  | service name for OTel exports                                              |
| `SERVICE_VERSION`             | no       | package version               | surfaced as a resource attribute                                           |
| `OTEL_METRICS_PORT`           | no       | `9464`                        | Prometheus scrape port                                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no       | —                             | if set, enables OTLP trace export to this collector                        |

The OTel variables are consumed by the OpenTelemetry SDK directly, not
through `src/env.ts`, so they're optional at boot.

See [.env.example](.env.example) for a starting point.


## Design decisions

### JSONB storage over per-taxonomy columns

User-defined schemas mean column-per-field would force a migration on every taxonomy edit. JSONB keeps writes universal. The cost: no native type constraints and no fast arbitrary-attribute equality. Mitigated by:

- Application-layer Zod validation on every write.
- Auto-reconciled B-tree expression indexes on every `is_key: true` field ([indexManager.ts](src/services/indexManager.ts)).
- GIN on `entities.attributes` for multi-field containment probes.
- GIN (`jsonb_path_ops`) on `taxonomies.relationships` for the `DELETE /taxonomies/:id` referenced-by check.

### Relationships resolved at read time, not stored

`to_one` / `to_many` are matching rules (`source_field == target_field`). `to_many_through` composes them via `through: [...]`. This is part of the contract and mirrors the product's flexibility. Every traversal re-resolves — mitigated by batched relationship probes ([relationships.ts](src/services/relationships.ts) `followRelationshipBatch`) that dedupe across sources at every BFS level, issuing one query per relationship per depth instead of per-source.

### Fixture seeding on every boot

The loader runs the full Zod + structure + reference + `to_many_through` cycle-detection battery against every taxonomy and entity *before* any write, so a broken fixture fails boot cleanly rather than half-populating the DB. The loader is schema-driven — any `taxonomies.json` / `entities.json` pair that satisfies the contract (including the private evaluation set) flows through the same validators. **Intentionally expedient for the assignment — wouldn't ship this way to production.**

### PATCH-taxonomy compatibility guard

Schema edits that would break existing entities — removing a used field, changing a type that orphans values, or promoting an optional field to required without populating it — return **409** with a per-entity breakage map in `details.entities`, so clients see *which* entities block the change ([taxonomyEvolution.ts](src/services/taxonomyEvolution.ts)). Bounded at 100 breakages per category so a large breakage set doesn't OOM the handler.

### Operational hardening

- **Observability**
  - I have a lot of questions about the data itself, and one way to answer those questions is by observing the service, so an initial template has been setup.
  - OpenTelemetry auto-instrumentation ([tracing.ts](src/observability/tracing.ts)) with OTLP trace export when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
  - Prometheus metrics on `:9464/metrics` with custom instruments (`aviary_graph_depth`, `aviary_traversal_fanout`, `aviary_resolve_path_outcome_total`) in [metrics.ts](src/observability/metrics.ts).
  - Structured pino logging with `x-request-id` correlation (inbound header honored, otherwise UUID-minted) and redacted `authorization` / `cookie` / `x-api-key`.
- **Readiness & shutdown**
  - Added `GET /readyz` to ping the DB and return `503` on failure.
  - `SIGINT` / `SIGTERM` drain Fastify, close the pg pool, and flush OTel before exit.
- **Safety caps**
  - `MAX_DEPTH=50` and `MAX_GRAPH_NODES=10_000` on both graph traversal endpoints → `400` or `413` when exceeded, preventing exponential blowup on deep or high-fan-out DAGs. 
- **Error uniformity**
   - every non-2xx flows through one handler via `AppError` ([errors.ts](src/errors.ts)). No `reply.status().send()` scattered through routes, so the error envelope shape is uniform and internals can't leak.
- **API self-description**
  - OpenAPI 3.1 at [openapi/openapi.yaml](openapi/openapi.yaml), served as JSON at `/openapi.json` and Swagger UI at `/docs` (toggle off via `enableDocs: false` for hardened deployments).
- **Validation rigor**
  - `to_many_through` cycle detection at taxonomy-validation time.
  - NFC Unicode normalization on attribute strings so matching-rule relationships don't diverge across composed-vs-decomposed forms.
  - Strict `integer` / `float` (rejects `5.1`, `NaN`, `Infinity`, numeric strings).
  - Zod `.strict()` on every PATCH schema so attempts to change `id` / `taxonomy_id` are rejected at the boundary.
- **Not implemented** — auth, rate limiting, explicit field-rename operation.



## What I'd build next

### Data Considerations

What I focused on for this assignment is building out a general service that covered a wide range of use cases. Before proceeding further, I'd really want to better understand some practical examples to understand the richness of data folks want to capture as well the typical graph shape of common queries. This information would be critical in determining the priority of which features come next.

### UI for presenting (and editing) taxonomies and entities

There would obviously be a way to search, browse and edit both taxonomies and entities, though I might consider instead of making a generic console to have it slightly customized for different use cases.  Also, it would be important for this UI to support cumbersome edge cases like being unable to delete or change a taxonomy because of entity conflicts. That data rule is important, but it's equally important to make it easy for users to make those edits if they choose.

### Richer field types

Probably the next step here is to make `FieldType` a discriminated union, e.g. 
```json
[
  {
    type: "enum", 
    values: string[] 
  }, 
  { 
    type: "email" 
  },
  { 
    type: "phone_number", 
    region?: string
  },
  { 
    type: "url"
  },
  { 
    type: "currency", 
    code: string
  }
]

``` 

From there you could do things like:
- Push additional validators into `validation/valueTypes.ts` behind a strategy map so `checkValueType` stays small. Each validator owns its own parse + normalize step (`email` lowercases, `phone_number` normalizes to E.164).
- For an `enum` type, you could persist the allowed-values array with the taxonomy. On update, either reject the change if any existing entity holds a now-invalid value, or run a confirmed migration that nulls/remaps offenders.
- For a `file` / `image` type, you could point at a blob store (S3), with the attribute storing a reference ID.
- etc.

### Ideas around Cohort querying

I'd prefer to do more data analysis and better understand use cases before tackling ALL of these, but some options I would consider include:
- **Pagination** — cursor-based on `id` (results are already ordered by it).
- **Indexing follow-ons** — promote the `is_key` mechanism to a user-facing `indexed: true` flag on any field (same reconciler, broader applicability), and add composite expression indexes for multi-field match clauses that today fall back to generic GIN containment.
- **Filter trees** — Create a query language, not SQL, for filter trees, e.g. 

```json
{
  "op": "and",
  "clauses": [
    { "field": "status", "op": "eq", "value": "active" },
    {
      "field": "care_team.clinic.region",
      "op": "in",
      "value": ["north", "south"]
    }
  ]
}

```

Paths reuse the `/resolve` dot-notation, so the resolver and query planner share one implementation.
- **Execution** — translate the tree to SQL. Direct attribute filters become `WHERE attributes->>'k' = ...`; path filters become recursive joins through matching rules.
- **Saved cohorts** — persist named filter trees, optionally materialized as snapshot tables refreshed on a cadence.


### Ideas for Validation and uniqueness constraints

Again, lots to consider, but as a starting point I'd look at:
- **Per-field validators** — `min_length`, `max_length`, `pattern`, `min`, `max`. These could be stored on the field definition and enforced by `validateAttributes`.
- **Single-field uniqueness** — a `unique: true` flag, enforced with a partial unique index on a generated column derived from `attributes->>'<key>'`.
- **Multi-field uniqueness** — e.g. `(patient_number, program_key)` — via a taxonomy-level `unique_constraints` array that creates composite generated-column indexes.
- **Referential integrity** — `to_one` relationships could declare `required: true`, with a choice between synchronous enforcement (reject orphan inserts) and async checks (nightly job flags broken references). The former is more correct; the latter lets bulk loads proceed without ordering constraints.
- **Cross-entity rules** — e.g. "a patient may not have two active enrollments" — belong in a domain rules engine layered on top of the generic validator.

### Considerations for evolving the schema

Some ideas of how to expand the PATCH methods, though I wouldn't pursue any of these without better understanding the data set:

- **Make explicit field rename** a first-class operation (`{ from: "old_key", to: "new_key" }`) that renames the definition and rewrites every entity's `attributes` map in one transaction. Today an atomic `fields` replacement silently loses data.
- **Enforce type changes with a dry-run** — per-value coercion (e.g. `string → integer` rejects values that don't parse), plus an endpoint that returns the set of offending entities before the change commits.
- **Versioning** — taxonomies become append-only via a `taxonomy_versions` table with a version-id FK from each entity write. Queries can target a specific version; migrations become lazy (entities keep validating against their recorded version until next written). Heavier, but solves rollback and audit cleanly. Composite uniqueness (e.g. `(patient_number, program_key)`) fits naturally here, enforced via generated-column unique indexes.

### Caching options

I feel like I'm repeating myself, but the data set would play a huge role in determining caching strategy. But some options I'd consider are:

- **Use an in-process LRU of taxonomy definitions** — keyed by taxonomy id, invalidated on PATCH/DELETE. Taxonomies change rarely and every traversal reads them, so this is a cheap win.
- **Precomputed relationship plans** — cache the walk description reused across graph / data / resolve, so traversal doesn't rebuild it on every request.
- **Resolved-value cache** — at higher read QPS, cache per `(entity_id, path)` with a short TTL keyed to taxonomy version and entity `updated_at`.
- **Only consider Redis for taxonomy lookups** — if the footprint outgrows a single node. Entity reads should keep hitting the DB for correctness.
- **Read-side materialization** — for genuinely read-heavy traversal, periodically denormalize common paths into a `resolved_values` table (`(entity_id, path, value, updated_at)`). Pay the cost on write; read becomes one indexed lookup.
