import { describe, expect, it } from "vitest";
import type { Entity, Taxonomy } from "../shared/index.js";
import { followRelationship, type TraversalContext } from "./relationships.js";
import { InMemoryEntityFetcher } from "./entityFetcher.js";

// ---- fixture taxonomies ----------------------------------------------------

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

const enrollments: Taxonomy = {
  id: "program_enrollments",
  name: "Program Enrollments",
  archived: false,
  fields: [
    { key: "enrollment_key", type: "string", required: true, is_key: true },
    { key: "patient_number", type: "string", required: true, is_key: false },
    { key: "program_key", type: "string", required: true, is_key: false },
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

const patients: Taxonomy = {
  id: "patients",
  name: "Patients",
  archived: false,
  fields: [
    { key: "patient_number", type: "string", required: true, is_key: true },
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

const taxonomiesById = new Map<string, Taxonomy>([
  ["clinics", clinics],
  ["care_teams", careTeams],
  ["program_enrollments", enrollments],
  ["coaching_sessions", coachingSessions],
  ["patients", patients],
  ["support_tickets", supportTickets],
]);

// ---- fixture entities ------------------------------------------------------

const clinicSouth: Entity = {
  id: "clinic-south",
  taxonomy_id: "clinics",
  archived: false,
  attributes: { clinic_code: "CLINIC-SOUTH", name: "South Loop Clinic" },
};

const teamRed: Entity = {
  id: "care-team-red",
  taxonomy_id: "care_teams",
  archived: false,
  attributes: { team_code: "TEAM-RED", clinic_code: "CLINIC-SOUTH" },
};

const enrollment1: Entity = {
  id: "enrollment-1",
  taxonomy_id: "program_enrollments",
  archived: false,
  attributes: {
    enrollment_key: "ENR-1",
    patient_number: "P1001",
    program_key: "PROG-A",
  },
};

// Two coaching sessions for enrollment-1; intentionally out of id-order in the array.
const session2: Entity = {
  id: "session-2",
  taxonomy_id: "coaching_sessions",
  archived: false,
  attributes: {
    session_key: "S2",
    enrollment_key: "ENR-1",
    engagement_score: 0.74,
  },
};
const session1: Entity = {
  id: "session-1",
  taxonomy_id: "coaching_sessions",
  archived: false,
  attributes: {
    session_key: "S1",
    enrollment_key: "ENR-1",
    engagement_score: 0.82,
  },
};
const sessionArchived: Entity = {
  id: "session-archived",
  taxonomy_id: "coaching_sessions",
  archived: true,
  attributes: {
    session_key: "S-ARCH",
    enrollment_key: "ENR-1",
    engagement_score: 0.99,
  },
};

const patient1001: Entity = {
  id: "patient-1001",
  taxonomy_id: "patients",
  archived: false,
  attributes: {
    patient_number: "P1001",
    care_team_code: "TEAM-RED",
    current_program_key: "PROG-A",
  },
};

const ticketOpen: Entity = {
  id: "ticket-open",
  taxonomy_id: "support_tickets",
  archived: false,
  attributes: {
    ticket_number: "T1",
    patient_number: "P1001",
    status: "open",
  },
};
const ticketPending: Entity = {
  id: "ticket-pending",
  taxonomy_id: "support_tickets",
  archived: false,
  attributes: {
    ticket_number: "T2",
    patient_number: "P1001",
    status: "pending",
  },
};
const ticketArchived: Entity = {
  id: "ticket-archived",
  taxonomy_id: "support_tickets",
  archived: true,
  attributes: {
    ticket_number: "T3",
    patient_number: "P1001",
    status: "closed",
  },
};

function ctxOf(entities: Entity[]): TraversalContext {
  return {
    taxonomiesById,
    fetcher: new InMemoryEntityFetcher(entities),
  };
}

const baseEntities: Entity[] = [
  clinicSouth,
  teamRed,
  enrollment1,
  session2,
  session1,
  sessionArchived,
  patient1001,
  ticketPending,
  ticketOpen,
  ticketArchived,
];
const ctx: TraversalContext = ctxOf(baseEntities);

// ---- tests -----------------------------------------------------------------

describe("followRelationship — to_one", () => {
  it("returns the single match", async () => {
    const rel = patients.relationships.find((r) => r.key === "care_team")!;
    const result = await followRelationship(patient1001, rel, ctx);
    expect(result.map((e) => e.id)).toEqual(["care-team-red"]);
  });

  it("matches on multiple clauses (AND semantics)", async () => {
    const rel = patients.relationships.find(
      (r) => r.key === "current_enrollment",
    )!;
    const result = await followRelationship(patient1001, rel, ctx);
    expect(result.map((e) => e.id)).toEqual(["enrollment-1"]);
  });

  it("returns empty when a match clause field is null on the source", async () => {
    const orphan: Entity = {
      ...patient1001,
      id: "patient-orphan",
      attributes: { ...patient1001.attributes, current_program_key: null },
    };
    const rel = patients.relationships.find(
      (r) => r.key === "current_enrollment",
    )!;
    const result = await followRelationship(
      orphan,
      rel,
      ctxOf([...baseEntities, orphan]),
    );
    expect(result).toEqual([]);
  });

  it("does not match archived target entities", async () => {
    const archivedTeam: Entity = {
      ...teamRed,
      id: "care-team-archived",
      archived: true,
    };
    const rel = patients.relationships.find((r) => r.key === "care_team")!;
    const result = await followRelationship(
      patient1001,
      rel,
      ctxOf([archivedTeam, patient1001]),
    );
    expect(result).toEqual([]);
  });
});

describe("followRelationship — to_many", () => {
  it("returns all matches, sorted by id asc", async () => {
    const rel = patients.relationships.find(
      (r) => r.key === "support_tickets",
    )!;
    const result = await followRelationship(patient1001, rel, ctx);
    expect(result.map((e) => e.id)).toEqual(["ticket-open", "ticket-pending"]);
  });

  it("excludes archived target entities", async () => {
    const rel = patients.relationships.find(
      (r) => r.key === "support_tickets",
    )!;
    const result = await followRelationship(patient1001, rel, ctx);
    expect(result.map((e) => e.id)).not.toContain("ticket-archived");
  });

  it("returns [] when no targets match", async () => {
    const stranger: Entity = {
      ...patient1001,
      id: "patient-stranger",
      attributes: { ...patient1001.attributes, patient_number: "P9999" },
    };
    const rel = patients.relationships.find(
      (r) => r.key === "support_tickets",
    )!;
    const result = await followRelationship(stranger, rel, ctx);
    expect(result).toEqual([]);
  });
});

describe("followRelationship — to_many_through", () => {
  it("walks the through chain and returns the final hop's matches, sorted", async () => {
    const rel = patients.relationships.find(
      (r) => r.key === "coaching_sessions",
    )!;
    const result = await followRelationship(patient1001, rel, ctx);
    expect(result.map((e) => e.id)).toEqual(["session-1", "session-2"]);
  });

  it("filters archived entities at the final hop", async () => {
    const rel = patients.relationships.find(
      (r) => r.key === "coaching_sessions",
    )!;
    const result = await followRelationship(patient1001, rel, ctx);
    expect(result.map((e) => e.id)).not.toContain("session-archived");
  });

  it("returns [] when an intermediate hop has no matches", async () => {
    const stranger: Entity = {
      id: "patient-stranger",
      taxonomy_id: "patients",
      archived: false,
      attributes: {
        patient_number: "P9999",
        care_team_code: "TEAM-?",
        current_program_key: "PROG-?",
      },
    };
    const rel = patients.relationships.find(
      (r) => r.key === "coaching_sessions",
    )!;
    const result = await followRelationship(
      stranger,
      rel,
      ctxOf([...baseEntities, stranger]),
    );
    expect(result).toEqual([]);
  });
});

describe("followRelationship — stability", () => {
  it("deduplicates and returns results in ascending id order", async () => {
    // Craft a scenario where two different intermediate hops lead to the
    // same terminal entity: two enrollments both pointing at the same session.
    const enrollmentA: Entity = {
      id: "enr-a",
      taxonomy_id: "program_enrollments",
      archived: false,
      attributes: {
        enrollment_key: "SHARED",
        patient_number: "P-DEDUP",
        program_key: "P",
      },
    };
    const enrollmentB: Entity = {
      id: "enr-b",
      taxonomy_id: "program_enrollments",
      archived: false,
      attributes: {
        enrollment_key: "SHARED",
        patient_number: "P-DEDUP",
        program_key: "P",
      },
    };
    const sharedSession: Entity = {
      id: "session-shared",
      taxonomy_id: "coaching_sessions",
      archived: false,
      attributes: {
        session_key: "SHR",
        enrollment_key: "SHARED",
        engagement_score: 0.5,
      },
    };
    const dedupPatient: Entity = {
      id: "patient-dedup",
      taxonomy_id: "patients",
      archived: false,
      attributes: {
        patient_number: "P-DEDUP",
        care_team_code: "TEAM-X",
        current_program_key: "P",
      },
    };
    const rel = patients.relationships.find(
      (r) => r.key === "coaching_sessions",
    )!;
    const altCtx = ctxOf([
      enrollmentA,
      enrollmentB,
      sharedSession,
      dedupPatient,
    ]);
    const result = await followRelationship(dedupPatient, rel, altCtx);
    // Despite two enrollments matching, the session appears exactly once.
    expect(result.map((e) => e.id)).toEqual(["session-shared"]);
  });
});
