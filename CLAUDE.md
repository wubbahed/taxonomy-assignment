# CLAUDE.md

Context for Claude Code sessions. Full build/run/extension docs live in
[README.md](README.md); the HTTP contract is [assignment/api-contract.md](assignment/api-contract.md).
This file captures the working knowledge that isn't obvious from reading those.

## Commands

```bash
# Bring up db + api in Docker (default local dev path)
npm run local
npm run local:down                                # also drops the db volume

npm test                                          # unit only without a DB; integration tests skip
docker compose up -d db
npm run test:integration                          # presets TEST_DATABASE_URL to the compose DB
npm run test:stress                               # gated stress suite (RUN_STRESS=1)

# Static checks
npm run lint        # eslint (flat config at eslint.config.mjs)
npm run lint:fix
npm run typecheck
npm run build

# Drizzle migration workflow
npm run db:generate                               # regenerate after src/db/schema.ts change
npm run db:migrate                                # apply pending migrations against DATABASE_URL
```

## Architecture

Single TypeScript package, no monorepo.

- `src/` — Fastify + Drizzle + pg. The whole HTTP service.
- `src/shared/` — Zod schemas + TS types reused at the HTTP boundary.
- `src/observability/` — OpenTelemetry metrics (Prometheus) + traces (OTLP).
  `tracing.ts` self-starts at module load and MUST be imported before anything
  else in `src/index.ts` so auto-instrumentation can patch fastify/pg/http.
- `openapi/openapi.yaml` — hand-authored OpenAPI 3.1 spec served by
  `src/plugins/docs.ts` at `GET /docs` (Swagger UI) and `GET /openapi.json`.
- `assignment/` — original prompt, contract, and fixture data.
- Docker Compose: `db` (postgres:16-alpine) + `api`, with healthcheck gating.
  API exposes **3000** (HTTP) and **9464** (Prometheus `/metrics`).

## Key Files

- `src/index.ts` — boot: `tracing.ts` import → loadEnv → createDb → migrate
  → seed fixtures → `reconcileEntityAttributeIndexes` → buildServer → listen
- `src/server.ts` — `buildServer()` factory; tests use `app.inject()`.
  `enableDocs` defaults to true (mounts `/docs` + `/openapi.json`); pass
  `false` for hardened deployments. Request-id hook lives here — not a
  separate plugin.
- `src/db/schema.ts` — Drizzle tables (JSONB for `fields` /
  `relationships` / `attributes`). Change here → run `drizzle-kit generate`.
- `src/routes/` — HTTP handlers; each calls out to a service. Shared
  query-param helpers in `_query.ts` (`parseBool`).
- `src/services/` — `graph.ts`, `resolve.ts`, `traversal.ts`, and
  `relationships.ts` (the shared `followRelationship` choke point used by
  all three traversal endpoints), plus:
  - `entityFetcher.ts` — the fetch abstraction (`DbEntityFetcher` for prod,
    `InMemoryEntityFetcher` for unit tests). Probes use JSONB `@>`
    containment so GIN indexes apply.
  - `indexManager.ts` — reconciles B-tree expression indexes on
    `entities.attributes->>'<key>'` for every `is_key: true` field. Runs
    non-concurrent at boot (inside DDL txn) and fire-and-forget concurrent
    after taxonomy mutations.
  - `taxonomyEvolution.ts` — the entity-compatibility guard for
    PATCH /taxonomies/:id. Targeted queries, capped at 100 breakages per
    category instead of loading every entity.
- `src/validation/` — `valueTypes.ts`, `entity.ts`, `taxonomy.ts`
  (structure + references incl. `to_many_through` cycle detection)
- `src/errors.ts` — `AppError` helpers (`validationError`, `notFound`,
  `conflict`, `payloadTooLarge`, `notImplemented`, `unavailable`);
  always throw these in routes
- `src/plugins/` — `errorHandler.ts` (global error handler) and `docs.ts`
  (Swagger UI + `/openapi.json` from `openapi/openapi.yaml`)
- `src/shared/{types.ts,schemas.ts}` — single source of truth for Taxonomy /
  Entity shapes
- `src/fixtures/loader.ts` — boot-time seed; runs full validation before
  writing anything (all-or-nothing)

## Testing

**Three tiers**, split by data needs:

- **Unit tests** (`*.test.ts` colocated with source) run anywhere:
  validators, resolver/traversal services, error handler. No DB.
- **Integration tests** (`*.integration.test.ts`, plus `*.crud.test.ts`,
  `*.concurrency.test.ts`, `*.patch.test.ts`, etc.) need Postgres and skip
  themselves via `const runOrSkip = DATABASE_URL ? describe : describe.skip`
  when `TEST_DATABASE_URL` (or `DATABASE_URL`) is unset.
- **Stress tests** (`*.stress.test.ts`) additionally gate on `RUN_STRESS=1`.
  `npm run test:stress` sets it; otherwise they skip even with a DB.

**Serialization**: `fileParallelism: false` in `vitest.config.ts` —
all integration tests share one Postgres, so vitest runs files sequentially.
Each file's `beforeEach` calls `truncateAll(handle)` which deletes entities
then taxonomies (FK order matters).

**Running the full suite**: start the db, export `TEST_DATABASE_URL`, then
`npm test`.

## Gotchas

- **Attributes are scalar only**: string / integer / float / boolean / date /
  datetime / null. Objects and arrays are rejected by the validator — the
  contract defines exactly these field types and no nested shape. If you need
  "structured data," model it as a new taxonomy with a `to_one` relationship.

- **Relationships are computed, not stored**: `to_one` / `to_many` work by
  matching attribute values (`source_field == target_field`). `to_many_through`
  composes other relationships via `through: [...]`. There is no FK between
  entities in the DB — every traversal re-resolves.

- **Archived semantics**: related entities marked `archived: true` are treated
  as missing during traversal. Archived taxonomies are omitted from graph
  recursion. Archived **root** entities and taxonomies are still served on
  direct lookup — this is intentional.

- **Docker fixture paths**: docker-compose mounts host `./assignment/fixtures`
  to container `/fixtures`. `FIXTURE_DIR` must be `/fixtures/public` — if
  you set it to `/assignment/fixtures/public` the loader will silently skip
  the seed (missing dir is not fatal). Host path for local dev (`.env`) is
  `./assignment/fixtures/public`.

- **Drop the db volume after schema or seed changes**: `docker compose down -v`.
  Otherwise a stale volume retains old migrations or data and `npm run local`
  will boot against a mismatched state.

- **PATCH /taxonomies/:id with `fields`** runs an entity-compatibility guard.
  Removing a field that entities use, changing a type that orphans values, or
  promoting an optional field to required without populating it → 409 with a
  per-entity breakage map in `details.entities`.

- **`npm run local` and `npm test` share a Postgres**. Running both at once
  against the compose db will corrupt the live app's state (tests truncate
  between cases). Stop the api container first or use a separate DB.

- **Logging**: every response includes `x-request-id` (generated if the
  client doesn't send one). Every log line includes `request_id` so you can
  grep a single request end-to-end. `authorization` / `cookie` / `x-api-key`
  are redacted.

- **OTel must be the first import in `src/index.ts`**. `observability/tracing.ts`
  self-starts at module load (skipped when `NODE_ENV=test`). If another module
  loads `fastify`/`pg`/`http` first, auto-instrumentation silently misses
  those spans. Prometheus metrics are served on a separate port (9464 by
  default, `OTEL_METRICS_PORT` overrides). OTLP traces export only if
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set — otherwise they no-op. These env
  vars are read by the OTel SDK directly, not through `src/env.ts`.

- **indexManager reconciliation runs twice**: once non-concurrent at boot
  (after fixtures load) and again as fire-and-forget concurrent work inside
  `reconcileIndexesAsync(deps)` after every taxonomy mutation. Concurrent
  mode can't run inside a DDL transaction — hence the split.

## Contract invariants to preserve

- All non-2xx responses use the error envelope: `{error: {code, message, details?}}`.
  Always throw `AppError` (see `errors.ts`) — never `reply.status(...).send()` for errors.
- Collections return ascending `id` order. Related entities in to_many traversal
  sort by target `id` ascending.
- `/resolve` always returns 200 with both `values` and `errors` maps;
  invalid paths go in `errors`, never the top-level envelope.
- `to_one` with multiple matches → 409 in `/entities/:id/data`;
  separate `ambiguous_to_one` per-path error in `/resolve`.
- `/healthz` is liveness only; `/readyz` pings the DB and returns 503 on
  failure — use it as the load-balancer health check.

## Workflow notes

- Plans live in `~/.claude/plans/` — use when refactoring something substantial.
- CI runs `lint → typecheck → build → test` (see `.github/workflows/ci.yml`).
  Match that order locally before committing.
- Don't hand-edit `drizzle/*.sql` — regenerate from `schema.ts`.
