import { existsSync } from "node:fs"

import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import pg from "pg"

import { pgConnectionConfig } from "../src/lib/db-connection"

/*
 * `pnpm db:deploy`: applies `drizzle/` with the app's own verified TLS settings. Render runs it as
 * the pre-deploy command, so a failed migration stops the release before any traffic moves.
 */

if (existsSync(".env.local")) process.loadEnvFile(".env.local")

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is not set")

const client = new pg.Client(pgConnectionConfig(url, process.env.DATABASE_CA_CERT))
await client.connect()
try {
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" })
  console.log("Migrations applied.")
} finally {
  await client.end()
}
