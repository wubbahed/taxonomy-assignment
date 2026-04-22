/**
 * Entity fetcher — the abstraction between traversal services and the
 * storage layer. Exists so `traverseEntityData` and `resolvePaths` can
 * walk the relationship graph lazily, per level, issuing targeted
 * queries instead of requiring the entire entity table to be loaded
 * upfront.
 *
 * There are two implementations:
 *  - `DbEntityFetcher` wraps `EntityRepo.findByAttributeProbes` and is
 *    what production routes use.
 *  - `InMemoryEntityFetcher` satisfies the same interface from a pre-
 *    loaded `Entity[]`. Tests use this so every existing test case
 *    keeps working without a real database; fixture-backed tests still
 *    get the production code path via the Db implementation.
 *
 * A probe is a partial attribute map. Matching is JSONB `@>` containment:
 * an entity matches iff every key of the probe is present on the entity
 * with the same scalar value. The fetcher contract is the same as the
 * repo method — see `entityRepo.findByAttributeProbes` for semantics.
 */

import type { AttributeValue, Entity } from "../shared/index.js";
import type { EntityRepo } from "../repositories/entityRepo.js";

export interface FetchOptions {
  includeArchived?: boolean;
  limit?: number;
}

export interface EntityFetcher {
  fetchMatching(
    taxonomyId: string,
    probes: Record<string, AttributeValue>[],
    opts?: FetchOptions,
  ): Promise<Entity[]>;
}

/** Production fetcher: delegates to the repo. */
export class DbEntityFetcher implements EntityFetcher {
  constructor(private readonly repo: EntityRepo) {}

  async fetchMatching(
    taxonomyId: string,
    probes: Record<string, AttributeValue>[],
    opts: FetchOptions = {},
  ): Promise<Entity[]> {
    return this.repo.findByAttributeProbes(taxonomyId, probes, opts);
  }
}

/** Test fetcher: filters an in-memory list with the same semantics as
 *  the SQL @> containment query. Keeps every traversal/resolve test in
 *  the suite working without needing a real database. */
export class InMemoryEntityFetcher implements EntityFetcher {
  constructor(private readonly entities: Entity[]) {}

  async fetchMatching(
    taxonomyId: string,
    probes: Record<string, AttributeValue>[],
    opts: FetchOptions = {},
  ): Promise<Entity[]> {
    if (probes.length === 0) return [];
    const includeArchived = opts.includeArchived ?? false;
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;

    const matches: Entity[] = [];
    for (const entity of this.entities) {
      if (entity.taxonomy_id !== taxonomyId) continue;
      if (!includeArchived && entity.archived) continue;
      if (!probes.some((p) => probeContains(entity, p))) continue;
      matches.push(entity);
      if (matches.length >= limit) break;
    }
    return matches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

/** A probe matches an entity iff every key in the probe is present on
 *  the entity with the same scalar value (JSONB `@>` semantics). */
function probeContains(
  entity: Entity,
  probe: Record<string, AttributeValue>,
): boolean {
  for (const [key, value] of Object.entries(probe)) {
    if (!(key in entity.attributes)) return false;
    if (entity.attributes[key] !== value) return false;
  }
  return true;
}
