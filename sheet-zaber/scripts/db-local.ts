import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { createConnection } from "node:net"
import { join } from "node:path"

import EmbeddedPostgres from "embedded-postgres"
import { Client } from "pg"

/*
 * `pnpm db:local` — persistent embedded Postgres for local development
 * (no Docker on this machine). Boots PostgreSQL 16 in `.pg-local/` on port 5433,
 * creates the `sheet_zaber` database on first run, prints the DATABASE_URL to
 * paste into `.env.local`, then waits until Ctrl+C.
 *
 * The cluster survives restarts (persistent: true) — wipe it by deleting
 * `.pg-local/` for a fresh start. Migrations: `pnpm drizzle-kit migrate`.
 */

const PORT = Number(process.env.DB_LOCAL_PORT ?? 5433)
const HOST = "127.0.0.1"
const DATA_DIR = join(process.cwd(), ".pg-local")
const DATABASE = process.env.DB_LOCAL_NAME ?? "sheet_zaber"
const USER = "postgres"
const PASSWORD = "postgres"

function clusterExists(): boolean {
  return existsSync(join(DATA_DIR, "PG_VERSION"))
}

/** Fail fast with a friendly message when something already owns the port. */
async function assertPortFree(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: HOST, port: PORT })
    socket.once("connect", () => {
      socket.destroy()
      reject(new Error(`Port ${PORT} is already in use — is another db:local (or Postgres) running?`))
    })
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve()
      else reject(error)
    })
  })
}

/** Create the target database if it does not exist (maintenance-db connect). */
async function ensureDatabase(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE])
    if (rows.length > 0) return false
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(DATABASE)}`)
    return true
  } finally {
    await client.end()
  }
}

async function main(): Promise<void> {
  await assertPortFree()
  await mkdir(DATA_DIR, { recursive: true })

  const postgres = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    persistent: true, // data stays in .pg-local/ between runs
    port: PORT,
    user: USER,
    password: PASSWORD,
    autoRehydrateSymlinks: true, // Windows binary libs ship as symlinks
    onLog: (message) => console.log(`[pg] ${message}`),
    onError: (message) => console.error(`[pg] ${message}`),
  })

  const firstRun = !clusterExists()
  if (firstRun) {
    console.log(`Initialising cluster in ${DATA_DIR} ...`)
    await postgres.initialise()
  }
  await postgres.start()

  const adminUrl = `postgresql://${USER}:${PASSWORD}@${HOST}:${PORT}/postgres`
  const created = await ensureDatabase(adminUrl)
  if (created) console.log(`Created database "${DATABASE}".`)

  const databaseUrl = `postgresql://${USER}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}`
  console.log("")
  console.log("Local Postgres is up. Add to .env.local:")
  console.log(`  DATABASE_URL=${databaseUrl}`)
  console.log("")
  console.log(`Then: pnpm drizzle-kit migrate   (Ctrl+C stops the server)`)

  const stop = () => {
    console.log("\nStopping embedded Postgres ...")
    void postgres
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("Failed to stop cleanly:", String(error))
        process.exit(1)
      })
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

main().catch((error: unknown) => {
  console.error("db-local failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
