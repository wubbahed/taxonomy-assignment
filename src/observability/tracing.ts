/**
 * OpenTelemetry bootstrap. Must be imported and invoked before any
 * instrumented libraries (fastify, pg, http) are loaded — otherwise the
 * auto-instrumentation can't patch them.
 *
 * Env vars consumed:
 *   OTEL_SERVICE_NAME               service.name (default: "aviary-api")
 *   SERVICE_VERSION                 service.version (default: "0.0.0")
 *   OTEL_METRICS_PORT               Prometheus scrape port (default: 9464)
 *   OTEL_EXPORTER_OTLP_ENDPOINT     if set, emit spans via OTLP/HTTP
 *                                   (e.g. "http://otel-collector:4318");
 *                                   if unset, tracing is a no-op
 *   Any other OTEL_* vars are read by the SDK directly.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { HostMetrics } from "@opentelemetry/host-metrics";
import { metrics as metricsApi } from "@opentelemetry/api";

let sdk: NodeSDK | undefined;
let hostMetrics: HostMetrics | undefined;

export function startTelemetry(): void {
  if (sdk) return;

  const serviceName = process.env.OTEL_SERVICE_NAME ?? "aviary-api";
  const serviceVersion = process.env.SERVICE_VERSION ?? "0.0.0";
  const metricsPort = Number(process.env.OTEL_METRICS_PORT ?? 9464);
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const metricReader = new PrometheusExporter({
    port: metricsPort,
    endpoint: "/metrics",
  });

  // Auto-instrumentation for fastify, pg, http, dns, etc. Disable the
  // fs instrumentation: it emits a span for every single read/stat and
  // buries the signal under noise.
  const instrumentations = [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ];

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
    metricReader,
    instrumentations,
    ...(otlpEndpoint
      ? {
          traceExporter: new OTLPTraceExporter({
            url: `${otlpEndpoint.replace(/\/+$/, "")}/v1/traces`,
          }),
        }
      : {}),
  });

  sdk.start();

  // Host-level process metrics: CPU, memory, event loop lag, GC pauses.
  // These piggyback on the global meter provider the SDK just registered.
  hostMetrics = new HostMetrics({
    meterProvider: metricsApi.getMeterProvider(),
    name: serviceName,
  });
  hostMetrics.start();
}

export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // Shutdown errors are never actionable — we're on the exit path.
  }
  sdk = undefined;
  hostMetrics = undefined;
}

// Self-start at module load. This file must be the first local import in
// src/index.ts so the SDK registers its hooks before fastify/pg/http are
// required — otherwise the auto-instrumentation has nothing to patch. Tests
// import server.ts directly and never pull this module in.
if (process.env.NODE_ENV !== "test") {
  startTelemetry();
}
