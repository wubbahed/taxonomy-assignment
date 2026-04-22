import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandler } from "./errorHandler.js";
import { AppError } from "../errors.js";

describe("error envelope + not-found handling", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get("/boom", async () => {
      throw new AppError("custom_code", "nope", 418, { hint: "teapot" });
    });
    app.post("/typed", { schema: {} }, async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("wraps AppError in the contract envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(418);
    const body = res.json() as {
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };
    expect(body).toEqual({
      error: {
        code: "custom_code",
        message: "nope",
        details: { hint: "teapot" },
      },
    });
  });

  it("returns the contract envelope for unknown routes (404)", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-route" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toMatch(/Route not found/i);
  });

  it("returns a 400 envelope for malformed JSON bodies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/typed",
      headers: { "content-type": "application/json" },
      payload: "{not valid json",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("responses are always JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
