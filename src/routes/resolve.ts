/**
 * `POST /resolve` — dot-notation path resolution.
 *
 * Contract summary (`§ POST /resolve`): always returns **200** with
 * disjoint `values` and `errors` maps. Invalid paths go under `errors[path]`,
 * never as an envelope; the only ways this endpoint returns non-2xx are
 * a malformed body (400) or a missing `entity_id` (404).
 *
 * Why this route needs both repos:
 *   - `entityRepo.get(entity_id)` answers the existence check cheaply so
 *     we can 404 before doing any heavy lifting.
 *   - The path walker in `services/resolve.ts` needs the FULL read set
 *     (every taxonomy definition + every entity) to resolve
 *     relationship match clauses at arbitrary depth. There's no
 *     indexed lookup by match value in the current design.
 *
 * The upfront "load everything" is fine at fixture scale; a per-request
 * taxonomy cache is the obvious first optimization if needed (see
 * README extensions).
 */

import type { FastifyInstance } from "fastify";
import { resolveRequestSchema } from "../shared/index.js";
import type { EntityRepo } from "../repositories/entityRepo.js";
import type { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import { notFound } from "../errors.js";
import { resolvePaths } from "../services/resolve.js";
import { DbEntityFetcher } from "../services/entityFetcher.js";

interface Deps {
  entityRepo: EntityRepo;
  taxonomyRepo: TaxonomyRepo;
}

export function resolveRoutes(deps: Deps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/resolve", async (req) => {
      const parsed = resolveRequestSchema.parse(req.body);

      const entity = await deps.entityRepo.get(parsed.entity_id);
      if (!entity) throw notFound("Entity", parsed.entity_id);

      // Taxonomies are small (O(T)); entities are not — resolve now
      // fetches only the entities its paths actually need via the fetcher.
      const allTaxonomies = await deps.taxonomyRepo.list(true);

      return resolvePaths({
        root: entity,
        paths: parsed.paths,
        taxonomiesById: new Map(allTaxonomies.map((t) => [t.id, t])),
        fetcher: new DbEntityFetcher(deps.entityRepo),
      });
    });
  };
}
