/**
 * Entity CRUD + `GET /entities/:id/data` traversal.
 *
 * Handlers here are thin: each validates input with Zod (the schemas in
 * `src/shared/schemas.ts` enforce the immutability rules via `.strict()`),
 * checks existence, runs attribute-level validation against the taxonomy
 * (see `validateAttributes` in `src/validation/entity.ts`), and delegates
 * to the repo or traversal service. Contract-specific rules like the
 * PATCH attribute-merge semantics and `to_one` ambiguity 409 live in
 * this file's comments next to the relevant branches.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createEntitySchema,
  patchEntitySchema,
  type Entity,
} from "../shared/index.js";
import type { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import type { EntityRepo } from "../repositories/entityRepo.js";
import { conflict, notFound, validationError } from "../errors.js";
import { traverseEntityData } from "../services/traversal.js";
import { MAX_DEPTH } from "../services/graph.js";
import { DbEntityFetcher } from "../services/entityFetcher.js";
import {
  normalizeAttributes,
  validateAttributes,
} from "../validation/entity.js";
import {
  graphDepthHistogram,
  traversalFanoutHistogram,
} from "../observability/metrics.js";
import { parseBool } from "./_query.js";

interface Deps {
  taxonomyRepo: TaxonomyRepo;
  entityRepo: EntityRepo;
}

type IdParams = { Params: { entity_id: string } };
type DataRoute = IdParams & {
  Querystring: {
    depth?: string;
    include_to_many?: string;
    format?: string;
  };
};

export function entityRoutes(deps: Deps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/entities", listEntities(deps));
    app.post("/entities", createEntity(deps));
    app.get<IdParams>("/entities/:entity_id", getEntity(deps));
    app.patch<IdParams>("/entities/:entity_id", patchEntity(deps));
    app.delete<IdParams>("/entities/:entity_id", deleteEntity(deps));
    app.get<DataRoute>("/entities/:entity_id/data", getEntityData(deps));
  };
}

function listEntities(deps: Deps) {
  return async (req: FastifyRequest) => {
    const query = req.query as Record<string, string | undefined>;
    const taxonomyId = query.taxonomy_id;
    if (!taxonomyId) {
      throw validationError("`taxonomy_id` query parameter is required");
    }
    const includeArchived = parseBool(query.include_archived, false);
    const exists = await deps.taxonomyRepo.get(taxonomyId);
    if (!exists) throw notFound("Taxonomy", taxonomyId);
    const data = await deps.entityRepo.listByTaxonomy(
      taxonomyId,
      includeArchived,
    );
    return { data };
  };
}

function createEntity(deps: Deps) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createEntitySchema.parse(req.body) as Entity;
    const taxonomy = await deps.taxonomyRepo.get(parsed.taxonomy_id);
    if (!taxonomy) throw notFound("Taxonomy", parsed.taxonomy_id);

    const existing = await deps.entityRepo.get(parsed.id);
    if (existing) {
      throw conflict(`Entity '${parsed.id}' already exists`, { id: parsed.id });
    }

    normalizeAttributes(parsed.attributes);
    validateAttributes(taxonomy, parsed.attributes, { requireAll: true });
    const created = await deps.entityRepo.upsert(parsed);
    return reply.status(201).send(created);
  };
}

function getEntity(deps: Deps) {
  return async (req: FastifyRequest<IdParams>) => {
    const found = await deps.entityRepo.get(req.params.entity_id);
    if (!found) throw notFound("Entity", req.params.entity_id);
    return found;
  };
}

function patchEntity(deps: Deps) {
  return async (req: FastifyRequest<IdParams>) => {
    const patch = patchEntitySchema.parse(req.body);
    const existing = await deps.entityRepo.get(req.params.entity_id);
    if (!existing) throw notFound("Entity", req.params.entity_id);

    // Normalize BEFORE the merge spread so the merged attributes carry
    // canonical NFC strings. If this ran after the spread, `merged` would
    // hold the client's raw (possibly NFD) bytes and the normalization
    // would only affect an unused `patch.attributes` reference.
    if (patch.attributes !== undefined) {
      normalizeAttributes(patch.attributes);
    }

    // Per contract `§ PATCH /entities/:entity_id`: provided attribute
    // keys MERGE into the existing map (not replace). `null` is a
    // legal value for non-required fields — explicit unset. `id`
    // and `taxonomy_id` are already rejected by the strict Zod
    // schema above, so we don't defend them again here.
    const merged: Entity = {
      ...existing,
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.attributes !== undefined
        ? { attributes: { ...existing.attributes, ...patch.attributes } }
        : {}),
    };
    if (patch.attributes !== undefined) {
      const taxonomy = await deps.taxonomyRepo.get(existing.taxonomy_id);
      if (!taxonomy) throw notFound("Taxonomy", existing.taxonomy_id);
      // requireAll: false — PATCH only validates keys that were sent,
      // not the full attribute set. Type matching + unknown-key
      // rejection still apply.
      validateAttributes(taxonomy, patch.attributes, { requireAll: false });
    }
    return deps.entityRepo.upsert(merged);
  };
}

function deleteEntity(deps: Deps) {
  return async (req: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const existing = await deps.entityRepo.get(req.params.entity_id);
    if (!existing) throw notFound("Entity", req.params.entity_id);
    await deps.entityRepo.delete(req.params.entity_id);
    return reply.status(204).send();
  };
}

function getEntityData(deps: Deps) {
  return async (req: FastifyRequest<DataRoute>) => {
    const depth = req.query.depth ? Number.parseInt(req.query.depth, 10) : 2;
    if (!Number.isInteger(depth) || depth < 1) {
      throw validationError("`depth` must be an integer >= 1");
    }
    if (depth > MAX_DEPTH) {
      throw validationError(`\`depth\` must be <= ${MAX_DEPTH}`, {
        max_depth: MAX_DEPTH,
      });
    }
    graphDepthHistogram.record(depth, { endpoint: "data" });

    const includeToMany = parseBool(req.query.include_to_many, false);
    const format = req.query.format ?? "nested";
    if (format !== "nested" && format !== "flat") {
      throw validationError("`format` must be 'nested' or 'flat'");
    }
    const existing = await deps.entityRepo.get(req.params.entity_id);
    if (!existing) throw notFound("Entity", req.params.entity_id);

    // Still need every taxonomy — traversal walks taxonomy schemas to
    // know which relationships to follow. Taxonomies are small (O(T));
    const allTaxonomies = await deps.taxonomyRepo.list(true);

    const result = await traverseEntityData({
      root: existing,
      depth,
      includeToMany,
      format,
      taxonomiesById: new Map(allTaxonomies.map((t) => [t.id, t])),
      fetcher: new DbEntityFetcher(deps.entityRepo),
    });
    traversalFanoutHistogram.record(result.visitedCount, { endpoint: "data" });

    // The visitedCount field is internal instrumentation, not part of the
    // public contract. Strip it before serializing to the client.
    const { visitedCount: _visitedCount, ...payload } = result;
    return payload;
  };
}
