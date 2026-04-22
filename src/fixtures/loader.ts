import fs from "node:fs/promises";
import path from "node:path";
import {
  fixtureEntityFileSchema,
  fixtureTaxonomyFileSchema,
  type Entity,
  type Taxonomy,
} from "../shared/index.js";
import type { Database } from "../db/client.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import { EntityRepo } from "../repositories/entityRepo.js";
import {
  validateTaxonomyReferences,
  validateTaxonomyStructure,
} from "../validation/taxonomy.js";
import {
  normalizeAttributes,
  validateAttributes,
} from "../validation/entity.js";

export interface LoadFixturesOptions {
  db: Database;
  fixtureDir: string;
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Load the fixture directory into the database.
 *
 * Validation is the same battery applied at the HTTP boundary:
 *  - Zod structural parse (field types, discriminated unions on relationships)
 *  - per-taxonomy `validateTaxonomyStructure` (field/rel key uniqueness,
 *    `to_many_through` first-hop existence, match source_field on self)
 *  - cross-taxonomy `validateTaxonomyReferences` (target exists, target_field
 *    exists, `to_many_through` chain is acyclic and lands at declared target)
 *  - per-entity `validateAttributes` with `requireAll: true` (every required
 *    field present, every value matches its declared type)
 *
 * A fixture file that fails any of these stages throws immediately — we seed
 * nothing rather than half-seed. Seeding otherwise is done in two passes
 * (all taxonomies, then all entities) so reference checks succeed even if
 * taxonomies reference each other.
 */
export async function loadFixtures(opts: LoadFixturesOptions): Promise<void> {
  const taxonomiesPath = path.join(opts.fixtureDir, "taxonomies.json");
  const entitiesPath = path.join(opts.fixtureDir, "entities.json");

  const rawTaxonomies = await readJsonIfExists(taxonomiesPath);
  const rawEntities = await readJsonIfExists(entitiesPath);

  if (rawTaxonomies === null && rawEntities === null) {
    console.warn(
      `[fixtures] no taxonomies.json or entities.json found in ${opts.fixtureDir}; skipping seed`,
    );
    return;
  }

  // --- parse + validate everything BEFORE touching the DB --------------------
  let taxonomies: Taxonomy[] = [];
  let entities: Entity[] = [];

  if (rawTaxonomies !== null) {
    taxonomies = fixtureTaxonomyFileSchema.parse(rawTaxonomies);
    const byId = new Map(taxonomies.map((t) => [t.id, t]));
    for (const taxonomy of taxonomies) {
      validateTaxonomyStructure(taxonomy);
      validateTaxonomyReferences(taxonomy, byId);
    }
  }

  if (rawEntities !== null) {
    entities = fixtureEntityFileSchema.parse(rawEntities);

    // We need the taxonomies by id to validate attributes against. If the
    // taxonomies file was absent, fall back to whatever is already in the DB.
    const taxonomiesById = await collectTaxonomies(taxonomies, opts.db);

    for (const entity of entities) {
      const taxonomy = taxonomiesById.get(entity.taxonomy_id);
      if (!taxonomy) {
        throw new Error(
          `[fixtures] entity '${entity.id}' references unknown taxonomy '${entity.taxonomy_id}'`,
        );
      }
      normalizeAttributes(entity.attributes);
      validateAttributes(taxonomy, entity.attributes, { requireAll: true });
    }
  }

  // --- everything parsed; seed in order --------------------------------------
  const taxonomyRepo = new TaxonomyRepo(opts.db);
  const entityRepo = new EntityRepo(opts.db);

  if (taxonomies.length > 0) {
    await taxonomyRepo.upsertMany(taxonomies);
    console.log(`[fixtures] seeded ${taxonomies.length} taxonomies`);
  }

  if (entities.length > 0) {
    await entityRepo.upsertMany(entities);
    console.log(`[fixtures] seeded ${entities.length} entities`);
  }
}

/** Merge fresh fixture taxonomies with whatever the DB already has, so
 *  entity validation works for "entities-only" fixture updates. */
async function collectTaxonomies(
  fresh: Taxonomy[],
  db: Database,
): Promise<Map<string, Taxonomy>> {
  const byId = new Map<string, Taxonomy>();
  if (fresh.length === 0) {
    const existing = await new TaxonomyRepo(db).list(true);
    for (const t of existing) byId.set(t.id, t);
  } else {
    for (const t of fresh) byId.set(t.id, t);
  }
  return byId;
}
