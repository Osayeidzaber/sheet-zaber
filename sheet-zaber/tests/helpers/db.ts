import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { getTableName, isTable } from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import EmbeddedPostgres from "embedded-postgres"
import pg from "pg"
import { inject } from "vitest"

import * as schema from "@/server/db/schema"

/*
 * Ephemeral embedded Postgres for integration tests (no Docker on this machine —
 * `embedded-postgres` ships real PostgreSQL 16 binaries and runs them in-process).
 * Task 2.4 layers truncation-between-files and Google mocks on top of this helper.
 *
 * Lifecycle: startTestDb() → migrateTestDb() → use getTestDbUrl() → stopTestDb().
 */

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url))
const TEST_DATABASE = "sheet_zaber_test"
const TEST_USER = "postgres"
const TEST_PASSWORD = "postgres"

let postgres: EmbeddedPostgres | undefined
let dataDir: string | undefined
let connectionString: string | undefined

/** Reserve an ephemeral free port from the OS (listen on 0, read back, release). */
async function getFreePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine ephemeral port")
  }
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.close(() => resolve())
  })
  return port
}

/**
 * Boot an ephemeral PostgreSQL 16 instance on a random free port with a temp
 * data dir, create the test database, and return its connection string.
 */
export async function startTestDb(): Promise<string> {
  if (connectionString) return connectionString

  const port = await getFreePort()
  dataDir = await mkdtemp(join(tmpdir(), "sheet-zaber-pg-"))
  const startupLogs: string[] = []

  postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: TEST_USER,
    password: TEST_PASSWORD,
    persistent: false, // stop() deletes the data dir — ephemeral by design
    autoRehydrateSymlinks: true, // Windows binaries need lib symlinks hydrated
    onLog: () => {},
    onError: (messageOrError) => {
      startupLogs.push(String(messageOrError))
    },
  })

  try {
    await postgres.initialise()
    await postgres.start()
    await postgres.createDatabase(TEST_DATABASE)
  } catch (error) {
    const detail = startupLogs.length > 0 ? `\nEmbedded PG output:\n${startupLogs.join("\n")}` : ""
    await stopTestDb().catch(() => {})
    throw new Error(`Failed to start embedded Postgres: ${String(error)}${detail}`)
  }

  connectionString = `postgresql://${TEST_USER}:${TEST_PASSWORD}@localhost:${port}/${TEST_DATABASE}`
  return connectionString
}

/** Connection string of the running test instance; throws if not started. */
export function getTestDbUrl(): string {
  if (!connectionString) throw new Error("startTestDb() has not been called")
  return connectionString
}

/** Apply every committed SQL migration in `drizzle/` to the test database. */
export async function migrateTestDb(): Promise<void> {
  const pool = new pg.Pool({ connectionString: getTestDbUrl() })
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await pool.end()
  }
}

/** Stop the ephemeral instance and remove its temp data dir. */
export async function stopTestDb(): Promise<void> {
  const instance = postgres
  const dir = dataDir
  postgres = undefined
  dataDir = undefined
  connectionString = undefined
  if (instance) {
    // With persistent: false, stop() already deletes the cluster files.
    await instance.stop()
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/*
 * Shared-instance layer (Phase 2.4): `tests/setup/db.ts` boots ONE embedded instance in
 * Vitest's main process and publishes its URL through the provide/inject channel, so
 * every worker connects instead of paying the boot cost per file. Isolation between
 * files is `truncateAll()`, which is why the run is serial across files.
 */

export const TEST_DB_URL_KEY = "TEST_DB_URL"

declare module "vitest" {
  interface ProvidedContext {
    TEST_DB_URL: string
  }
}

/** Typed exactly like production's `Db` (`src/server/db/client.ts:20`). */
export type TestDb = NodePgDatabase<typeof schema>

/** Schema-owned tables, read from the Drizzle module so the truncate list cannot drift. */
export const TEST_TABLE_NAMES: readonly string[] = Object.values(schema)
  .filter(isTable)
  .map((table) => getTableName(table))
  .sort()

let sharedPool: pg.Pool | undefined
let sharedDb: TestDb | undefined

function publishedTestDbUrl(): string | undefined {
  try {
    return inject(TEST_DB_URL_KEY)
  } catch {
    return undefined
  }
}

async function resolveConnectionString(): Promise<string> {
  const published = publishedTestDbUrl()
  if (published) return published
  // No globalSetup in this run (bespoke config or standalone script): boot per process.
  await startTestDb()
  await migrateTestDb()
  return getTestDbUrl()
}

/** One lazily-resolved pool per worker process, against the shared instance. */
export async function getTestPool(): Promise<pg.Pool> {
  if (!sharedPool) {
    sharedPool = new pg.Pool({ connectionString: await resolveConnectionString(), max: 5 })
  }
  return sharedPool
}

export async function getTestDb(): Promise<TestDb> {
  if (!sharedDb) {
    sharedDb = drizzle(await getTestPool(), { schema })
  }
  return sharedDb
}

/** Clears every schema-owned table in one statement, restarting identity sequences. */
export async function truncateAll(): Promise<void> {
  const pool = await getTestPool()
  const list = TEST_TABLE_NAMES.map((name) => `"${name}"`).join(", ")
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
}
