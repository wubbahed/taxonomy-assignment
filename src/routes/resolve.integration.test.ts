import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client.js";
import { buildServer } from "../server.js";
import {
  DATABASE_URL,
  PUBLIC_FIXTURES,
  setupTestDb,
  truncateAll,
} from "../test/testDb.js";
import { loadFixtures } from "../fixtures/loader.js";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

runOrSkip("POST /resolve (integration, against public fixtures)", () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = await setupTestDb();
    app = buildServer({ db: handle.db, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  beforeEach(async () => {
    await truncateAll(handle);
    await loadFixtures({ db: handle.db, fixtureDir: PUBLIC_FIXTURES });
  });

  it("returns 404 when the entity does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/resolve",
      payload: { entity_id: "ghost-entity", paths: ["anything"] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an empty paths array with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/resolve",
      payload: { entity_id: "patient-1001", paths: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("resolves mixed direct/to_one/to_many/to_many_through paths in one call", async () => {
    // patient-1001 from fixtures:
    //   first_name = "John"
    //   care_team_code = "TEAM-RED"   -> care_team = care-team-red
    //     assigned_nurse = "Nurse Joy"
    //     clinic_code = "CLINIC-SOUTH" -> clinic = clinic-south
    //       name = "South Loop Clinic"
    //   current_program_key = "PROG-A" -> current_enrollment = enrollment for P1001+PROG-A
    //     coaching_sessions (to_many) -> two sessions (non-archived)
    //   support_tickets (to_many via patient_number == "P1001")
    const res = await app.inject({
      method: "POST",
      url: "/resolve",
      payload: {
        entity_id: "patient-1001",
        paths: [
          "first_name",
          "care_team.assigned_nurse",
          "care_team.clinic.name",
          "support_tickets.status",
          "current_enrollment.assigned_coach",
          "coaching_sessions.engagement_score",
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entity_id: string;
      values: Record<string, unknown>;
      errors: Record<string, unknown>;
    };
    expect(body.entity_id).toBe("patient-1001");
    expect(body.errors).toEqual({});
    expect(body.values.first_name).toBe("John");
    expect(body.values["care_team.assigned_nurse"]).toBe("Nurse Joy");
    expect(body.values["care_team.clinic.name"]).toBe("South Loop Clinic");

    // Arrays: sorted by related entity id ascending, archived entries excluded
    expect(Array.isArray(body.values["support_tickets.status"])).toBe(true);
    expect(
      (body.values["support_tickets.status"] as unknown[]).length,
    ).toBeGreaterThan(0);
    expect(
      Array.isArray(body.values["coaching_sessions.engagement_score"]),
    ).toBe(true);
  });

  it("emits per-path errors in `errors` and never populates `values` for those paths", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/resolve",
      payload: {
        entity_id: "patient-1001",
        paths: ["first_name", "care_team.unknown_field"],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      values: Record<string, unknown>;
      errors: Record<string, { code: string; message: string }>;
    };
    expect(body.values.first_name).toBe("John");
    expect("care_team.unknown_field" in body.values).toBe(false);
    expect(body.errors["care_team.unknown_field"]?.code).toBe(
      "field_not_found",
    );
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/resolve",
      payload: {}, // missing entity_id and paths
    });
    expect(res.statusCode).toBe(400);
  });
});
