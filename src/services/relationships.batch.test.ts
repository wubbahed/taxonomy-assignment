import { describe, expect, it } from "vitest";
import type {
  AttributeValue,
  Entity,
  Relationship,
  Taxonomy,
} from "../shared/index.js";
import {
  followRelationshipBatch,
  type TraversalContext,
} from "./relationships.js";
import type { EntityFetcher, FetchOptions } from "./entityFetcher.js";

/**
 * Spying fetcher — records every call and serves from an in-memory
 * entity list. Lets us assert the batched path issues one query per
 * (relationship × hop) regardless of how many sources are involved.
 */
class SpyFetcher implements EntityFetcher {
  readonly calls: Array<{
    taxonomyId: string;
    probes: Record<string, AttributeValue>[];
  }> = [];

  constructor(private readonly entities: Entity[]) {}

  async fetchMatching(
    taxonomyId: string,
    probes: Record<string, AttributeValue>[],
    _opts: FetchOptions = {},
  ): Promise<Entity[]> {
    this.calls.push({ taxonomyId, probes: probes.map((p) => ({ ...p })) });
    const out: Entity[] = [];
    for (const entity of this.entities) {
      if (entity.taxonomy_id !== taxonomyId) continue;
      if (entity.archived) continue;
      if (!probes.some((p) => containsProbe(entity, p))) continue;
      out.push(entity);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

function containsProbe(
  entity: Entity,
  probe: Record<string, AttributeValue>,
): boolean {
  for (const [k, v] of Object.entries(probe)) {
    if (!(k in entity.attributes)) return false;
    if (entity.attributes[k] !== v) return false;
  }
  return true;
}

// ---- fixture shape ---------------------------------------------------------
// patients (source) -> orders (direct to_many) -> items (direct to_many)
// patients -> chain_target via through: ["orders", "items"]

const patients: Taxonomy = {
  id: "patients",
  name: "Patients",
  archived: false,
  fields: [
    { key: "patient_number", type: "string", required: true, is_key: true },
  ],
  relationships: [
    {
      key: "orders",
      target_taxonomy_id: "orders",
      cardinality: "to_many",
      match: [
        { source_field: "patient_number", target_field: "patient_number" },
      ],
    },
    {
      key: "chain_target",
      target_taxonomy_id: "items",
      cardinality: "to_many_through",
      through: ["orders", "items"],
    },
  ],
};

const orders: Taxonomy = {
  id: "orders",
  name: "Orders",
  archived: false,
  fields: [
    { key: "order_id", type: "string", required: true, is_key: true },
    { key: "patient_number", type: "string", required: true, is_key: false },
  ],
  relationships: [
    {
      key: "items",
      target_taxonomy_id: "items",
      cardinality: "to_many",
      match: [{ source_field: "order_id", target_field: "order_id" }],
    },
  ],
};

const items: Taxonomy = {
  id: "items",
  name: "Items",
  archived: false,
  fields: [
    { key: "item_id", type: "string", required: true, is_key: true },
    { key: "order_id", type: "string", required: true, is_key: false },
  ],
  relationships: [],
};

const taxonomiesById = new Map<string, Taxonomy>([
  ["patients", patients],
  ["orders", orders],
  ["items", items],
]);

const ordersRel = patients.relationships[0]! as Relationship;
const chainRel = patients.relationships[1]! as Relationship;

function ctxOf(entities: Entity[]): {
  ctx: TraversalContext;
  fetcher: SpyFetcher;
} {
  const fetcher = new SpyFetcher(entities);
  return { ctx: { taxonomiesById, fetcher }, fetcher };
}

function patient(i: number, patientNumber: string): Entity {
  return {
    id: `patient-${String(i).padStart(3, "0")}`,
    taxonomy_id: "patients",
    archived: false,
    attributes: { patient_number: patientNumber },
  };
}

function order(orderId: string, patientNumber: string): Entity {
  return {
    id: `order-${orderId}`,
    taxonomy_id: "orders",
    archived: false,
    attributes: { order_id: orderId, patient_number: patientNumber },
  };
}

function item(itemId: string, orderId: string): Entity {
  return {
    id: `item-${itemId}`,
    taxonomy_id: "items",
    archived: false,
    attributes: { item_id: itemId, order_id: orderId },
  };
}

describe("followRelationshipBatch — probe deduplication", () => {
  it("collapses 50 sources sharing the same probe into a single fetch", async () => {
    // 50 patients all point at the same patient_number value.
    const sources = Array.from({ length: 50 }, (_, i) => patient(i, "SHARED"));
    const sharedOrder = order("O-SHARED", "SHARED");
    const { ctx, fetcher } = ctxOf([...sources, sharedOrder]);

    const result = await followRelationshipBatch(sources, ordersRel, ctx);

    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]!.probes).toEqual([{ patient_number: "SHARED" }]);
    // Every source sees the shared order.
    expect(result.size).toBe(50);
    for (const source of sources) {
      expect(result.get(source.id)!.map((e) => e.id)).toEqual([
        "order-O-SHARED",
      ]);
    }
  });

  it("routes distinct probes to the right source when 50 sources each have a unique probe", async () => {
    const sources = Array.from({ length: 50 }, (_, i) =>
      patient(i, `P-${String(i).padStart(3, "0")}`),
    );
    // Each patient has exactly one order keyed to their patient_number.
    const allOrders = sources.map((s, i) =>
      order(`O-${i}`, s.attributes.patient_number as string),
    );
    const { ctx, fetcher } = ctxOf([...sources, ...allOrders]);

    const result = await followRelationshipBatch(sources, ordersRel, ctx);

    // Still a single batched call, despite 50 distinct probes.
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]!.probes).toHaveLength(50);
    // Each source gets exactly its own order and nobody else's.
    for (let i = 0; i < sources.length; i++) {
      const got = result.get(sources[i]!.id)!;
      expect(got.map((e) => e.id)).toEqual([`order-O-${i}`]);
    }
  });

  it("sources with null in the probe field are mapped to [] and not probed", async () => {
    const haveKey = Array.from({ length: 25 }, (_, i) => patient(i, `P-${i}`));
    const noKey = Array.from({ length: 25 }, (_, i) => ({
      ...patient(100 + i, ""),
      attributes: { patient_number: null as AttributeValue },
    }));
    const allSources = [...haveKey, ...noKey];
    const allOrders = haveKey.map((s, i) =>
      order(`O-${i}`, s.attributes.patient_number as string),
    );
    const { ctx, fetcher } = ctxOf([...allSources, ...allOrders]);

    const result = await followRelationshipBatch(allSources, ordersRel, ctx);

    // One call with 25 probes (the non-null sources), not 50.
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]!.probes).toHaveLength(25);
    for (const s of noKey) expect(result.get(s.id)).toEqual([]);
    for (let i = 0; i < haveKey.length; i++) {
      expect(result.get(haveKey[i]!.id)!.map((e) => e.id)).toEqual([
        `order-O-${i}`,
      ]);
    }
  });

  it("returns an empty map when sources is empty (no fetch issued)", async () => {
    const { ctx, fetcher } = ctxOf([]);
    const result = await followRelationshipBatch([], ordersRel, ctx);
    expect(result.size).toBe(0);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("returns [] for every source when every source's probe field is null", async () => {
    const sources = Array.from({ length: 10 }, (_, i) => ({
      ...patient(i, ""),
      attributes: { patient_number: null as AttributeValue },
    }));
    const { ctx, fetcher } = ctxOf(sources);
    const result = await followRelationshipBatch(sources, ordersRel, ctx);
    expect(fetcher.calls).toHaveLength(0);
    for (const s of sources) expect(result.get(s.id)).toEqual([]);
  });
});

describe("followRelationshipBatch — to_many_through", () => {
  it("walks the chain per-source and returns each source's own terminal matches", async () => {
    // 50 patients, each with one order, each order with one item. The
    // current implementation walks each source independently (see the
    // comment at the `to_many_through` branch of followRelationshipBatch),
    // so fetch count scales with source count. This test locks in that
    // behavior — if a future refactor merges through-hop fetches across
    // sources, the fetch-count assertion is the signal.
    const sources = Array.from({ length: 50 }, (_, i) =>
      patient(i, `P-${String(i).padStart(3, "0")}`),
    );
    const allOrders = sources.map((s, i) =>
      order(`O-${i}`, s.attributes.patient_number as string),
    );
    const allItems = allOrders.map((o, i) =>
      item(`I-${i}`, o.attributes.order_id as string),
    );
    const { ctx, fetcher } = ctxOf([...sources, ...allOrders, ...allItems]);

    const result = await followRelationshipBatch(sources, chainRel, ctx);

    // 50 sources × 2 hops each = 100 fetches under current impl.
    expect(fetcher.calls).toHaveLength(100);
    expect(result.size).toBe(50);
    // Each source gets exactly its own item, not the aggregate across
    // sources — per-source isolation.
    for (let i = 0; i < sources.length; i++) {
      const got = result.get(sources[i]!.id)!;
      expect(got.map((e) => e.id)).toEqual([`item-I-${i}`]);
    }
  });

  it("returns [] for a source whose chain dead-ends at the first hop", async () => {
    const reachable = patient(1, "P-OK");
    const dead = patient(2, "P-MISSING");
    const ord = order("O-1", "P-OK");
    const itm = item("I-1", "O-1");
    const { ctx } = ctxOf([reachable, dead, ord, itm]);

    const result = await followRelationshipBatch(
      [reachable, dead],
      chainRel,
      ctx,
    );

    expect(result.get(reachable.id)!.map((e) => e.id)).toEqual(["item-I-1"]);
    expect(result.get(dead.id)).toEqual([]);
  });
});
