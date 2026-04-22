import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { buildServer } from "../server.js";
import { DATABASE_URL, setupTestDb } from "../test/testDb.js";
import type { FastifyInstance } from "fastify";

const runOrSkip = DATABASE_URL ? describe : describe.skip;

runOrSkip("taxonomy routes", () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = await setupTestDb();
    app = buildServer({ db: handle.db, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it("returns an empty list", async () => {
    const res = await app.inject({ method: "GET", url: "/taxonomies" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [] });
  });

  it("returns a 404 envelope for an unknown taxonomy", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/taxonomies/does-not-exist",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("does-not-exist");
  });

  it("creates a taxonomy and lists it", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/taxonomies",
      payload: {
        id: "widgets",
        name: "Widgets",
        archived: false,
        fields: [{ key: "sku", type: "string", required: true, is_key: true }],
        relationships: [],
      },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/taxonomies" });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { data: Array<{ id: string }> };
    expect(body.data.map((t) => t.id)).toContain("widgets");
  });
});
