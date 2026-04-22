import { describe, expect, it } from "vitest";
import type { Entity, Taxonomy } from "../shared/index.js";
import { AppError } from "../errors.js";
import {
  countNodes,
  traverseEntityData,
  type DataNode,
  type FlatData,
} from "./traversal.js";
import { InMemoryEntityFetcher } from "./entityFetcher.js";

// --- taxonomy fixtures ------------------------------------------------------

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
const sessionArchived: Entity = {
  id: "session-archived",
  taxonomy_id: "coaching_sessions",
  archived: true,
  attributes: {
    session_key: "S-ARCH",
    enrollment_key: "ENR-A",
    engagement_score: 0.01,
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
  [sessionArchived.id, sessionArchived],
  [ticket1.id, ticket1],
  [ticket2.id, ticket2],
  [patient1001.id, patient1001],
]);

// --- helpers ----------------------------------------------------------------

interface BaseOverrides {
  entityId?: string;
  depth?: number;
  includeToMany?: boolean;
  format?: "nested" | "flat";
  entitiesById?: Map<string, Entity>;
  taxonomiesById?: Map<string, Taxonomy>;
}

function base(overrides: BaseOverrides = {}) {
  const entityId = overrides.entityId ?? "patient-1001";
  const byId = overrides.entitiesById ?? entitiesById;
  const root = byId.get(entityId);
  if (!root) throw new Error(`base(): unknown entityId '${entityId}'`);
  return traverseEntityData({
    root,
    depth: overrides.depth ?? 2,
    includeToMany: overrides.includeToMany ?? false,
    format: overrides.format ?? "nested",
    taxonomiesById: overrides.taxonomiesById ?? taxonomiesById,
    fetcher: new InMemoryEntityFetcher([...byId.values()]),
  });
}

// --- tests ------------------------------------------------------------------

describe("traverseEntityData — nested", () => {
  it("depth=1 returns root id + root attributes only", async () => {
    const res = await base({ depth: 1 });
    const data = res.data as DataNode;
    expect(res.entity_id).toBe("patient-1001");
    expect(res.taxonomy_id).toBe("patients");
    expect(data).toEqual({
      id: "patient-1001",
      patient_number: "P1001",
      first_name: "John",
      care_team_code: "TEAM-RED",
      current_program_key: "PROG-A",
    });
  });

  it("depth=2 nests a to_one hop with id + attributes", async () => {
    const res = await base({ depth: 2 });
    const data = res.data as DataNode;
    const careTeam = data.care_team as DataNode;
    expect(careTeam).toEqual({
      id: "care-team-red",
      team_code: "TEAM-RED",
      assigned_nurse: "Nurse Joy",
      clinic_code: "CLINIC-SOUTH",
    });
    // Second hop not traversed yet
    expect(careTeam.clinic).toBeUndefined();
  });

  it("depth=3 nests two to_one hops", async () => {
    const res = await base({ depth: 3 });
    const careTeam = (res.data as DataNode).care_team as DataNode;
    const clinic = careTeam.clinic as DataNode;
    expect(clinic).toEqual({
      id: "clinic-south",
      clinic_code: "CLINIC-SOUTH",
      name: "South Loop Clinic",
    });
  });

  it("to_one with no match serializes as null", async () => {
    const orphan: Entity = {
      ...patient1001,
      id: "patient-orphan",
      attributes: { ...patient1001.attributes, care_team_code: "TEAM-NOPE" },
    };
    const alt = new Map(entitiesById);
    alt.set(orphan.id, orphan);
    const res = await base({ entityId: orphan.id, entitiesById: alt });
    expect((res.data as DataNode).care_team).toBeNull();
  });

  it("to_many is omitted from nested output unless include_to_many=true", async () => {
    const without = await base({ depth: 2, includeToMany: false });
    expect((without.data as DataNode).support_tickets).toBeUndefined();
    expect((without.data as DataNode).coaching_sessions).toBeUndefined();

    const withIt = await base({ depth: 2, includeToMany: true });
    const data = withIt.data as DataNode;
    expect(Array.isArray(data.support_tickets)).toBe(true);
    expect(Array.isArray(data.coaching_sessions)).toBe(true);
  });

  it("to_many arrays are sorted by target id ascending and exclude archived", async () => {
    const res = await base({ depth: 2, includeToMany: true });
    const tickets = (res.data as DataNode).support_tickets as DataNode[];
    expect(tickets.map((t) => t.id)).toEqual(["ticket-1", "ticket-2"]);
  });

  it("to_many_through arrays exclude archived and sort by final hop id asc", async () => {
    const res = await base({ depth: 2, includeToMany: true });
    const sessions = (res.data as DataNode).coaching_sessions as DataNode[];
    expect(sessions.map((s) => s.id)).toEqual(["session-1", "session-2"]);
  });

  it("empty to_many at depth=2 with include_to_many=true is []", async () => {
    const stranger: Entity = {
      ...patient1001,
      id: "patient-stranger",
      attributes: { ...patient1001.attributes, patient_number: "P9999" },
    };
    const alt = new Map(entitiesById);
    alt.set(stranger.id, stranger);
    const res = await base({
      entityId: stranger.id,
      depth: 2,
      includeToMany: true,
      entitiesById: alt,
    });
    expect((res.data as DataNode).support_tickets).toEqual([]);
  });

  it("throws a 409 conflict when a to_one matches multiple entities", async () => {
    const dupTeam: Entity = { ...redTeam, id: "care-team-duplicate" };
    const alt = new Map(entitiesById);
    alt.set(dupTeam.id, dupTeam);
    try {
      await base({ entitiesById: alt });
      throw new Error("expected 409 conflict to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(409);
      expect((err as AppError).code).toBe("conflict");
    }
  });
});

describe("traverseEntityData — flat format", () => {
  it("uses dot-notation for nested to_one fields", async () => {
    const res = await base({ depth: 3, format: "flat" });
    const flat = res.data as FlatData;
    expect(flat.id).toBe("patient-1001");
    expect(flat.first_name).toBe("John");
    expect(flat["care_team.id"]).toBe("care-team-red");
    expect(flat["care_team.assigned_nurse"]).toBe("Nurse Joy");
    expect(flat["care_team.clinic.id"]).toBe("clinic-south");
    expect(flat["care_team.clinic.name"]).toBe("South Loop Clinic");
  });

  it("uses numeric indices for to_many arrays", async () => {
    const res = await base({ depth: 2, format: "flat", includeToMany: true });
    const flat = res.data as FlatData;
    expect(flat["support_tickets.0.id"]).toBe("ticket-1");
    expect(flat["support_tickets.0.status"]).toBe("open");
    expect(flat["support_tickets.1.id"]).toBe("ticket-2");
    expect(flat["support_tickets.1.status"]).toBe("pending");
  });

  it("omits to_one keys entirely when the relationship is null", async () => {
    const orphan: Entity = {
      ...patient1001,
      id: "patient-orphan",
      attributes: { ...patient1001.attributes, care_team_code: "TEAM-NOPE" },
    };
    const alt = new Map(entitiesById);
    alt.set(orphan.id, orphan);
    const res = await base({
      entityId: orphan.id,
      depth: 2,
      format: "flat",
      entitiesById: alt,
    });
    const flat = res.data as FlatData;
    expect("care_team" in flat).toBe(false);
    expect(Object.keys(flat).some((k) => k.startsWith("care_team."))).toBe(
      false,
    );
  });

  it("depth=1 flat output contains only root id + attributes", async () => {
    const res = await base({ depth: 1, format: "flat" });
    const flat = res.data as FlatData;
    expect(flat).toEqual({
      id: "patient-1001",
      patient_number: "P1001",
      first_name: "John",
      care_team_code: "TEAM-RED",
      current_program_key: "PROG-A",
    });
  });
});

describe("traverseEntityData — response envelope", () => {
  it("always emits entity_id and taxonomy_id at the top level", async () => {
    const res = await base();
    expect(res.entity_id).toBe("patient-1001");
    expect(res.taxonomy_id).toBe("patients");
  });
});

describe("countNodes", () => {
  it("counts a leaf-only node as 1", () => {
    const node: DataNode = { id: "x", name: "solo" };
    expect(countNodes(node)).toBe(1);
  });

  it("ignores null to_one branches", () => {
    const node: DataNode = { id: "x", care_team: null };
    expect(countNodes(node)).toBe(1);
  });

  it("counts to_one hops recursively", () => {
    const node: DataNode = {
      id: "p1",
      care_team: { id: "t1", clinic: { id: "c1" } },
    };
    expect(countNodes(node)).toBe(3);
  });

  it("counts every entity in a to_many array", () => {
    const node: DataNode = {
      id: "t1",
      patients: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
    };
    expect(countNodes(node)).toBe(4);
  });

  it("mixes to_one and to_many hops correctly", () => {
    const node: DataNode = {
      id: "p1",
      care_team: {
        id: "t1",
        clinic: { id: "c1" },
        patients: [{ id: "p2" }, { id: "p3" }],
      },
    };
    expect(countNodes(node)).toBe(5);
  });

  it("ignores scalar fields, doesn't miscount strings-that-look-like-ids", () => {
    const node: DataNode = {
      id: "x",
      name: "not-a-node",
      code: "ABC",
    };
    expect(countNodes(node)).toBe(1);
  });

  it("traverseEntityData emits visitedCount consistent with countNodes on nested output", async () => {
    const res = await base({ depth: 3, format: "nested" });
    expect(res.visitedCount).toBe(countNodes(res.data as DataNode));
  });
});
