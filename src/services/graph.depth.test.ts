import { describe, expect, it } from "vitest";
import type { Relationship, Taxonomy } from "../shared/index.js";
import { AppError } from "../errors.js";
import {
  buildRelationshipGraph,
  MAX_GRAPH_NODES,
  type GraphNode,
} from "./graph.js";

/** Minimal taxonomy builder used across the depth/boundary tests. */
function tx(
  id: string,
  relationships: Relationship[] = [],
  archived = false,
): Taxonomy {
  return {
    id,
    name: id,
    archived,
    fields: [{ key: "k", type: "string", required: true, is_key: true }],
    relationships,
  };
}

function toOne(key: string, target: string): Relationship {
  return {
    key,
    target_taxonomy_id: target,
    cardinality: "to_one",
    match: [{ source_field: "k", target_field: "k" }],
  };
}

/** Linear chain t0 → t1 → ... → t(n-1). */
function chain(n: number): Map<string, Taxonomy> {
  const byId = new Map<string, Taxonomy>();
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? [toOne("next", `t${i + 1}`)] : [];
    byId.set(`t${i}`, tx(`t${i}`, next));
  }
  return byId;
}

describe("buildRelationshipGraph — depth boundaries", () => {
  it("materializes exactly `depth` levels on a longer chain", () => {
    const byId = chain(60);
    const res = buildRelationshipGraph({
      taxonomyId: "t0",
      depth: 50,
      byId,
    })!;

    // Walk 49 `.next` hops and assert the 50th node exists with no further hop.
    let node: GraphNode = res.graph;
    for (let i = 0; i < 49; i++) {
      expect(node.taxonomy_id).toBe(`t${i}`);
      const next = node.next;
      expect(next, `expected .next at level ${i}`).toBeDefined();
      node = next as GraphNode;
    }
    // 50th level reached.
    expect(node.taxonomy_id).toBe("t49");
    // No 51st level — depth cap stopped recursion.
    expect(node.next).toBeUndefined();
  });

  it("terminates naturally on a chain shorter than the requested depth", () => {
    const byId = chain(5);
    const res = buildRelationshipGraph({
      taxonomyId: "t0",
      depth: 50,
      byId,
    })!;

    // Walk the full 5-level chain.
    let node: GraphNode = res.graph;
    for (let i = 0; i < 4; i++) {
      expect(node.taxonomy_id).toBe(`t${i}`);
      node = node.next as GraphNode;
    }
    expect(node.taxonomy_id).toBe("t4");
    expect(node.next).toBeUndefined();
  });
});

describe("buildRelationshipGraph — asymmetric branches", () => {
  it("fans out a wide branch and descends a deep branch on the same root", () => {
    // Root with two branches:
    //   - `deep`: chain of 20 taxonomies
    //   - `wide_N` for N in [0..49]: 50 leaf relationships to 50 different
    //     taxonomies, each no further hops.
    const byId = new Map<string, Taxonomy>();

    // Deep chain: d0 → d1 → ... → d19
    for (let i = 0; i < 20; i++) {
      const next = i + 1 < 20 ? [toOne("next", `d${i + 1}`)] : [];
      byId.set(`d${i}`, tx(`d${i}`, next));
    }

    // 50 wide leaves.
    const wideRels: Relationship[] = [];
    for (let i = 0; i < 50; i++) {
      byId.set(`w${i}`, tx(`w${i}`));
      wideRels.push(toOne(`wide_${i}`, `w${i}`));
    }

    // Root reaches both branches.
    const root = tx("root", [toOne("deep", "d0"), ...wideRels]);
    byId.set("root", root);

    // depth=25 → enough for the deep chain; the wide branch bottoms out
    // after 1 hop regardless.
    const res = buildRelationshipGraph({
      taxonomyId: "root",
      depth: 25,
      byId,
    })!;

    // Deep branch: root.deep.next.next... all 20 levels reachable.
    let node: GraphNode = res.graph.deep as GraphNode;
    expect(node.taxonomy_id).toBe("d0");
    for (let i = 1; i < 20; i++) {
      node = node.next as GraphNode;
      expect(node.taxonomy_id).toBe(`d${i}`);
    }
    expect(node.next).toBeUndefined();

    // Wide branch: all 50 leaves present, each a node with the right id.
    for (let i = 0; i < 50; i++) {
      const leaf = res.graph[`wide_${i}`] as GraphNode;
      expect(leaf).toBeDefined();
      expect(leaf.taxonomy_id).toBe(`w${i}`);
    }
  });
});

describe("buildRelationshipGraph — node budget boundary", () => {
  /** Root + N leaf children. Total nodes = N + 1. */
  function rootWithLeaves(n: number): Map<string, Taxonomy> {
    const byId = new Map<string, Taxonomy>();
    const rels: Relationship[] = [];
    for (let i = 0; i < n; i++) {
      byId.set(`leaf-${i}`, tx(`leaf-${i}`));
      rels.push(toOne(`r${i}`, `leaf-${i}`));
    }
    byId.set("root", tx("root", rels));
    return byId;
  }

  it("succeeds at exactly MAX_GRAPH_NODES", () => {
    const byId = rootWithLeaves(MAX_GRAPH_NODES - 1);
    const res = buildRelationshipGraph({
      taxonomyId: "root",
      depth: 2,
      byId,
    })!;
    expect(res.graph.taxonomy_id).toBe("root");
    // Sanity: last leaf is present.
    expect(
      (res.graph[`r${MAX_GRAPH_NODES - 2}`] as GraphNode).taxonomy_id,
    ).toBe(`leaf-${MAX_GRAPH_NODES - 2}`);
  });

  it("throws 413 at MAX_GRAPH_NODES + 1", () => {
    const byId = rootWithLeaves(MAX_GRAPH_NODES); // root + 10_000 = 10_001

    try {
      buildRelationshipGraph({ taxonomyId: "root", depth: 2, byId });
      throw new Error("expected buildRelationshipGraph to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const app = err as AppError;
      expect(app.status).toBe(413);
      expect(app.code).toBe("response_too_large");
      expect(app.details?.max_nodes).toBe(MAX_GRAPH_NODES);
    }
  });
});
