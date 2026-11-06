import { existsSync } from "node:fs"

import pg from "pg"

import { pgConnectionConfig } from "../src/lib/db-connection"

/*
 * `pnpm db:prune`: the retention sweep behind the privacy policy's stated window. Deletes request
 * logs older than `LOG_RETENTION_DAYS` (default 90) and rate buckets older than two days (the longest
 * window is one day). Nothing runs this automatically: schedule it where the app is deployed.
 *
 * It uses `pg` directly because `src/server/**` is `server-only` and cannot load under tsx.
 */

if (existsSync(".env.local")) process.loadEnvFile(".env.local")

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is not set")

const days = Number(process.env.LOG_RETENTION_DAYS ?? 90)
if (!Number.isInteger(days) || days < 1) throw new Error("LOG_RETENTION_DAYS must be a whole number of 1 or more")

const client = new pg.Client(pgConnectionConfig(url, process.env.DATABASE_CA_CERT))

await client.connect()
try {
  const logs = await client.query(
    "delete from api_request_logs where created_at < now() - make_interval(days => $1::int)",
    [days]
  )
  const buckets = await client.query("delete from rate_limit_buckets where window_start < now() - interval '2 days'")
  console.log(`Pruned ${logs.rowCount ?? 0} request logs older than ${days} days and ${buckets.rowCount ?? 0} rate buckets.`)
} finally {
  await client.end()
}
