import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";
import { buildServer } from "../server.js";
import { DATABASE_URL, setupTestDb, truncateAll } from "../test/testDb.js";
import { TaxonomyRepo } from "../repositories/taxonomyRepo.js";
import type { Taxonomy } from "../shared/index.js";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

const clinics: Taxonomy = {
  id: "clinics",
  name: "Clinics",
  archived: false,
  fields: [
    { key: "clinic_code", type: "string", required: true, is_key: true },
    { key: "name", type: "string", required: true, is_key: false },
  ],
  relationships: [],
};

const careTeams: Taxonomy = {
  id: "care_teams",
  name: "Care Teams",
  archived: false,
  fields: [
    { key: "team_code", type: "string", required: true, is_key: true },
    { key: "clinic_code", type: "string", required: true, is_key: false },
  ],
  relationships: [
    {
      key: "clinic",
      target_taxonomy_id: "clinics",
      cardinality: "to_one",
      match: [{ source_field: "clinic_code", target_field: "clinic_code" }],
    },
  ],
};

const patients: Taxonomy = {
  id: "patients",
  name: "Patients",
  archived: false,
  fields: [
    { key: "patient_number", type: "string", required: true, is_key: true },
    { key: "care_team_code", type: "string", required: true, is_key: false },
  ],
  relationships: [
    {
      key: "care_team",
      target_taxonomy_id: "care_teams",
      cardinality: "to_one",
      match: [{ source_field: "care_team_code", target_field: "team_code" }],
    },
  ],
};

runOrSkip("GET /taxonomies/:id/relationship-graph (integration)", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let taxRepo: TaxonomyRepo;

  beforeAll(async () => {
    handle = await setupTestDb();
    app = buildServer({ db: handle.db, logger: false });
    await app.ready();
    taxRepo = new TaxonomyRepo(handle.db);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  beforeEach(async () => {
    await truncateAll(handle);
    await taxRepo.upsert(clinics);
    await taxRepo.upsert(careTeams);
    await taxRepo.upsert(patients);
  });

  it("returns 404 for a missing taxonomy", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/ghost/relationship-graph",
    });
    expect(res.statusCode).toBe(404);
  });

  it("defaults depth to 2", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/patients/relationship-graph",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      depth: number;
      graph: Record<string, unknown>;
    };
    expect(body.depth).toBe(2);
    expect(body.graph.care_team).toBeDefined();
    expect(
      (body.graph.care_team as { clinic?: unknown }).clinic,
    ).toBeUndefined();
  });

  it("respects depth=3 by including two hops", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/patients/relationship-graph?depth=3",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      graph: { care_team: { clinic: { name: string; taxonomy_id: string } } };
    };
    expect(body.graph.care_team.clinic.name).toBe("string");
    expect(body.graph.care_team.clinic.taxonomy_id).toBe("clinics");
  });

  it("depth=1 returns root fields only", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/patients/relationship-graph?depth=1",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      graph: Record<string, unknown>;
    };
    expect(body.graph.patient_number).toBe("string");
    expect(body.graph.care_team).toBeUndefined();
  });

  it("rejects depth=0 with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/patients/relationship-graph?depth=0",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-integer depth with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/patients/relationship-graph?depth=abc",
    });
    expect(res.statusCode).toBe(400);
  });

  it("omits relationships whose target is archived", async () => {
    await taxRepo.upsert({ ...careTeams, archived: true });
    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/patients/relationship-graph?depth=2",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { graph: Record<string, unknown> };
    expect(body.graph.care_team).toBeUndefined();
  });

  it("terminates on mutual cycles without looping forever", async () => {
    await truncateAll(handle);
    await taxRepo.upsert({
      id: "a",
      name: "A",
      archived: false,
      fields: [{ key: "k", type: "string", required: true, is_key: true }],
      relationships: [
        {
          key: "b",
          target_taxonomy_id: "b",
          cardinality: "to_one",
          match: [{ source_field: "k", target_field: "k" }],
        },
      ],
    });
    await taxRepo.upsert({
      id: "b",
      name: "B",
      archived: false,
      fields: [{ key: "k", type: "string", required: true, is_key: true }],
      relationships: [
        {
          key: "a",
          target_taxonomy_id: "a",
          cardinality: "to_one",
          match: [{ source_field: "k", target_field: "k" }],
        },
      ],
    });

    // Depth well above the cycle length; cycle guard is what terminates,
    // not the depth cap. Stays within MAX_DEPTH so the route accepts it.
    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/a/relationship-graph?depth=25",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      graph: { b?: { a?: unknown } };
    };
    expect(body.graph.b).toBeDefined();
    // Second visit to "a" is cut off by the cycle guard
    expect(body.graph.b?.a).toBeUndefined();
  });
});
