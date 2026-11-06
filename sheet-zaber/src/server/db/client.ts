import "server-only"

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import pg from "pg"

import { pgConnectionConfig } from "@/lib/db-connection"
import { env } from "@/lib/env"

import * as schema from "./schema"

/*
 * Database client (architecture.md §6): Drizzle over node-postgres, pooled with
 * `max: 5` (Vercel function concurrency), TLS for anything that is not a local
 * instance. The server certificate is always verified: set `DATABASE_CA_CERT` to the provider's CA
 * (PEM, literal `\n` allowed) when it is not in Node's default trust store, as with Supabase.
 *
 * Lazy by design: `pg.Pool` is constructed on first access and never connects
 * until the first query, so importing this module during `next build` (or any
 * static analysis pass) cannot require a live database.
 */

export type Db = NodePgDatabase<typeof schema>

let pool: pg.Pool | undefined
let instance: Db | undefined

/** The shared pg.Pool — created on first use, never at import time. */
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ ...pgConnectionConfig(env.DATABASE_URL, env.DATABASE_CA_CERT), max: 5 })
  }
  return pool
}

/** The Drizzle instance bound to the full schema — created on first use. */
export function getDb(): Db {
  if (!instance) {
    instance = drizzle(getPool(), { schema })
  }
  return instance
}

/**
 * Lazily-initialized `db`: every property access resolves the real Drizzle
 * instance on first use, keeping module import free of connections and env
 * validation timing issues at build time.
 */
export const db: Db = new Proxy({} as Db, {
  get: (_target, property) => Reflect.get(getDb(), property),
  has: (_target, property) => Reflect.has(getDb(), property),
})
