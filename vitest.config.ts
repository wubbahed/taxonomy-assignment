import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    // Integration tests share a single Postgres; run files sequentially so they
    // don't truncate each other's state mid-run.
    fileParallelism: false,
  },
});
