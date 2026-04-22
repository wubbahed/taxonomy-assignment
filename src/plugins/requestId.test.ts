import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { Database } from "../db/client.js";

// Health endpoints only need `execute` (for /readyz), and our tests only hit
// /healthz (which never touches the db), so a no-op DB is fine here.
const fakeDb = {} as unknown as Database;

describe("request id correlation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildServer({ db: fakeDb, logger: false, nodeEnv: "test" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("echoes an inbound x-request-id back on the response", async () => {
    const incoming = "00000000-1111-2222-3333-444444444444";
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": incoming },
    });
    expect(res.headers["x-request-id"]).toBe(incoming);
  });

  it("generates a request id when the caller did not supply one", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(String(res.headers["x-request-id"]).length).toBeGreaterThan(0);
  });

  it("generates a distinct id per request", async () => {
    const a = await app.inject({ method: "GET", url: "/healthz" });
    const b = await app.inject({ method: "GET", url: "/healthz" });
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });
});
