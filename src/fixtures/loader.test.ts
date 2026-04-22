import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  DATABASE_URL,
  PUBLIC_FIXTURES,
  setupTestDb,
  truncateAll,
} from "../test/testDb.js";
import { loadFixtures } from "./loader.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import { EntityRepo } from "../repositories/entityRepo.js";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

async function mkTempFixtureDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aviary-fixtures-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

runOrSkip("loadFixtures", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await setupTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await truncateAll(handle);
  });

  it("loads public fixtures into the database", async () => {
    await loadFixtures({ db: handle.db, fixtureDir: PUBLIC_FIXTURES });
    const repo = new TaxonomyRepo(handle.db);
    const all = await repo.list(true);
    expect(all.length).toBeGreaterThan(0);
    expect(all.map((t) => t.id)).toContain("patients");
  });

  it("seeds both taxonomies and entities", async () => {
    await loadFixtures({ db: handle.db, fixtureDir: PUBLIC_FIXTURES });
    const entRepo = new EntityRepo(handle.db);
    const patients = await entRepo.listByTaxonomy("patients", true);
    expect(patients.length).toBeGreaterThan(0);
  });

  it("is idempotent when run twice", async () => {
    await loadFixtures({ db: handle.db, fixtureDir: PUBLIC_FIXTURES });
    await loadFixtures({ db: handle.db, fixtureDir: PUBLIC_FIXTURES });
    const repo = new TaxonomyRepo(handle.db);
    const all = await repo.list(true);
    const ids = all.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("edge cases", () => {
    let tempDirs: string[] = [];

    afterEach(async () => {
      for (const dir of tempDirs) {
        await fs.rm(dir, { recursive: true, force: true });
      }
      tempDirs = [];
    });

    it("logs and skips when FIXTURE_DIR is empty", async () => {
      const empty = await fs.mkdtemp(path.join(os.tmpdir(), "aviary-empty-"));
      tempDirs.push(empty);
      await expect(
        loadFixtures({ db: handle.db, fixtureDir: empty }),
      ).resolves.toBeUndefined();
      const repo = new TaxonomyRepo(handle.db);
      expect(await repo.list(true)).toEqual([]);
    });

    it("does not crash when FIXTURE_DIR does not exist", async () => {
      const missing = path.join(
        os.tmpdir(),
        "aviary-never-created-" + Date.now(),
      );
      await expect(
        loadFixtures({ db: handle.db, fixtureDir: missing }),
      ).resolves.toBeUndefined();
    });

    it("throws when taxonomies.json is malformed JSON", async () => {
      const dir = await mkTempFixtureDir({
        "taxonomies.json": "{ this is not valid json",
      });
      tempDirs.push(dir);
      await expect(
        loadFixtures({ db: handle.db, fixtureDir: dir }),
      ).rejects.toThrow();
    });

    it("throws when a fixture contains an unsupported field type", async () => {
      const dir = await mkTempFixtureDir({
        "taxonomies.json": JSON.stringify([
          {
            id: "bad",
            name: "Bad",
            archived: false,
            fields: [
              { key: "spec", type: "object", required: true, is_key: true },
            ],
            relationships: [],
          },
        ]),
      });
      tempDirs.push(dir);
      await expect(
        loadFixtures({ db: handle.db, fixtureDir: dir }),
      ).rejects.toThrow();
    });

    it("throws when an entity attribute is a nested object in a fixture", async () => {
      const dir = await mkTempFixtureDir({
        "taxonomies.json": JSON.stringify([
          {
            id: "ok",
            name: "OK",
            archived: false,
            fields: [
              { key: "k", type: "string", required: true, is_key: true },
            ],
            relationships: [],
          },
        ]),
        "entities.json": JSON.stringify([
          {
            id: "e1",
            taxonomy_id: "ok",
            archived: false,
            attributes: { k: { nested: true } },
          },
        ]),
      });
      tempDirs.push(dir);
      await expect(
        loadFixtures({ db: handle.db, fixtureDir: dir }),
      ).rejects.toThrow();
    });

    it("throws when a fixture taxonomy has duplicate field keys", async () => {
      const dir = await mkTempFixtureDir({
        "taxonomies.json": JSON.stringify([
          {
            id: "dup",
            name: "Dup",
            archived: false,
            fields: [
              { key: "a", type: "string", required: true, is_key: true },
              { key: "a", type: "integer", required: false, is_key: false },
            ],
            relationships: [],
          },
        ]),
      });
      tempDirs.push(dir);
      const err = await loadFixtures({ db: handle.db, fixtureDir: dir }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(JSON.stringify(err.details ?? err.message)).toContain(
        "Duplicate field key",
      );
    });

    it("throws when a relationship points at an unknown target taxonomy", async () => {
      const dir = await mkTempFixtureDir({
        "taxonomies.json": JSON.stringify([
          {
            id: "src",
            name: "Src",
            archived: false,
            fields: [
              { key: "k", type: "string", required: true, is_key: true },
            ],
            relationships: [
              {
                key: "ghost",
                target_taxonomy_id: "does_not_exist",
                cardinality: "to_one",
                match: [{ source_field: "k", target_field: "k" }],
              },
            ],
          },
        ]),
      });
      tempDirs.push(dir);
      const err = await loadFixtures({ db: handle.db, fixtureDir: dir }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(JSON.stringify(err.details ?? err.message)).toContain(
        "does_not_exist",
      );
    });

    it("throws when a to_many_through chain has a cycle", async () => {
      const dir = await mkTempFixtureDir({
        "taxonomies.json": JSON.stringify([
          {
            id: "cycle",
            name: "Cycle",
            archived: false,
            fields: [
              { key: "k", type: "string", required: true, is_key: true },
            ],
            relationships: [
              {
                key: "a",
                target_taxonomy_id: "cycle",
                cardinality: "to_many_through",
                through: ["b"],
              },
              {
                key: "b",
                target_taxonomy_id: "cycle",
                cardinality: "to_many_through",
                through: ["a"],
              },
            ],
          },
        ]),
      });
      tempDirs.push(dir);
      const err = await loadFixtures({ db: handle.db, fixtureDir: dir }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(JSON.stringify(err.details ?? err.message)).toContain("Circular");
    });

    it("throws when an entity references a taxonomy that isn't in the fixture or DB", async () => {
      const dir = await mkTempFixtureDir({
        "entities.json": JSON.stringify([
          {
            id: "orphan",
            taxonomy_id: "ghost_taxonomy",
            archived: false,
            attributes: { any: "thing" },
          },
        ]),
      });
      tempDirs.push(dir);
      await expect(
        loadFixtures({ db: handle.db, fixtureDir: dir }),
      ).rejects.toThrow(/ghost_taxonomy/);
    });

    it("throws when an entity's attribute value does not match the field type", async () => {
      const dir = await mkTempFixtureDir({
        "taxonomies.json": JSON.stringify([
          {
            id: "typed",
            name: "Typed",
            archived: false,
            fields: [
              { key: "k", type: "string", required: true, is_key: true },
              { key: "count", type: "integer", required: true, is_key: false },
            ],
            relationships: [],
          },
        ]),
        "entities.json": JSON.stringify([
          {
            id: "e1",
            taxonomy_id: "typed",
            archived: false,
            // count is a string, not an integer
            attributes: { k: "K", count: "forty-two" },
          },
        ]),
      });
      tempDirs.push(dir);
      await expect(
        loadFixtures({ db: handle.db, fixtureDir: dir }),
      ).rejects.toThrow();
    });

    it("seeds nothing when any fixture fails validation", async () => {
      // One good taxonomy + one entity that type-mismatches
      const dir = await mkTempFixtureDir({
        "taxonomies.json": JSON.stringify([
          {
            id: "all_or_nothing",
            name: "AON",
            archived: false,
            fields: [
              { key: "k", type: "string", required: true, is_key: true },
              { key: "n", type: "integer", required: true, is_key: false },
            ],
            relationships: [],
          },
        ]),
        "entities.json": JSON.stringify([
          {
            id: "e1",
            taxonomy_id: "all_or_nothing",
            archived: false,
            attributes: { k: "ok", n: 1 },
          },
          {
            // This one is broken; loader must not commit anything.
            id: "e2",
            taxonomy_id: "all_or_nothing",
            archived: false,
            attributes: { k: "ok", n: "nope" },
          },
        ]),
      });
      tempDirs.push(dir);
      await expect(
        loadFixtures({ db: handle.db, fixtureDir: dir }),
      ).rejects.toThrow();
      // No taxonomies or entities seeded
      const repo = new TaxonomyRepo(handle.db);
      expect(await repo.list(true)).toEqual([]);
    });
  });
});
