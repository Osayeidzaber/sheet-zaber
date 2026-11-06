import "server-only"

import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm"

import type { ErrorCategory } from "@/lib/action-result"

import { db } from "../client"
import { apiConfigurations, apiKeys, apiRequestLogs, users } from "../schema"
import { type DbLike, type DbTx, type Paged } from "./types"

export type RequestLogRow = typeof apiRequestLogs.$inferSelect
/** Column-for-column (`backend-api-contract.md` §4.6) plus the joined API display name. */
export type LogRow = RequestLogRow
export type LogStatusFilter = "success" | "failed"

export type RequestLogInput = {
  apiId?: string | null
  userId?: string | null
  apiKeyId?: string | null
  method: string
  path: string
  statusCode: number
  durationMs: number
  requestBytes?: number | null
  errorCategory?: ErrorCategory | null
  origin?: string | null
}

export type ListLogsFilter = {
  userId?: string
  apiId?: string
  method?: string
  status?: LogStatusFilter
  from?: Date
  to?: Date
  /** 1-based page number. */
  page: number
  perPage: number
}

/**
 * Scoped to one user when `userId` is present; platform-wide when it is absent (the owner view
 * of `backend-api-contract.md` §2 "user: own; owner: all"). The service decides WHO the scope is;
 * this layer only knows whether a `user_id` predicate belongs in the WHERE.
 */
export type AnalyticsScope = { userId?: string }

export type AnalyticsOverview = {
  requests: number
  success: number
  failed: number
  byDay: { day: string; count: number }[]
}

export type ApiAnalyticsRow = {
  apiId: string
  name: string
  count: number
  errors: number
}

/**
 * Every function takes an optional client so a service can run it inside its transaction.
 * `DbLike` is a structural `Pick` of `Db`, so a `DbTx` is already assignable — no cast.
 */
function client(q?: DbLike | DbTx): DbLike {
  return q === undefined ? db : q
}

/** `from`/`to` are inclusive/exclusive so adjacent ranges never double-count a row. */
function logWhere(filter: ListLogsFilter): SQL | undefined {
  const conditions: SQL[] = []
  if (filter.userId !== undefined) conditions.push(eq(apiRequestLogs.userId, filter.userId))
  if (filter.apiId !== undefined) conditions.push(eq(apiRequestLogs.apiId, filter.apiId))
  if (filter.method !== undefined) conditions.push(eq(apiRequestLogs.method, filter.method))
  if (filter.status === "failed") conditions.push(gte(apiRequestLogs.statusCode, 400))
  if (filter.status === "success") conditions.push(lt(apiRequestLogs.statusCode, 400))
  if (filter.from !== undefined) conditions.push(gte(apiRequestLogs.createdAt, filter.from))
  if (filter.to !== undefined) conditions.push(lt(apiRequestLogs.createdAt, filter.to))
  return conditions.length === 0 ? undefined : and(...conditions)
}

/**
 * Append-only metadata: never a body, header, key, token or cell value (spec §10).
 * The `id` PK is a Postgres identity, so it is absent from the values.
 */
export async function insertRequestLog(
  input: RequestLogInput,
  q?: DbLike | DbTx
): Promise<RequestLogRow> {
  const [row] = await client(q)
    .insert(apiRequestLogs)
    .values({
      apiId: input.apiId ?? null,
      // Snapshotted here so every writer gets it and the name survives the API's deletion.
      apiName: input.apiId
        ? sql`(select ${apiConfigurations.name} from ${apiConfigurations} where ${apiConfigurations.id} = ${input.apiId})`
        : null,
      userId: input.userId ?? null,
      userEmail: input.userId
        ? sql`(select ${users.email} from ${users} where ${users.id} = ${input.userId})`
        : null,
      apiKeyId: input.apiKeyId ?? null,
      method: input.method,
      path: input.path,
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      requestBytes: input.requestBytes ?? null,
      errorCategory: input.errorCategory ?? null,
      origin: input.origin ?? null,
    })
    .returning()
  return row
}

/** Newest first; `total` is the COUNT of the same filter, so every page reports the same number. */
export async function listRequestLogs(
  filter: ListLogsFilter,
  q?: DbLike | DbTx
): Promise<Paged<LogRow>> {
  const where = logWhere(filter)
  const c = client(q)

  const rows = await c
    .select()
    .from(apiRequestLogs)
    .where(where)
    .orderBy(desc(apiRequestLogs.id))
    .limit(filter.perPage)
    .offset((filter.page - 1) * filter.perPage)

  const [counted] = await c
    .select({ total: sql<number>`count(*)::int` })
    .from(apiRequestLogs)
    .where(where)

  return {
    rows,
    total: counted?.total ?? 0,
  }
}

/**
 * `from`/`to` bound the window; `userId` additionally binds it to one account. `undefined`
 * userId is the platform-wide (owner) scope, so the same two aggregates serve both views.
 */
function analyticsWhere(from: Date, to: Date, userId: string | undefined): SQL | undefined {
  const conditions: SQL[] = [gte(apiRequestLogs.createdAt, from), lt(apiRequestLogs.createdAt, to)]
  if (userId !== undefined) conditions.push(eq(apiRequestLogs.userId, userId))
  return and(...conditions)
}

/**
 * All three counts and the day series come from the same scoped filter, so the UI can assert
 * `success + failed === requests` and that `byDay` sums to `requests`. `::int` keeps pg from
 * handing bigint back as a string.
 */
export async function analyticsOverview(
  userId: string,
  from: Date,
  to: Date,
  q?: DbLike | DbTx
): Promise<AnalyticsOverview> {
  return overviewForScope({ userId }, from, to, q)
}

/**
 * The scoped variant: `scope.userId` present = one account (the `user` view), absent = the whole
 * platform (the `owner` view). `analyticsOverview` is this function with the userId pinned.
 */
export async function overviewForScope(
  scope: AnalyticsScope,
  from: Date,
  to: Date,
  q?: DbLike | DbTx
): Promise<AnalyticsOverview> {
  const where = analyticsWhere(from, to, scope.userId)
  const c = client(q)
  const status = apiRequestLogs.statusCode

  const [totals] = await c
    .select({
      requests: sql<number>`count(*)::int`,
      success: sql<number>`count(*) filter (where ${status} < 400)::int`,
      failed: sql<number>`count(*) filter (where ${status} >= 400)::int`,
    })
    .from(apiRequestLogs)
    .where(where)

  const day = sql<string>`to_char(${apiRequestLogs.createdAt}, 'YYYY-MM-DD')`
  const byDay = await c
    .select({ day, count: sql<number>`count(*)::int` })
    .from(apiRequestLogs)
    .where(where)
    .groupBy(day)
    .orderBy(asc(day))

  return {
    requests: totals?.requests ?? 0,
    success: totals?.success ?? 0,
    failed: totals?.failed ?? 0,
    byDay: byDay.map((row) => ({ day: row.day, count: row.count })),
  }
}

/**
 * One row per API that has logs. The payload's key set is the contract (`apiId, name, count,
 * errors`) — the dashboard derives rates from it, so no extra field may leak in here.
 */
export async function analyticsByApi(userId: string, q?: DbLike | DbTx): Promise<ApiAnalyticsRow[]> {
  return apiUsageForScope({ userId }, q)
}

/**
 * The scoped variant of `analyticsByApi`: `scope.userId` absent aggregates every account's rows,
 * which is what the owner-facing `GET /api/internal/analytics/apis` shows.
 */
export async function apiUsageForScope(
  scope: AnalyticsScope,
  q?: DbLike | DbTx
): Promise<ApiAnalyticsRow[]> {
  const count = sql<number>`count(*)::int`
  const rows = await client(q)
    .select({
      apiId: apiConfigurations.id,
      name: apiConfigurations.name,
      count,
      errors: sql<number>`count(*) filter (where ${apiRequestLogs.statusCode} >= 400)::int`,
    })
    .from(apiRequestLogs)
    .innerJoin(apiConfigurations, eq(apiRequestLogs.apiId, apiConfigurations.id))
    .where(scope.userId === undefined ? undefined : eq(apiRequestLogs.userId, scope.userId))
    .groupBy(apiConfigurations.id, apiConfigurations.name)
    .orderBy(desc(count), asc(apiConfigurations.name))

  return rows
}

/** Retention sweep (`LOG_RETENTION_DAYS`); returns how many rows it deleted. */
export type UsageBreakdown = AnalyticsOverview & {
  /** `YYYY-MM-DDTHH` in UTC; hours with no requests are absent. */
  byHour: { hour: string; count: number }[]
  byApi: { apiId: string | null; label: string; count: number; failed: number }[]
  byKey: { label: string; count: number; failed: number }[]
  byOrigin: { label: string; count: number; failed: number }[]
}

/**
 * One account's usage for the overview. `apiId` narrows everything except `byApi`, which always
 * compares all of the account's endpoints. `hourFrom` bounds the hourly series.
 */
export async function usageBreakdown(
  filter: { userId: string; apiId?: string },
  from: Date,
  to: Date,
  hourFrom: Date,
  q?: DbLike | DbTx
): Promise<UsageBreakdown> {
  const c = client(q)
  const logs = apiRequestLogs
  const window = (apiId?: string) => logWhere({ userId: filter.userId, apiId, from, to, page: 1, perPage: 1 })
  const where = window(filter.apiId)
  const count = sql<number>`count(*)::int`
  const failed = sql<number>`(count(*) filter (where ${logs.statusCode} >= 400))::int`
  const success = sql<number>`(count(*) filter (where ${logs.statusCode} < 400))::int`
  const day = sql<string>`to_char(${logs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`
  const hour = sql<string>`to_char(${logs.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24')`
  const apiLabel = sql<string>`coalesce(${logs.apiName}, 'Unknown endpoint')`
  const keyLabel = sql<string>`coalesce(${apiKeys.name}, 'Dashboard or deleted key')`
  const originLabel = sql<string>`coalesce(${logs.origin}, 'Server or direct call')`

  const [[totals], byDay, byHour, byApi, byKey, byOrigin] = await Promise.all([
    c.select({ requests: count, success, failed }).from(logs).where(where),
    c.select({ day, count }).from(logs).where(where).groupBy(day).orderBy(asc(day)),
    c
      .select({ hour, count })
      .from(logs)
      .where(logWhere({ userId: filter.userId, apiId: filter.apiId, from: hourFrom, to, page: 1, perPage: 1 }))
      .groupBy(hour)
      .orderBy(asc(hour)),
    c
      .select({ apiId: logs.apiId, label: apiLabel, count, failed })
      .from(logs)
      .where(window())
      .groupBy(logs.apiId, apiLabel)
      .orderBy(desc(count))
      .limit(8),
    c
      .select({ label: keyLabel, count, failed })
      .from(logs)
      .leftJoin(apiKeys, eq(logs.apiKeyId, apiKeys.id))
      .where(where)
      .groupBy(keyLabel)
      .orderBy(desc(count))
      .limit(8),
    c.select({ label: originLabel, count, failed }).from(logs).where(where).groupBy(originLabel).orderBy(desc(count)).limit(8),
  ])

  return {
    requests: totals?.requests ?? 0,
    success: totals?.success ?? 0,
    failed: totals?.failed ?? 0,
    byDay,
    byHour,
    byApi,
    byKey,
    byOrigin,
  }
}

export async function pruneOldLogs(retentionDays: number, q?: DbLike | DbTx): Promise<number> {
  const deleted = await client(q)
    .delete(apiRequestLogs)
    .where(sql`${apiRequestLogs.createdAt} < now() - make_interval(days => ${retentionDays}::int)`)
    .returning({ id: apiRequestLogs.id })

  return deleted.length
}
