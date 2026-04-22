/**
 * Swagger UI + OpenAPI spec hosting.
 *
 * Serves the hand-authored `openapi/openapi.yaml` (OpenAPI v3.1) at two
 * routes:
 *   - `GET /openapi.json` — the parsed spec as JSON (via `@fastify/swagger`)
 *   - `GET /docs`         — interactive Swagger UI
 *
 * The spec file lives at `<repoRoot>/openapi/openapi.yaml`. Because this
 * plugin compiles to `dist/plugins/docs.js` at runtime and sits at
 * `src/plugins/docs.ts` in dev, the relative path `../../openapi/openapi.yaml`
 * resolves to the same file in both layouts. The Dockerfile copies the
 * `openapi/` directory into the image for prod builds.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyPluginAsync } from "fastify";

const SPEC_PATH = fileURLToPath(
  new URL("../../openapi/openapi.yaml", import.meta.url),
);

export const docsPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifySwagger, {
    mode: "static",
    specification: { path: SPEC_PATH, baseDir: path.dirname(SPEC_PATH) },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
    staticCSP: true,
  });

  // Canonical short URL for the parsed spec. `@fastify/swagger-ui` already
  // exposes it at `/docs/json`, but `/openapi.json` is the conventional
  // path most tooling looks for first.
  app.get("/openapi.json", async () => app.swagger());
};
