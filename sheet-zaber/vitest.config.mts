import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the react-server condition; tests are
      // always server-side, so point it at the package's empty stub.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
    // One embedded Postgres for the whole run (integration isolation = truncateAll),
    // so files must not share it concurrently.
    globalSetup: ["./tests/setup/db.ts"],
    fileParallelism: false,
    // Integration tests (tests/db/**) boot an embedded Postgres and apply
    // migrations — both need a long budget on cold start.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // Dummy values so `src/lib/env.ts` parses at module load during tests.
    // Tests exercise the pure `parseEnv(input)` — no real env vars needed.
    env: {
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/sheet_zaber_test",
      SESSION_SECRET: "vitest-only-session-secret-0000000000000000",
      TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      OWNER_EMAIL: "owner@example.com",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3001",
    },
  },
})
