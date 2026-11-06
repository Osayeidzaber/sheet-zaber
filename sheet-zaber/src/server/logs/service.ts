import "server-only"

/*
 * The request-log / analytics READ surface (`backend-api-contract.md` §2 "Logs & analytics",
 * §4.6). Session-scoped, GET-shaped input, and one rule above all others:
 *
 *   SCOPE. A `user`-role session sees ITS OWN rows and nothing else. A `user_id` from the query
 *   string is IGNORED for them — not "rejected when it does not match": ignoring it keeps the
 *   response byte-identical whether or not the caller guessed another account's id, so the route
 *   cannot become an oracle over who exists (`security.md` §3 item 4). An `owner` sees the whole
 *   platform and may narrow it with `?user_id=`.
 *
 *   VALIDATION BEFORE QUERY. Every unparseable parameter is a `validation_failed` (→ 400 through
 *   `internal-route`'s category map, §4.4) with the message under the offending field name. A
 *   malformed `page`/`from`/`method` must never reach the database and never surface as a 500;
 *   no message below echoes a value, an id, SQL or a stack.
 *
 * Naming note: §4.6 also freezes an `Overview` (`must`/`nice`) and an `ApiUsageRow` (`errorRate`,
 * `lastRequestAt`) living in `src/server/logs/analytics.ts`. This module is bound to the
 * repository's own `AnalyticsOverview` / `ApiAnalyticsRow` aggregates — what
 * `src/server/db/queries/logs.ts` computes today — and the divergence is reported, not silently
 * re-decided here.
 */

import { z } from "zod"

import { fail, internalError, ok, type ActionResult } from "@/lib/action-result"
import { METHOD_VALUES } from "@/lib/schemas"
import type { AuthenticatedUser } from "@/server/auth/guards"
import {
  analyticsByApi,
  analyticsOverview,
  apiUsageForScope,
  listRequestLogs,
  overviewForScope,
  type AnalyticsOverview,
  type AnalyticsScope,
  type ApiAnalyticsRow,
  type ListLogsFilter,
  type LogRow,
} from "@/server/db/queries/logs"

/** Normalised query form; `page`/`perPage` are always resolved (§2 `LogQuery`). */
export type LogQuery = {
  apiId?: string
  method?: string
  status?: "success" | "failed"
  /** ISO text (`YYYY-MM-DD` or datetime) as sent; the filter normalises it to a `Date`. */
  from?: string
  to?: string
  /** Owner-only narrowing; a `user` session's value is discarded by `scopeFor`. */
  userId?: string
  page: number
  perPage: number
}

/** The `data` of `GET /api/internal/logs` — a page plus the total the page was cut from. */
export type LogsPage = {
  rows: LogRow[]
  total: number
  page: number
  perPage: number
}

const DEFAULT_PAGE = 1
/** Same ceiling as `paginationSchema.limit`'s max (`src/lib/schemas.ts`), in rows not offset. */
const DEFAULT_PER_PAGE = 50
const MAX_PER_PAGE = 200
/**
 * Default window of `GET /api/internal/analytics/overview` when NEITHER `from` nor `to` is given:
 * the last 30 days. An absent `to` stays unbounded on that side (§4.6 "absent = unbounded"), so a
 * row can never age out of the view because the wall clock moved during the request.
 */
export const DEFAULT_OVERVIEW_DAYS = 30

const MS_PER_DAY = 86_400_000
/** Exclusive-upper-bound sentinel for the repository's `created_at < to`. */
const NO_UPPER_BOUND = new Date("9999-12-31T00:00:00.000Z")

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/
const WHOLE_NUMBER_RE = /^\d+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `YYYY-MM-DD` or an ISO datetime; anything else is a field error, never a `Date` guess. */
const IsoDateParam = z
  .string()
  .refine((value) => DATE_ONLY_RE.test(value) || DATETIME_RE.test(value), {
    message: "must be an ISO date (YYYY-MM-DD) or datetime",
  })

const UuidParam = z.string().refine((value) => UUID_RE.test(value), { message: "must be a uuid" })

const logsRequestSchema = z.object({
  apiId: UuidParam.optional(),
  method: z.enum(METHOD_VALUES).optional(),
  status: z.enum(["success", "failed"]).optional(),
  from: IsoDateParam.optional(),
  to: IsoDateParam.optional(),
  user_id: UuidParam.optional(),
  // Parsed below, not by zod: a page number needs "whole and ≥1" in one message, and coercion
  // would let `""`/`"  1 "` through as a legitimate value.
  page: z.string().optional(),
  per_page: z.string().optional(),
})

const overviewRequestSchema = z.object({
  from: IsoDateParam.optional(),
  to: IsoDateParam.optional(),
  user_id: UuidParam.optional(),
})

/** zod's path → the `fields` map §4.4 defines; the first message per field wins. */
function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const key =
      issue.path
        .filter((segment) => typeof segment !== "number")
        .map(String)
        .join(".") || "query"
    if (!(key in fields)) fields[key] = issue.message
  }
  return fields
}

function validationFailed(fields: Record<string, string>): ActionResult<never> {
  return fail("validation_failed", "The query parameters are not valid.", "validation", fields)
}

/** A repeated key keeps its first value, exactly like `URLSearchParams.get()`. */
function firstOf(raw: Record<string, string | string[]>, key: string): string | undefined {
  const value = raw[key]
  const scalar = Array.isArray(value) ? value[0] : value
  if (scalar === undefined) return undefined
  const trimmed = scalar.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Only the declared keys, and only when non-empty: an absent key stays absent so `.optional()`
 * means "not asked for" rather than "asked for, empty".
 */
function pickParams(
  raw: Record<string, string | string[]>,
  keys: readonly string[]
): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of keys) {
    const value = firstOf(raw, key)
    if (value !== undefined) picked[key] = value
  }
  return picked
}

/**
 * THE scope rule (§2 "user: own; owner: all"). The session's DB role — never the cookie's role and
 * never a query parameter — decides whether a caller-supplied `user_id` has any effect.
 */
function scopeFor(user: AuthenticatedUser, requestedUserId?: string): AnalyticsScope {
  if (user.role !== "owner") return { userId: user.id }
  return requestedUserId === undefined ? {} : { userId: requestedUserId }
}

/**
 * `YYYY-MM-DD` names a whole UTC day. `to` is exclusive upstream (`created_at < to`), so a date
 * only `to` becomes the FOLLOWING midnight and the named day stays inside the window; a datetime
 * is used verbatim. A calendar-impossible day (`2026-02-30`) rolls over in `Date.UTC`, so it is
 * rejected by the round-trip check rather than silently becoming March 2.
 */
function toFilterDate(value: string, bound: "from" | "to"): Date | undefined {
  if (!DATE_ONLY_RE.test(value)) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : new Date(parsed)
  }
  const [year, month, day] = value.split("-").map(Number)
  if (year === undefined || month === undefined || day === undefined) return undefined
  const start = Date.UTC(year, month - 1, day)
  const midnight = new Date(start)
  if (
    midnight.getUTCFullYear() !== year ||
    midnight.getUTCMonth() !== month - 1 ||
    midnight.getUTCDate() !== day
  ) {
    return undefined
  }
  return bound === "from" ? midnight : new Date(start + MS_PER_DAY)
}

/** Both bounds, or the field errors that replace them. */
function resolveWindow(parsed: { from?: string; to?: string }, defaultFrom: Date): { from: Date; to: Date } | Record<string, string> {
  const fields: Record<string, string> = {}
  let from = defaultFrom
  let to: Date = NO_UPPER_BOUND

  if (parsed.from !== undefined) {
    const date = toFilterDate(parsed.from, "from")
    if (date === undefined) fields.from = "is not a real date"
    else from = date
  }
  if (parsed.to !== undefined) {
    const date = toFilterDate(parsed.to, "to")
    if (date === undefined) fields.to = "is not a real date"
    else to = date
  }
  return Object.keys(fields).length > 0 ? fields : { from, to }
}

function isWindow(value: { from: Date; to: Date } | Record<string, string>): value is { from: Date; to: Date } {
  return "from" in value && value.from instanceof Date
}

function parsePage(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback
  if (!WHOLE_NUMBER_RE.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function buildFilter(
  scope: AnalyticsScope,
  parsed: z.output<typeof logsRequestSchema>,
  page: number,
  perPage: number
): ListLogsFilter {
  const filter: ListLogsFilter = { page, perPage, ...scope }
  if (parsed.apiId !== undefined) filter.apiId = parsed.apiId
  if (parsed.method !== undefined) filter.method = parsed.method
  if (parsed.status !== undefined) filter.status = parsed.status
  if (parsed.from !== undefined) filter.from = toFilterDate(parsed.from, "from")
  if (parsed.to !== undefined) filter.to = toFilterDate(parsed.to, "to")
  return filter
}

/**
 * `GET /api/internal/logs?apiId&method&status&from&to&page&per_page&user_id`.
 * Newest first; `total` is the COUNT of the same filter, so every page reports the same number.
 */
export async function listLogs(
  user: AuthenticatedUser,
  raw: Record<string, string | string[]>
): Promise<ActionResult<LogsPage>> {
  const parsed = logsRequestSchema.safeParse(
    pickParams(raw, ["apiId", "method", "status", "from", "to", "user_id", "page", "per_page"])
  )
  if (!parsed.success) return validationFailed(zodFields(parsed.error))

  const page = parsePage(parsed.data.page, DEFAULT_PAGE)
  if (page === null || page < DEFAULT_PAGE) {
    return validationFailed({ page: "must be a whole page number of 1 or greater" })
  }
  const perPage = parsePage(parsed.data.per_page, DEFAULT_PER_PAGE)
  if (perPage === null || perPage < 1 || perPage > MAX_PER_PAGE) {
    return validationFailed({ per_page: `must be a whole number of 1 to ${MAX_PER_PAGE}` })
  }

  const window = resolveWindow(parsed.data, new Date(0))
  if (!isWindow(window)) return validationFailed(window)

  const filter = buildFilter(scopeFor(user, parsed.data.user_id), parsed.data, page, perPage)

  try {
    const result = await listRequestLogs(filter)
    return ok({ rows: result.rows, total: result.total, page, perPage })
  } catch {
    return internalError()
  }
}

/**
 * `GET /api/internal/analytics/overview?from&to`. Defaults to the last 30 days (doc comment on
 * `DEFAULT_OVERVIEW_DAYS`); counts and the day series come from one scoped filter, so
 * `success + failed === requests` and `byDay` always sums to `requests`.
 */
export async function overview(
  user: AuthenticatedUser,
  raw: Record<string, string | string[]>
): Promise<ActionResult<AnalyticsOverview>> {
  const parsed = overviewRequestSchema.safeParse(pickParams(raw, ["from", "to", "user_id"]))
  if (!parsed.success) return validationFailed(zodFields(parsed.error))

  const window = resolveWindow(parsed.data, new Date(Date.now() - DEFAULT_OVERVIEW_DAYS * MS_PER_DAY))
  if (!isWindow(window)) return validationFailed(window)

  const scope = scopeFor(user, parsed.data.user_id)

  try {
    // The two repository calls are the same SQL with the user predicate present or absent; which
    // one runs depends only on the session role, never on anything the caller sent.
    const result =
      scope.userId !== undefined
        ? await analyticsOverview(scope.userId, window.from, window.to)
        : await overviewForScope({}, window.from, window.to)
    return ok(result)
  } catch {
    return internalError()
  }
}

/**
 * The `LogQuery` the route's query string normalises TO — exposed so the dashboard (and the
 * playground snippet builder) can build a filter with the same shape the service reads, and so a
 * caller can see that `userId` is only meaningful for an owner.
 */
export function toLogQuery(raw: Record<string, string | string[]>): LogQuery {
  const picked = pickParams(raw, ["apiId", "method", "status", "from", "to", "user_id", "page", "per_page"])
  const query: LogQuery = {
    page: parsePage(picked.page, DEFAULT_PAGE) ?? DEFAULT_PAGE,
    perPage: parsePage(picked.per_page, DEFAULT_PER_PAGE) ?? DEFAULT_PER_PAGE,
  }
  if (picked.apiId !== undefined) query.apiId = picked.apiId
  if (picked.method !== undefined) query.method = picked.method
  if (picked.status !== undefined) query.status = picked.status as "success" | "failed"
  if (picked.from !== undefined) query.from = picked.from
  if (picked.to !== undefined) query.to = picked.to
  if (picked.user_id !== undefined) query.userId = picked.user_id
  return query
}

/**
 * `GET /api/internal/analytics/apis` — the per-API totals, unfiltered: an API with no rows has no
 * row to return, so `[]` means "nothing has run" and the UI renders its own placeholder instead of
 * a fabricated `0`. A `user` session gets its own APIs; an owner gets every API that has logs.
 */
export async function usageByApi(user: AuthenticatedUser): Promise<ActionResult<ApiAnalyticsRow[]>> {
  const scope = scopeFor(user)
  try {
    const rows =
      scope.userId !== undefined ? await analyticsByApi(scope.userId) : await apiUsageForScope({})
    return ok(rows)
  } catch {
    return internalError()
  }
}
