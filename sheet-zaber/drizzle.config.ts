import { defineConfig } from "drizzle-kit"

/*
 * drizzle-kit configuration (database-schema.md "Migration & seed plan"):
 * - `generate` reads src/server/db/schema.ts and emits committed SQL into drizzle/.
 * - `migrate` applies drizzle/ to DATABASE_URL (locally via `pnpm db:local`,
 *   in Phase 7 against prod — explicit, never auto-run on deploy).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5433/sheet_zaber",
  },
  strict: true,
  verbose: true,
})
