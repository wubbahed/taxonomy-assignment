/**
 * Environment validation.
 *
 * Every config value the service needs is declared here. `loadEnv()` is
 * the only way runtime code reaches `process.env` — everything else takes
 * an `Env` object. This gives us one place to type, validate, and default
 * env vars, and it means boot fails loudly (with a listing of every
 * offending var) rather than deferring to a `TypeError: cannot read
 * properties of undefined` deep in a handler.
 *
 * See `.env.example` for a starting point.
 */

import { z } from "zod";

const envSchema = z.object({
  /** HTTP listen port. Default matches the contract's 3000. */
  PORT: z.coerce.number().int().positive().default(3000),
  /** Directory containing `taxonomies.json` and `entities.json`. Required.
   *  In Docker, mounted at `/fixtures/public`. */
  FIXTURE_DIR: z.string().min(1),
  /** Postgres connection string. Required. */
  DATABASE_URL: z.string().url(),
  /** Drives log level and pretty-printing in `buildServer()`. */
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate `process.env`. Throws with an aggregated message
 * listing every offending var on failure — we want a hard boot failure,
 * not a lazy fallback that surfaces as mysterious 500s later.
 */
export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return parsed.data;
}
