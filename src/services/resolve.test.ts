import { describe, expect, it } from "vitest";
import type { Entity, Taxonomy } from "../shared/index.js";
import { resolvePaths } from "./resolve.js";
import { InMemoryEntityFetcher } from "./entityFetcher.js";

/** Test wrapper: accepts the old-shape call (entityId + entitiesById Map)
 *  and adapts it to the new async signature backed by InMemoryEntityFetcher.
 *  Keeps existing test cases readable without rewriting their fixture setup. */
async function callResolve(args: {
  entityId: string;
  paths: string[];
  entitiesById: Map<string, Entity>;
  taxonomiesById: Map<string, Taxonomy>;
}) {
  const root = args.entitiesById.get(args.entityId);
  if (!root)
    throw new Error(`callResolve: unknown entityId '${args.entityId}'`);
  return resolvePaths({
    root,
    paths: args.paths,
    taxonomiesById: args.taxonomiesById,
    fetcher: new InMemoryEntityFetcher([...args.entitiesById.values()]),
  });
}

// Reuse the shape from the contract example: patients -> care_teams -> clinics,
// plus support_tickets and a coaching_sessions through-chain.

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
    { key: "assigned_nurse", type: "string", required: true, is_key: false },
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

const enrollments: Taxonomy = {
  id: "program_enrollments",
  name: "Program Enrollments",
  archived: false,
  fields: [
    { key: "enrollment_key", type: "string", required: true, is_key: true },
    { key: "patient_number", type: "string", required: true, is_key: false },
    { key: "program_key", type: "string", required: true, is_key: false },
    { key: "assigned_coach", type: "string", required: true, is_key: false },
  ],
  relationships: [
    {
      key: "coaching_sessions",
      target_taxonomy_id: "coaching_sessions",
      cardinality: "to_many",
      match: [
        { source_field: "enrollment_key", target_field: "enrollment_key" },
      ],
    },
  ],
};

const coachingSessions: Taxonomy = {
  id: "coaching_sessions",
  name: "Coaching Sessions",
  archived: false,
  fields: [
    { key: "session_key", type: "string", required: true, is_key: true },
    { key: "enrollment_key", type: "string", required: true, is_key: false },
    { key: "engagement_score", type: "float", required: true, is_key: false },
  ],
  relationships: [],
};

const supportTickets: Taxonomy = {
  id: "support_tickets",
  name: "Support Tickets",
  archived: false,
  fields: [
    { key: "ticket_number", type: "string", required: true, is_key: true },
    { key: "patient_number", type: "string", required: true, is_key: false },
    { key: "status", type: "string", required: true, is_key: false },
  ],
  relationships: [],
};

const patients: Taxonomy = {
  id: "patients",
  name: "Patients",
  archived: false,
  fields: [
    { key: "patient_number", type: "string", required: true, is_key: true },
    { key: "first_name", type: "string", required: true, is_key: false },
    { key: "care_team_code", type: "string", required: true, is_key: false },
    {
      key: "current_program_key",
      type: "string",
      required: false,
      is_key: false,
    },
  ],
  relationships: [
    {
      key: "care_team",
      target_taxonomy_id: "care_teams",
      cardinality: "to_one",
      match: [{ source_field: "care_team_code", target_field: "team_code" }],
    },
    {
      key: "current_enrollment",
      target_taxonomy_id: "program_enrollments",
      cardinality: "to_one",
      match: [
        { source_field: "patient_number", target_field: "patient_number" },
        { source_field: "current_program_key", target_field: "program_key" },
      ],
    },
    {
      key: "support_tickets",
      target_taxonomy_id: "support_tickets",
      cardinality: "to_many",
      match: [
        { source_field: "patient_number", target_field: "patient_number" },
      ],
    },
    {
      key: "coaching_sessions",
      target_taxonomy_id: "coaching_sessions",
      cardinality: "to_many_through",
      through: ["current_enrollment", "coaching_sessions"],
    },
  ],
};

const taxonomiesById = new Map<string, Taxonomy>([
  ["clinics", clinics],
  ["care_teams", careTeams],
  ["program_enrollments", enrollments],
  ["coaching_sessions", coachingSessions],
  ["patients", patients],
  ["support_tickets", supportTickets],
]);

// --- entity fixtures --------------------------------------------------------

const southClinic: Entity = {
  id: "clinic-south",
  taxonomy_id: "clinics",
  archived: false,
  attributes: { clinic_code: "CLINIC-SOUTH", name: "South Loop Clinic" },
};

const redTeam: Entity = {
  id: "care-team-red",
  taxonomy_id: "care_teams",
  archived: false,
  attributes: {
    team_code: "TEAM-RED",
    assigned_nurse: "Nurse Joy",
    clinic_code: "CLINIC-SOUTH",
  },
};

const enrollmentA: Entity = {
  id: "enrollment-a",
  taxonomy_id: "program_enrollments",
  archived: false,
  attributes: {
    enrollment_key: "ENR-A",
    patient_number: "P1001",
    program_key: "PROG-A",
    assigned_coach: "Coach Lee",
  },
};

const session1: Entity = {
  id: "session-1",
  taxonomy_id: "coaching_sessions",
  archived: false,
  attributes: {
    session_key: "S1",
    enrollment_key: "ENR-A",
    engagement_score: 0.82,
  },
};
const session2: Entity = {
  id: "session-2",
  taxonomy_id: "coaching_sessions",
  archived: false,
  attributes: {
    session_key: "S2",
    enrollment_key: "ENR-A",
    engagement_score: 0.74,
  },
};

const ticket1: Entity = {
  id: "ticket-1",
  taxonomy_id: "support_tickets",
  archived: false,
  attributes: { ticket_number: "T1", patient_number: "P1001", status: "open" },
};
const ticket2: Entity = {
  id: "ticket-2",
  taxonomy_id: "support_tickets",
  archived: false,
  attributes: {
    ticket_number: "T2",
    patient_number: "P1001",
    status: "pending",
  },
};

const patient1001: Entity = {
  id: "patient-1001",
  taxonomy_id: "patients",
  archived: false,
  attributes: {
    patient_number: "P1001",
    first_name: "John",
    care_team_code: "TEAM-RED",
    current_program_key: "PROG-A",
  },
};

const entitiesById = new Map<string, Entity>([
  [southClinic.id, southClinic],
  [redTeam.id, redTeam],
  [enrollmentA.id, enrollmentA],
  [session1.id, session1],
  [session2.id, session2],
  [ticket1.id, ticket1],
  [ticket2.id, ticket2],
  [patient1001.id, patient1001],
]);

// --- tests ------------------------------------------------------------------

describe("resolvePaths", () => {
  it("resolves a direct field path to a scalar", async () => {
    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["first_name"],
      entitiesById,
      taxonomiesById,
    });
    expect(res.values).toEqual({ first_name: "John" });
    expect(res.errors).toEqual({});
  });

  it("resolves a to_one chain to a scalar", async () => {
    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["care_team.assigned_nurse", "care_team.clinic.name"],
      entitiesById,
      taxonomiesById,
    });
    expect(res.values).toEqual({
      "care_team.assigned_nurse": "Nurse Joy",
      "care_team.clinic.name": "South Loop Clinic",
    });
  });

  it("returns an array for a to_many path, sorted by target id", async () => {
    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["support_tickets.status"],
      entitiesById,
      taxonomiesById,
    });
    expect(res.values["support_tickets.status"]).toEqual(["open", "pending"]);
  });

  it("returns an array for a to_many_through path, sorted by terminal id", async () => {
    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["coaching_sessions.engagement_score"],
      entitiesById,
      taxonomiesById,
    });
    expect(res.values["coaching_sessions.engagement_score"]).toEqual([
      0.82, 0.74,
    ]);
  });

  it("returns null for a to_one chain whose first hop has no match", async () => {
    const orphan: Entity = {
      ...patient1001,
      id: "patient-orphan",
      attributes: { ...patient1001.attributes, care_team_code: "TEAM-NOPE" },
    };
    const altById = new Map(entitiesById);
    altById.set(orphan.id, orphan);

    const res = await callResolve({
      entityId: orphan.id,
      paths: ["care_team.assigned_nurse"],
      entitiesById: altById,
      taxonomiesById,
    });
    expect(res.values).toEqual({ "care_team.assigned_nurse": null });
    expect(res.errors).toEqual({});
  });

  it("returns [] when a to_many path finds no matches", async () => {
    const stranger: Entity = {
      ...patient1001,
      id: "patient-stranger",
      attributes: { ...patient1001.attributes, patient_number: "P9999" },
    };
    const altById = new Map(entitiesById);
    altById.set(stranger.id, stranger);

    const res = await callResolve({
      entityId: stranger.id,
      paths: ["support_tickets.status"],
      entitiesById: altById,
      taxonomiesById,
    });
    expect(res.values["support_tickets.status"]).toEqual([]);
  });

  it("treats archived related entities as missing", async () => {
    const archivedTicket: Entity = {
      ...ticket1,
      id: "ticket-arch",
      archived: true,
    };
    const altById = new Map(entitiesById);
    altById.set(archivedTicket.id, archivedTicket);

    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["support_tickets.status"],
      entitiesById: altById,
      taxonomiesById,
    });
    // archived ticket is excluded; live tickets still come through
    expect(res.values["support_tickets.status"]).toEqual(["open", "pending"]);
  });

  it("reports field_not_found for an unknown terminal", async () => {
    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["care_team.unknown_field"],
      entitiesById,
      taxonomiesById,
    });
    expect(res.values).toEqual({});
    expect(res.errors["care_team.unknown_field"]?.code).toBe("field_not_found");
    expect(res.errors["care_team.unknown_field"]?.message).toContain(
      "care_teams",
    );
  });

  it("reports relationship_not_found for an unknown non-terminal", async () => {
    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["phantom.name"],
      entitiesById,
      taxonomiesById,
    });
    expect(res.errors["phantom.name"]?.code).toBe("relationship_not_found");
  });

  it("reports invalid_path when terminal is a relationship key", async () => {
    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["care_team"],
      entitiesById,
      taxonomiesById,
    });
    expect(res.errors["care_team"]?.code).toBe("invalid_path");
  });

  it("reports invalid_path when a non-terminal segment is a field", async () => {
    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["first_name.ugh"],
      entitiesById,
      taxonomiesById,
    });
    expect(res.errors["first_name.ugh"]?.code).toBe("invalid_path");
  });

  it("reports invalid_path on an empty segment", async () => {
    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["care_team..clinic"],
      entitiesById,
      taxonomiesById,
    });
    expect(res.errors["care_team..clinic"]?.code).toBe("invalid_path");
  });

  it("returns partial success: mixes valid values with per-path errors", async () => {
    const res = await callResolve({
      entityId: "patient-1001",
      paths: [
        "first_name",
        "care_team.assigned_nurse",
        "care_team.unknown_field",
        "support_tickets.status",
      ],
      entitiesById,
      taxonomiesById,
    });
    expect(res.values.first_name).toBe("John");
    expect(res.values["care_team.assigned_nurse"]).toBe("Nurse Joy");
    expect(res.values["support_tickets.status"]).toEqual(["open", "pending"]);
    expect(res.errors["care_team.unknown_field"]).toBeDefined();
    // the failed path is NOT in values
    expect("care_team.unknown_field" in res.values).toBe(false);
  });

  it("reports ambiguous_to_one when a to_one path matches multiple entities", async () => {
    // Two care teams both claim the same team_code; the patient's to_one
    // care_team relationship now has two matches — ambiguity.
    const dupTeam: Entity = { ...redTeam, id: "care-team-duplicate" };
    const altById = new Map(entitiesById);
    altById.set(dupTeam.id, dupTeam);

    const res = await callResolve({
      entityId: "patient-1001",
      paths: ["care_team.assigned_nurse"],
      entitiesById: altById,
      taxonomiesById,
    });
    expect(res.errors["care_team.assigned_nurse"]?.code).toBe(
      "ambiguous_to_one",
    );
  });

  it("emits null when a terminal field key is missing from the attributes map", async () => {
    const gap: Entity = {
      ...redTeam,
      id: "care-team-gap",
      attributes: {
        team_code: "TEAM-GAP",
        // no assigned_nurse attribute set
        clinic_code: "CLINIC-SOUTH",
      },
    };
    const gapPatient: Entity = {
      ...patient1001,
      id: "patient-gap",
      attributes: { ...patient1001.attributes, care_team_code: "TEAM-GAP" },
    };
    const altById = new Map(entitiesById);
    altById.set(gap.id, gap);
    altById.set(gapPatient.id, gapPatient);

    const res = await callResolve({
      entityId: gapPatient.id,
      paths: ["care_team.assigned_nurse"],
      entitiesById: altById,
      taxonomiesById,
    });
    expect(res.values["care_team.assigned_nurse"]).toBeNull();
  });
});
