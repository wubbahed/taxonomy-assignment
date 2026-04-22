import { describe, expect, it } from "vitest";
import type { Taxonomy } from "../shared/index.js";
import { AppError } from "../errors.js";
import {
  buildRelationshipGraph,
  MAX_GRAPH_NODES,
  type GraphNode,
} from "./graph.js";

function tx(overrides: Partial<Taxonomy> & Pick<Taxonomy, "id">): Taxonomy {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    archived: overrides.archived ?? false,
    fields: overrides.fields ?? [],
    relationships: overrides.relationships ?? [],
  };
}

const clinics = tx({
  id: "clinics",
  fields: [
    { key: "clinic_code", type: "string", required: true, is_key: true },
    { key: "name", type: "string", required: true, is_key: false },
    { key: "bed_count", type: "integer", required: true, is_key: false },
  ],
});

const careTeams = tx({
  id: "care_teams",
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
});

const patients = tx({
  id: "patients",
  fields: [
    { key: "patient_number", type: "string", required: true, is_key: true },
    { key: "first_name", type: "string", required: true, is_key: false },
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
});

const byId = new Map<string, Taxonomy>([
  ["clinics", clinics],
  ["care_teams", careTeams],
  ["patients", patients],
]);

describe("buildRelationshipGraph", () => {
  it("returns null when the taxonomy id is unknown", () => {
    expect(
      buildRelationshipGraph({ taxonomyId: "ghost", depth: 2, byId }),
    ).toBeNull();
  });

  it("carries taxonomy_id at the root and nested nodes", () => {
    const res = buildRelationshipGraph({
      taxonomyId: "patients",
      depth: 3,
      byId,
    })!;
    expect(res.taxonomy_id).toBe("patients");
    expect(res.graph.taxonomy_id).toBe("patients");
    expect((res.graph.care_team as GraphNode).taxonomy_id).toBe("care_teams");
    expect(
      ((res.graph.care_team as GraphNode).clinic as GraphNode).taxonomy_id,
    ).toBe("clinics");
  });

  it("encodes field values as the type string", () => {
    const res = buildRelationshipGraph({
      taxonomyId: "patients",
      depth: 1,
      byId,
    })!;
    expect(res.graph.patient_number).toBe("string");
    expect(res.graph.first_name).toBe("string");
    const clinicNode = buildRelationshipGraph({
      taxonomyId: "clinics",
      depth: 1,
      byId,
    })!.graph;
    expect(clinicNode.bed_count).toBe("integer");
  });

  describe("depth semantics", () => {
    it("depth=1 returns root fields only, no relationships", () => {
      const res = buildRelationshipGraph({
        taxonomyId: "patients",
        depth: 1,
        byId,
      })!;
      expect(res.graph.care_team).toBeUndefined();
      // Still contains field keys
      expect(res.graph.patient_number).toBe("string");
    });

    it("depth=2 includes one relationship hop", () => {
      const res = buildRelationshipGraph({
        taxonomyId: "patients",
        depth: 2,
        byId,
      })!;
      const careTeam = res.graph.care_team as GraphNode;
      expect(careTeam).toBeDefined();
      expect(careTeam.team_code).toBe("string");
      // Second hop not traversed
      expect(careTeam.clinic).toBeUndefined();
    });

    it("depth=3 includes two hops", () => {
      const res = buildRelationshipGraph({
        taxonomyId: "patients",
        depth: 3,
        byId,
      })!;
      const careTeam = res.graph.care_team as GraphNode;
      const clinic = careTeam.clinic as GraphNode;
      expect(clinic).toBeDefined();
      expect(clinic.name).toBe("string");
      // clinics has no relationships, so the chain terminates naturally
    });

    it("large depth does not overshoot when the graph bottoms out", () => {
      const res = buildRelationshipGraph({
        taxonomyId: "patients",
        depth: 99,
        byId,
      })!;
      const careTeam = res.graph.care_team as GraphNode;
      const clinic = careTeam.clinic as GraphNode;
      expect(clinic.name).toBe("string");
    });
  });

  describe("filtering", () => {
    it("omits relationships whose target is archived", () => {
      const archivedCareTeams: Taxonomy = { ...careTeams, archived: true };
      const filteredById = new Map(byId);
      filteredById.set("care_teams", archivedCareTeams);

      const res = buildRelationshipGraph({
        taxonomyId: "patients",
        depth: 2,
        byId: filteredById,
      })!;
      expect(res.graph.care_team).toBeUndefined();
    });

    it("omits relationships whose target does not exist", () => {
      const orphan = tx({
        id: "orphan",
        fields: [{ key: "k", type: "string", required: true, is_key: true }],
        relationships: [
          {
            key: "ghost_rel",
            target_taxonomy_id: "does_not_exist",
            cardinality: "to_one",
            match: [{ source_field: "k", target_field: "k" }],
          },
        ],
      });
      const res = buildRelationshipGraph({
        taxonomyId: "orphan",
        depth: 3,
        byId: new Map([["orphan", orphan]]),
      })!;
      expect(res.graph.ghost_rel).toBeUndefined();
      expect(res.graph.k).toBe("string");
    });

    it("serves an archived root (explicit lookup wins)", () => {
      const archivedRoot: Taxonomy = { ...patients, archived: true };
      const filteredById = new Map(byId);
      filteredById.set("patients", archivedRoot);

      const res = buildRelationshipGraph({
        taxonomyId: "patients",
        depth: 1,
        byId: filteredById,
      })!;
      expect(res.graph.taxonomy_id).toBe("patients");
    });
  });

  describe("cycle handling", () => {
    it("breaks a mutual cycle along the path of descent", () => {
      const a = tx({
        id: "a",
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
      const b = tx({
        id: "b",
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
      const cycled = new Map<string, Taxonomy>([
        ["a", a],
        ["b", b],
      ]);

      // depth=99 would loop forever without cycle guards
      const res = buildRelationshipGraph({
        taxonomyId: "a",
        depth: 99,
        byId: cycled,
      })!;
      const nested = res.graph.b as GraphNode;
      expect(nested.taxonomy_id).toBe("b");
      // `a` key should be absent because descending into it would revisit "a"
      expect(nested.a).toBeUndefined();
    });

    it("breaks a self-referencing taxonomy", () => {
      const nodes = tx({
        id: "nodes",
        fields: [
          { key: "id_field", type: "string", required: true, is_key: true },
        ],
        relationships: [
          {
            key: "parent",
            target_taxonomy_id: "nodes",
            cardinality: "to_one",
            match: [{ source_field: "id_field", target_field: "id_field" }],
          },
        ],
      });
      const res = buildRelationshipGraph({
        taxonomyId: "nodes",
        depth: 99,
        byId: new Map([["nodes", nodes]]),
      })!;
      expect(res.graph.parent).toBeUndefined();
      expect(res.graph.id_field).toBe("string");
    });

    it("allows diamond shapes (same taxonomy under two different parents)", () => {
      // patients -> care_team -> clinic
      // patients -> billing  -> clinic
      // Both paths hit clinics, but neither path has visited clinics before.
      const billing = tx({
        id: "billing",
        fields: [
          { key: "clinic_code", type: "string", required: true, is_key: true },
        ],
        relationships: [
          {
            key: "clinic",
            target_taxonomy_id: "clinics",
            cardinality: "to_one",
            match: [
              { source_field: "clinic_code", target_field: "clinic_code" },
            ],
          },
        ],
      });
      const patientsWithBilling = tx({
        ...patients,
        relationships: [
          ...patients.relationships,
          {
            key: "billing",
            target_taxonomy_id: "billing",
            cardinality: "to_one",
            match: [
              { source_field: "patient_number", target_field: "clinic_code" },
            ],
          },
        ],
      });
      const diamond = new Map<string, Taxonomy>([
        ["clinics", clinics],
        ["care_teams", careTeams],
        ["billing", billing],
        ["patients", patientsWithBilling],
      ]);
      const res = buildRelationshipGraph({
        taxonomyId: "patients",
        depth: 3,
        byId: diamond,
      })!;
      expect(
        ((res.graph.care_team as GraphNode).clinic as GraphNode).taxonomy_id,
      ).toBe("clinics");
      expect(
        ((res.graph.billing as GraphNode).clinic as GraphNode).taxonomy_id,
      ).toBe("clinics");
    });
  });

  it("handles to_many_through like any other relationship", () => {
    const enrollments = tx({
      id: "enrollments",
      fields: [
        { key: "enrollment_key", type: "string", required: true, is_key: true },
        {
          key: "assigned_coach",
          type: "string",
          required: true,
          is_key: false,
        },
      ],
    });
    const patientsWithThrough = tx({
      ...patients,
      relationships: [
        {
          key: "enrollment",
          target_taxonomy_id: "enrollments",
          cardinality: "to_one",
          match: [
            { source_field: "patient_number", target_field: "enrollment_key" },
          ],
        },
        {
          key: "coaches",
          target_taxonomy_id: "enrollments",
          cardinality: "to_many_through",
          through: ["enrollment"],
        },
      ],
    });
    const map = new Map<string, Taxonomy>([
      ["enrollments", enrollments],
      ["patients", patientsWithThrough],
    ]);
    const res = buildRelationshipGraph({
      taxonomyId: "patients",
      depth: 2,
      byId: map,
    })!;
    const coaches = res.graph.coaches as GraphNode;
    expect(coaches.taxonomy_id).toBe("enrollments");
    expect(coaches.assigned_coach).toBe("string");
  });
});

describe("buildRelationshipGraph — node budget", () => {
  // A branching DAG: root has b=3 relationships, each pointing to a target
  // that itself has b=3 relationships to the next layer, and so on. No
  // cycles, so the per-path visited set doesn't short-circuit; node count
  // grows like 3^depth. At depth=20 that's ~3.5B nodes — far past budget.
  function branchingDag(
    branching: number,
    layers: number,
  ): Map<string, Taxonomy> {
    const byId = new Map<string, Taxonomy>();
    for (let layer = 0; layer < layers; layer++) {
      for (let i = 0; i < branching; i++) {
        const id = `l${layer}-n${i}`;
        const children =
          layer + 1 < layers
            ? Array.from({ length: branching }, (_, j) => ({
                key: `rel_${j}`,
                target_taxonomy_id: `l${layer + 1}-n${j}`,
                cardinality: "to_one" as const,
                match: [{ source_field: "k", target_field: "k" }],
              }))
            : [];
        byId.set(
          id,
          tx({
            id,
            fields: [
              { key: "k", type: "string", required: true, is_key: true },
            ],
            relationships: children,
          }),
        );
      }
    }
    return byId;
  }

  it("throws a 413 when the graph would exceed MAX_GRAPH_NODES", () => {
    const byId = branchingDag(3, 20);
    try {
      buildRelationshipGraph({ taxonomyId: "l0-n0", depth: 20, byId });
      throw new Error("expected buildRelationshipGraph to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const app = err as AppError;
      expect(app.code).toBe("response_too_large");
      expect(app.status).toBe(413);
      expect(app.details?.max_nodes).toBe(MAX_GRAPH_NODES);
    }
  });

  it("succeeds when the graph stays under budget", () => {
    // A 3-layer linear chain is 3 nodes — well under budget.
    const byId = branchingDag(1, 3);
    const res = buildRelationshipGraph({
      taxonomyId: "l0-n0",
      depth: 10,
      byId,
    });
    expect(res).not.toBeNull();
    expect(res!.graph.taxonomy_id).toBe("l0-n0");
  });
});
