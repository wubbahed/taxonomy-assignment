/**
 * Aviary-specific metric instruments.
 *
 * These attach to the global OpenTelemetry meter provider. In production
 * the provider is real (registered by `startTelemetry()` in tracing.ts);
 * in tests it's a no-op, so `.record()` / `.add()` calls are free.
 *
 * Attribute keys are kept low-cardinality on purpose — never tag with
 * entity_id, user_id, or request_id. Those belong on traces and logs.
 */

import { metrics as metricsApi, ValueType } from "@opentelemetry/api";

const meter = metricsApi.getMeter("aviary");

/** Depth requested on graph/data traversal endpoints. */
export const graphDepthHistogram = meter.createHistogram("aviary.graph.depth", {
  description: "Traversal depth requested (by endpoint)",
  unit: "levels",
  valueType: ValueType.INT,
});

/** Entities visited per traversal request — "how much data did we touch?" */
export const traversalFanoutHistogram = meter.createHistogram(
  "aviary.traversal.fanout",
  {
    description: "Entities visited in a single traversal request",
    unit: "entities",
    valueType: ValueType.INT,
  },
);

/** One increment per path in POST /resolve, classified by outcome code. */
export const resolvePathOutcomeCounter = meter.createCounter(
  "aviary.resolve.path_outcome",
  {
    description: "Per-path outcome classification for POST /resolve",
    valueType: ValueType.INT,
  },
);
