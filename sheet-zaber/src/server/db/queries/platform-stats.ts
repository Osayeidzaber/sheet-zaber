import "server-only"

import { and, gte, lt, sql, type SQL } from "drizzle-orm"

import { db } from "../client"
import {
  apiConfigurations,
  apiRequestLogs,
  googleConnections,
  registeredSpreadsheets,
  users,
} from "../schema"
import { type DbLike, type DbTx } from "./types"

/*
 * The owner analytics tile (`backend-api-contract.md` §2 "GET /api/internal/admin/analytics").
 * Every number is a COUNT over the real tables — never a constant, never a sample — and the only
 * arithmetic is the error rate, whose 0/0 is pinned to 0: an empty database must read as zeroes,
 * because `NaN` serializes to `null` in JSON and would break the tile (and any test on it).
 */

export type PlatformRange = { from?: Date; to?: Date }

export type PlatformStats = {
  users: number
  /** `users.status = 'active'`; the remainder are disabled accounts whose sessions are already dead. */
  activeUsers: number
  connections: number
  spreadsheets: number
  apis: number
  requests: number
  failedRequests: number
  /** `failedRequests / requests`, rounded to 4 decimals; 0 when there are no requests. */
  errorRate: number
}

function client(q?: DbLike | DbTx): DbLike {
  return q === undefined ? db : q
}

/** `failed / total`, with the empty case answered as 0 rather than NaN/Infinity. */
export function errorRateOf(total: number, failed: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  const rate = failed / total
  return Number.isFinite(rate) ? Math.round(rate * 10_000) / 10_000 : 0
}

function logWhere(range?: PlatformRange): SQL | undefined {
  const conditions: SQL[] = []
  if (range?.from !== undefined) conditions.push(gte(apiRequestLogs.createdAt, range.from))
  if (range?.to !== undefined) conditions.push(lt(apiRequestLogs.createdAt, range.to))
  return conditions.length === 0 ? undefined : and(...conditions)
}

/**
 * The whole tile in one statement per table, issued together: `count(*) FILTER (…)` gives the
 * active-user split and the 4xx/5xx split without a second pass, so the error rate and its two
 * operands come from the same read.
 */
export async function getPlatformStats(
  range?: PlatformRange,
  q?: DbLike | DbTx
): Promise<PlatformStats> {
  const c = client(q)
  const where = logWhere(range)

  const [accounts, connections, sheets, apis, logs] = await Promise.all([
    c
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${users.status} = 'active')::int`,
      })
      .from(users)
      .then((rows) => rows[0]),
    c
      .select({ total: sql<number>`count(*)::int` })
      .from(googleConnections)
      .then((rows) => rows[0]),
    c
      .select({ total: sql<number>`count(*)::int` })
      .from(registeredSpreadsheets)
      .then((rows) => rows[0]),
    c
      .select({ total: sql<number>`count(*)::int` })
      .from(apiConfigurations)
      .then((rows) => rows[0]),
    c
      .select({
        total: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where ${apiRequestLogs.statusCode} >= 400)::int`,
      })
      .from(apiRequestLogs)
      .where(where)
      .then((rows) => rows[0]),
  ])

  const requests = logs?.total ?? 0
  const failedRequests = logs?.failed ?? 0

  return {
    users: accounts?.total ?? 0,
    activeUsers: accounts?.active ?? 0,
    connections: connections?.total ?? 0,
    spreadsheets: sheets?.total ?? 0,
    apis: apis?.total ?? 0,
    requests,
    failedRequests,
    errorRate: errorRateOf(requests, failedRequests),
  }
}
