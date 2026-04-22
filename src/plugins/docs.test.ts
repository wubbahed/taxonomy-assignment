import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { docsPlugin } from "./docs.js";

describe("docsPlugin", () => {
  it("serves the OpenAPI spec at /openapi.json", async () => {
    const app = Fastify({ logger: false });
    await app.register(docsPlugin);
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("Aviary API");
    // Every route surface is present.
    for (const path of [
      "/healthz",
      "/readyz",
      "/taxonomies",
      "/taxonomies/{taxonomy_id}",
      "/taxonomies/{taxonomy_id}/relationship-graph",
      "/entities",
      "/entities/{entity_id}",
      "/entities/{entity_id}/data",
      "/resolve",
    ]) {
      expect(body.paths).toHaveProperty(path);
    }
    await app.close();
  });

  it("serves Swagger UI HTML at /docs", async () => {
    const app = Fastify({ logger: false });
    await app.register(docsPlugin);
    const res = await app.inject({
      method: "GET",
      url: "/docs/static/index.html",
    });
    // Swagger UI serves its index under /docs; a 200 on either /docs or
    // /docs/static/index.html is enough to confirm the UI mounted.
    expect([200, 302]).toContain(res.statusCode);
    await app.close();
  });
});
