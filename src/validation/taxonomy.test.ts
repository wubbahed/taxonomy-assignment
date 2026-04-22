import { describe, expect, it } from "vitest";
import type { Taxonomy } from "../shared/index.js";
import { AppError } from "../errors.js";
import {
  validateTaxonomyReferences,
  validateTaxonomyStructure,
} from "./taxonomy.js";

function makeTaxonomy(overrides: Partial<Taxonomy> = {}): Taxonomy {
  return {
    id: "t",
    name: "T",
    archived: false,
    fields: [{ key: "id_field", type: "string", required: true, is_key: true }],
    relationships: [],
    ...overrides,
  };
}

function expectValidationError(fn: () => void): AppError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(400);
    return err as AppError;
  }
  throw new Error("expected validation error but none was thrown");
}

describe("validateTaxonomyStructure", () => {
  it("accepts a minimal valid taxonomy", () => {
    expect(() => validateTaxonomyStructure(makeTaxonomy())).not.toThrow();
  });

  it("rejects duplicate field keys", () => {
    const t = makeTaxonomy({
      fields: [
        { key: "a", type: "string", required: true, is_key: true },
        { key: "a", type: "integer", required: false, is_key: false },
      ],
    });
    const err = expectValidationError(() => validateTaxonomyStructure(t));
    expect(JSON.stringify(err.details)).toContain("Duplicate field key");
  });

  it("rejects duplicate relationship keys", () => {
    const t = makeTaxonomy({
      fields: [{ key: "k", type: "string", required: true, is_key: true }],
      relationships: [
        {
          key: "r",
          target_taxonomy_id: "other",
          cardinality: "to_one",
          match: [{ source_field: "k", target_field: "k" }],
        },
        {
          key: "r",
          target_taxonomy_id: "other",
          cardinality: "to_many",
          match: [{ source_field: "k", target_field: "k" }],
        },
      ],
    });
    const err = expectValidationError(() => validateTaxonomyStructure(t));
    expect(JSON.stringify(err.details)).toContain("Duplicate relationship key");
  });

  it("rejects a relationship whose match.source_field is not on this taxonomy", () => {
    const t = makeTaxonomy({
      relationships: [
        {
          key: "ref",
          target_taxonomy_id: "other",
          cardinality: "to_one",
          match: [{ source_field: "ghost", target_field: "x" }],
        },
      ],
    });
    const err = expectValidationError(() => validateTaxonomyStructure(t));
    expect(JSON.stringify(err.details)).toContain("ghost");
  });

  it("rejects to_many_through whose first hop is not a relationship on this taxonomy", () => {
    const t = makeTaxonomy({
      relationships: [
        {
          key: "chain",
          target_taxonomy_id: "other",
          cardinality: "to_many_through",
          through: ["unknown_hop"],
        },
      ],
    });
    const err = expectValidationError(() => validateTaxonomyStructure(t));
    expect(JSON.stringify(err.details)).toContain("unknown_hop");
  });
});

describe("validateTaxonomyReferences", () => {
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

  it("accepts a valid direct relationship", () => {
    const byId = new Map<string, Taxonomy>([
      ["clinics", clinics],
      ["care_teams", careTeams],
    ]);
    expect(() => validateTaxonomyReferences(careTeams, byId)).not.toThrow();
  });

  it("rejects a relationship whose target taxonomy does not exist", () => {
    const t: Taxonomy = {
      ...careTeams,
      relationships: [
        {
          key: "missing",
          target_taxonomy_id: "ghost_taxonomy",
          cardinality: "to_one",
          match: [{ source_field: "clinic_code", target_field: "clinic_code" }],
        },
      ],
    };
    const byId = new Map<string, Taxonomy>([["care_teams", t]]);
    const err = expectValidationError(() =>
      validateTaxonomyReferences(t, byId),
    );
    expect(JSON.stringify(err.details)).toContain("ghost_taxonomy");
  });

  it("rejects a relationship whose match.target_field does not exist on the target", () => {
    const t: Taxonomy = {
      ...careTeams,
      relationships: [
        {
          key: "clinic",
          target_taxonomy_id: "clinics",
          cardinality: "to_one",
          match: [{ source_field: "clinic_code", target_field: "ghost_field" }],
        },
      ],
    };
    const byId = new Map<string, Taxonomy>([
      ["clinics", clinics],
      ["care_teams", t],
    ]);
    const err = expectValidationError(() =>
      validateTaxonomyReferences(t, byId),
    );
    expect(JSON.stringify(err.details)).toContain("ghost_field");
  });

  it("accepts a to_many_through that resolves to the declared target", () => {
    const patients: Taxonomy = {
      id: "patients",
      name: "Patients",
      archived: false,
      fields: [
        { key: "patient_number", type: "string", required: true, is_key: true },
        {
          key: "care_team_code",
          type: "string",
          required: true,
          is_key: false,
        },
      ],
      relationships: [
        {
          key: "care_team",
          target_taxonomy_id: "care_teams",
          cardinality: "to_one",
          match: [
            { source_field: "care_team_code", target_field: "team_code" },
          ],
        },
        {
          key: "care_team_clinic",
          target_taxonomy_id: "clinics",
          cardinality: "to_many_through",
          through: ["care_team", "clinic"],
        },
      ],
    };
    const byId = new Map<string, Taxonomy>([
      ["clinics", clinics],
      ["care_teams", careTeams],
      ["patients", patients],
    ]);
    expect(() => validateTaxonomyReferences(patients, byId)).not.toThrow();
  });

  it("rejects a to_many_through chain that ends at the wrong taxonomy", () => {
    const patients: Taxonomy = {
      id: "patients",
      name: "Patients",
      archived: false,
      fields: [
        { key: "patient_number", type: "string", required: true, is_key: true },
        {
          key: "care_team_code",
          type: "string",
          required: true,
          is_key: false,
        },
      ],
      relationships: [
        {
          key: "care_team",
          target_taxonomy_id: "care_teams",
          cardinality: "to_one",
          match: [
            { source_field: "care_team_code", target_field: "team_code" },
          ],
        },
        {
          key: "bad_chain",
          // Chain walks to clinics, but declared target is care_teams.
          target_taxonomy_id: "care_teams",
          cardinality: "to_many_through",
          through: ["care_team", "clinic"],
        },
      ],
    };
    const byId = new Map<string, Taxonomy>([
      ["clinics", clinics],
      ["care_teams", careTeams],
      ["patients", patients],
    ]);
    const err = expectValidationError(() =>
      validateTaxonomyReferences(patients, byId),
    );
    expect(JSON.stringify(err.details)).toContain("ends at");
  });

  it("allows self-referencing relationships", () => {
    const nodes: Taxonomy = {
      id: "nodes",
      name: "Nodes",
      archived: false,
      fields: [
        { key: "id_field", type: "string", required: true, is_key: true },
        { key: "parent_id", type: "string", required: false, is_key: false },
      ],
      relationships: [
        {
          key: "parent",
          target_taxonomy_id: "nodes",
          cardinality: "to_one",
          match: [{ source_field: "parent_id", target_field: "id_field" }],
        },
      ],
    };
    const byId = new Map<string, Taxonomy>([["nodes", nodes]]);
    expect(() => validateTaxonomyReferences(nodes, byId)).not.toThrow();
  });
});

describe("validateTaxonomyReferences — through-chain cycles", () => {
  const clinics: Taxonomy = {
    id: "clinics",
    name: "Clinics",
    archived: false,
    fields: [
      { key: "clinic_code", type: "string", required: true, is_key: true },
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

  it("rejects a through chain that references the relationship itself", () => {
    const t: Taxonomy = {
      id: "loops",
      name: "Loops",
      archived: false,
      fields: [{ key: "k", type: "string", required: true, is_key: true }],
      relationships: [
        {
          key: "self_loop",
          target_taxonomy_id: "loops",
          cardinality: "to_many_through",
          through: ["self_loop"],
        },
      ],
    };
    const byId = new Map<string, Taxonomy>([["loops", t]]);
    const err = expectValidationError(() =>
      validateTaxonomyReferences(t, byId),
    );
    expect(JSON.stringify(err.details)).toContain("Circular");
    expect(JSON.stringify(err.details)).toContain("loops.self_loop");
  });

  it("rejects a two-relationship through-chain cycle (a -> b -> a)", () => {
    const t: Taxonomy = {
      id: "cycle",
      name: "Cycle",
      archived: false,
      fields: [{ key: "k", type: "string", required: true, is_key: true }],
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
    };
    const byId = new Map<string, Taxonomy>([["cycle", t]]);
    const err = expectValidationError(() =>
      validateTaxonomyReferences(t, byId),
    );
    const details = JSON.stringify(err.details);
    expect(details).toContain("Circular");
    // At least one of the relationships should be flagged with the cycle path.
    expect(details).toMatch(/cycle\.a.*cycle\.b|cycle\.b.*cycle\.a/);
  });

  it("accepts a valid nested composition (through-chain whose hops include another through-chain)", () => {
    const patients: Taxonomy = {
      id: "patients",
      name: "Patients",
      archived: false,
      fields: [
        { key: "patient_number", type: "string", required: true, is_key: true },
        {
          key: "care_team_code",
          type: "string",
          required: true,
          is_key: false,
        },
      ],
      relationships: [
        {
          key: "care_team",
          target_taxonomy_id: "care_teams",
          cardinality: "to_one",
          match: [
            { source_field: "care_team_code", target_field: "team_code" },
          ],
        },
        // Direct composition: one through chain
        {
          key: "clinic_via_team",
          target_taxonomy_id: "clinics",
          cardinality: "to_many_through",
          through: ["care_team", "clinic"],
        },
        // Nested composition: a through chain whose single hop is itself a through chain
        {
          key: "clinic_nested",
          target_taxonomy_id: "clinics",
          cardinality: "to_many_through",
          through: ["clinic_via_team"],
        },
      ],
    };
    const byId = new Map<string, Taxonomy>([
      ["clinics", clinics],
      ["care_teams", careTeams],
      ["patients", patients],
    ]);
    expect(() => validateTaxonomyReferences(patients, byId)).not.toThrow();
  });

  it("accepts nested composition whose chain correctly ends at the declared target", () => {
    // inner through chain lands at care_teams; outer uses it plus a direct hop to reach clinics
    const patients: Taxonomy = {
      id: "patients",
      name: "Patients",
      archived: false,
      fields: [
        { key: "patient_number", type: "string", required: true, is_key: true },
        {
          key: "care_team_code",
          type: "string",
          required: true,
          is_key: false,
        },
      ],
      relationships: [
        {
          key: "care_team",
          target_taxonomy_id: "care_teams",
          cardinality: "to_one",
          match: [
            { source_field: "care_team_code", target_field: "team_code" },
          ],
        },
        {
          key: "team_copy",
          target_taxonomy_id: "care_teams",
          cardinality: "to_many_through",
          through: ["care_team"],
        },
      ],
    };
    const byId = new Map<string, Taxonomy>([
      ["clinics", clinics],
      ["care_teams", careTeams],
      ["patients", patients],
    ]);
    expect(() => validateTaxonomyReferences(patients, byId)).not.toThrow();
  });
});
