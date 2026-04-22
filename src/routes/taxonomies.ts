import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createTaxonomySchema,
  patchTaxonomySchema,
  type Taxonomy,
} from "../shared/index.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import type { EntityRepo } from "../repositories/entityRepo.js";
import { conflict, notFound, validationError } from "../errors.js";
import { buildRelationshipGraph, MAX_DEPTH } from "../services/graph.js";
import {
  collectValidationDeps,
  validateTaxonomyReferences,
  validateTaxonomyStructure,
} from "../validation/taxonomy.js";
import { assertFieldChangeIsCompatible } from "../services/taxonomyEvolution.js";
import { graphDepthHistogram } from "../observability/metrics.js";
import { reconcileEntityAttributeIndexes } from "../services/indexManager.js";
import type { Database } from "../db/client.js";
import { parseBool } from "./_query.js";

interface Deps {
  db: Database;
  taxonomyRepo: TaxonomyRepo;
  entityRepo: EntityRepo;
}

/**
 * Fire-and-forget expression-index reconciliation after a taxonomy
 * mutation. Always runs with `concurrent: true` so the entities table
 * isn't write-blocked. Errors are logged and swallowed — an expression
 * index not landing immediately just means the next traversal pays a
 * sub-ms penalty until the next mutation retries the sync.
 */
function reconcileIndexesAsync(deps: Deps): void {
  (async () => {
    try {
      const taxonomies = await deps.taxonomyRepo.list(true);
      await reconcileEntityAttributeIndexes(deps.db, taxonomies, {
        concurrent: true,
      });
    } catch (err) {
      console.error("[indexManager] reconcile failed:", err);
    }
  })();
}

type IdParams = { Params: { taxonomy_id: string } };
type GraphRoute = IdParams & { Querystring: { depth?: string } };

export function taxonomyRoutes(deps: Deps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/taxonomies", listTaxonomies(deps));
    app.post("/taxonomies", createTaxonomy(deps));
    app.get<IdParams>("/taxonomies/:taxonomy_id", getTaxonomy(deps));
    app.patch<IdParams>("/taxonomies/:taxonomy_id", patchTaxonomy(deps));
    app.delete<IdParams>("/taxonomies/:taxonomy_id", deleteTaxonomy(deps));
    app.get<GraphRoute>(
      "/taxonomies/:taxonomy_id/relationship-graph",
      getRelationshipGraph(deps),
    );
  };
}

function listTaxonomies(deps: Deps) {
  return async (req: FastifyRequest) => {
    const query = req.query as Record<string, string | undefined>;
    const includeArchived = parseBool(query.include_archived, false);
    const data = await deps.taxonomyRepo.list(includeArchived);
    return { data };
  };
}

function createTaxonomy(deps: Deps) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createTaxonomySchema.parse(req.body) as Taxonomy;
    const existing = await deps.taxonomyRepo.get(parsed.id);
    if (existing) {
      throw conflict(`Taxonomy '${parsed.id}' already exists`, {
        id: parsed.id,
      });
    }
    validateTaxonomyStructure(parsed);
    // Only pull the taxonomies `parsed` actually references — avoids
    // loading the whole table on every create.
    const byId = await collectValidationDeps(parsed, (ids) =>
      deps.taxonomyRepo.listByIds(ids),
    );
    validateTaxonomyReferences(parsed, byId);
    const created = await deps.taxonomyRepo.upsert(parsed);
    reconcileIndexesAsync(deps);
    return reply.status(201).send(created);
  };
}

function getTaxonomy(deps: Deps) {
  return async (req: FastifyRequest<IdParams>) => {
    const found = await deps.taxonomyRepo.get(req.params.taxonomy_id);
    if (!found) throw notFound("Taxonomy", req.params.taxonomy_id);
    return found;
  };
}

function patchTaxonomy(deps: Deps) {
  return async (req: FastifyRequest<IdParams>) => {
    const patch = patchTaxonomySchema.parse(req.body);
    const existing = await deps.taxonomyRepo.get(req.params.taxonomy_id);
    if (!existing) throw notFound("Taxonomy", req.params.taxonomy_id);
    const merged: Taxonomy = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.fields !== undefined ? { fields: patch.fields } : {}),
      ...(patch.relationships !== undefined
        ? { relationships: patch.relationships }
        : {}),
    };
    if (patch.fields !== undefined || patch.relationships !== undefined) {
      validateTaxonomyStructure(merged);
      // Targeted fetch: only the taxonomies `merged` actually references.
      const byId = await collectValidationDeps(merged, (ids) =>
        deps.taxonomyRepo.listByIds(ids),
      );
      validateTaxonomyReferences(merged, byId);
    }
    if (patch.fields !== undefined) {
      // Targeted, indexed compatibility check — no longer loads the full
      // entity set into memory. Skips work entirely when the change is
      // strictly additive.
      await assertFieldChangeIsCompatible(
        existing.fields,
        merged,
        deps.entityRepo,
      );
    }
    const updated = await deps.taxonomyRepo.upsert(merged);
    // Only a fields change can affect the is_key set that indexManager
    // cares about; skip the reconcile call otherwise to avoid needless
    // DDL chatter under high-volume name/archived/relationship patches.
    if (patch.fields !== undefined) reconcileIndexesAsync(deps);
    return updated;
  };
}

function deleteTaxonomy(deps: Deps) {
  return async (req: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const existing = await deps.taxonomyRepo.get(req.params.taxonomy_id);
    if (!existing) throw notFound("Taxonomy", req.params.taxonomy_id);

    if (await deps.entityRepo.anyForTaxonomy(req.params.taxonomy_id)) {
      throw conflict(
        `Taxonomy '${req.params.taxonomy_id}' still has entities`,
        { taxonomy_id: req.params.taxonomy_id },
      );
    }

    const ref = await deps.taxonomyRepo.referencedBy(req.params.taxonomy_id);
    if (ref) {
      throw conflict(
        `Taxonomy '${req.params.taxonomy_id}' is still referenced by '${ref.taxonomyId}.${ref.relKey}'`,
        { referenced_by: `${ref.taxonomyId}.${ref.relKey}` },
      );
    }

    await deps.taxonomyRepo.delete(req.params.taxonomy_id);
    reconcileIndexesAsync(deps);
    return reply.status(204).send();
  };
}

function getRelationshipGraph(deps: Deps) {
  return async (req: FastifyRequest<GraphRoute>) => {
    const depth = req.query.depth ? Number.parseInt(req.query.depth, 10) : 2;
    if (!Number.isInteger(depth) || depth < 1) {
      throw validationError("`depth` must be an integer >= 1");
    }
    if (depth > MAX_DEPTH) {
      throw validationError(`\`depth\` must be <= ${MAX_DEPTH}`, {
        max_depth: MAX_DEPTH,
      });
    }
    graphDepthHistogram.record(depth, { endpoint: "graph" });

    // Load all taxonomies (including archived ones) so the service can
    // decide when to filter. The service returns null for an unknown root.
    const all = await deps.taxonomyRepo.list(true);
    const byId = new Map(all.map((t) => [t.id, t]));
    const result = buildRelationshipGraph({
      taxonomyId: req.params.taxonomy_id,
      depth,
      byId,
    });
    if (!result) throw notFound("Taxonomy", req.params.taxonomy_id);
    return result;
  };
}
