import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { healthRoutes } from "./health.js";
import { registerErrorHandler } from "../plugins/errorHandler.js";
import type { Database } from "../db/client.js";

/** Minimal stand-in for a Drizzle DB handle. `execute` is the only method
 *  /readyz calls. */
function fakeDb(execute: () => Promise<unknown>): Database {
  return { execute } as unknown as Database;
}

describe("GET /healthz", () => {
  it("returns { ok: true } regardless of DB state", async () => {
    const app = Fastify({ logger: false });
    await app.register(
      healthRoutes({
        db: fakeDb(async () => {
          throw new Error("db is broken");
        }),
      }),
    );
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});

describe("GET /readyz", () => {
  it("returns 200 when the DB responds", async () => {
    const app = Fastify({ logger: false });
    await app.register(
      healthRoutes({
        db: fakeDb(async () => ({ rows: [{ "?column?": 1 }] })),
      }),
    );
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: "ok" });
    await app.close();
  });

  it("returns 503 with an error envelope when the DB is unreachable", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(
      healthRoutes({
        db: fakeDb(async () => {
          throw new Error("connection refused");
        }),
      }),
    );
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unavailable");
    expect(body.error.message).toMatch(/database/i);
    await app.close();
  });
});
