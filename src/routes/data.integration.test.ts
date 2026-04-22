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
import { EntityRepo } from "../repositories/entityRepo.js";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

runOrSkip(
  "GET /entities/:id/data (integration, against public fixtures)",
  () => {
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

    it("returns 404 for an unknown entity", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/entities/does-not-exist/data",
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects depth=0 with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/entities/patient-1001/data?depth=0",
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unknown format with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/entities/patient-1001/data?format=weird",
      });
      expect(res.statusCode).toBe(400);
    });

    it("depth=1 returns only root attributes and root id (nested)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/entities/patient-1001/data?depth=1",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        entity_id: string;
        taxonomy_id: string;
        data: Record<string, unknown>;
      };
      expect(body.entity_id).toBe("patient-1001");
      expect(body.taxonomy_id).toBe("patients");
      expect(body.data.id).toBe("patient-1001");
      // No relationship keys
      expect(body.data.care_team).toBeUndefined();
      expect(body.data.support_tickets).toBeUndefined();
    });

    it("nested depth=3 follows two to_one hops end to end", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/entities/patient-1001/data?depth=3&format=nested",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        data: {
          care_team: { assigned_nurse: string; clinic: { name: string } };
        };
      };
      expect(body.data.care_team.assigned_nurse).toBe("Nurse Joy");
      expect(body.data.care_team.clinic.name).toBe("South Loop Clinic");
    });

    it("omits to_many by default, includes it when include_to_many=true", async () => {
      const without = await app.inject({
        method: "GET",
        url: "/entities/patient-1001/data?depth=2",
      });
      const withBody = (
        await app.inject({
          method: "GET",
          url: "/entities/patient-1001/data?depth=2&include_to_many=true",
        })
      ).json() as {
        data: Record<string, unknown>;
      };

      const withoutBody = without.json() as { data: Record<string, unknown> };
      expect(withoutBody.data.support_tickets).toBeUndefined();
      expect(Array.isArray(withBody.data.support_tickets)).toBe(true);
    });

    it("to_many arrays exclude archived and sort by id asc", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/entities/patient-1001/data?depth=2&include_to_many=true",
      });
      const body = res.json() as {
        data: { support_tickets: Array<{ id: string }> };
      };
      const ids = body.data.support_tickets.map((t) => t.id);
      expect(ids).toEqual([...ids].sort());
      // none archived
      expect(ids.every((id) => !id.includes("archived"))).toBe(true);
    });

    it("flat format emits dot-notation and numeric array indices", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/entities/patient-1001/data?depth=2&format=flat&include_to_many=true",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        data: Record<string, unknown>;
      };
      expect(body.data.id).toBe("patient-1001");
      expect(body.data["care_team.id"]).toBeDefined();
      expect(body.data["support_tickets.0.id"]).toBeDefined();
      expect(body.data["support_tickets.0.status"]).toBeDefined();
    });

    it("returns 409 when a to_one relationship is ambiguous", async () => {
      // Clone care-team-red under a new id so patient-1001.care_team now has two
      // matches via care_team_code == "TEAM-RED" / team_code == "TEAM-RED".
      const entRepo = new EntityRepo(handle.db);
      await entRepo.upsert({
        id: "care-team-duplicate",
        taxonomy_id: "care_teams",
        archived: false,
        attributes: {
          team_code: "TEAM-RED",
          assigned_nurse: "Nurse Clone",
          clinic_code: "CLINIC-SOUTH",
          on_call: false,
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/entities/patient-1001/data?depth=2",
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe("conflict");
    });
  },
);
