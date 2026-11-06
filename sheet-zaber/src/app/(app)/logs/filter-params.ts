/*
 * Log filter query-string contract. Every filter and the pagination live in the URL, so a logs
 * view is a shareable link and there is no client-side filtering to fake (`page.tsx` reads these
 * and calls `listRequestLogs` with server-side conditions only).
 *
 * Validation is the shared `logQuerySchema` (`src/lib/schemas.ts:107`, which extends
 * `paginationSchema` at line 13) — applied per key so one mistyped parameter cannot silently
 * discard the filters that were valid. Rejected values are reported to the user rather than
 * replaced with a guess.
 */

import { logQuerySchema, paginationSchema, METHOD_VALUES } from "@/lib/schemas"
import type { LogStatusFilter } from "@/server/db/queries/logs"

export type SearchParamsValue = Record<string, string | string[] | undefined>

/** What the controls echo: raw text, `""` meaning "absent", `"all"` meaning "no status filter". */
export type LogFilterValues = {
  status: "all" | LogStatusFilter
  apiId: string
  method: string
  from: string
  to: string
  limit: number
  offset: number
}

/** Conditions handed to `listRequestLogs` (`src/server/db/queries/logs.ts:103`). */
export type LogQueryFilter = {
  status?: LogStatusFilter
  apiId?: string
  method?: string
  from?: Date
  /** EXCLUSIVE upper bound (`logWhere` uses `lt`), one UTC day past the picked `to`. */
  to?: Date
  page: number
  perPage: number
}

export type ParsedLogQuery = {
  values: LogFilterValues
  filter: LogQueryFilter
  /** Param name → the raw text that was rejected. Non-empty means nothing was queried. */
  invalid: Record<string, string>
  /** Filter params the URL actually set, so "no rows" can be told apart from "no traffic". */
  activeFilters: number
}

const RAW_KEYS = ["status", "apiId", "method", "from", "to", "limit", "offset"] as const
const STATUS_VALUES: readonly string[] = ["all", "success", "failed"]
/** `paginationSchema`'s own default (`src/lib/schemas.ts:14`), used to keep URLs tidy. */
export const DEFAULT_LOG_LIMIT = paginationSchema.shape.limit.parse(undefined)

function first(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

function baseValues(): LogFilterValues {
  return { status: "all", apiId: "", method: "", from: "", to: "", limit: DEFAULT_LOG_LIMIT, offset: 0 }
}

/**
 * `from` is inclusive and `to` is exclusive in the query builder (`src/server/db/queries/logs.ts:64`),
 * so the day a user picks in `to` would be dropped. Advancing the bound to the next UTC midnight
 * makes the picked day inclusive, which is what the control's label promises.
 */
function nextUtcDay(value: Date): Date {
  return new Date(value.getTime() + 24 * 60 * 60 * 1000)
}

export function parseLogQuery(searchParams: SearchParamsValue): ParsedLogQuery {
  const values = baseValues()
  const invalid: Record<string, string> = {}
  const accepted: Record<string, string> = {}

  for (const key of RAW_KEYS) {
    const raw = first(searchParams[key])
    if (raw === undefined || raw.trim() === "") continue
    const value = raw.trim()

    // `all` is the control's "no status filter" word, not a `LogStatusFilter` value.
    if (key === "status" && value === "all") {
      values.status = "all"
      continue
    }

    const part: (typeof logQuerySchema.shape)[keyof typeof logQuerySchema.shape] | undefined =
      logQuerySchema.shape[key]
    const result = part === undefined ? { success: false as const } : part.safeParse(value)
    if (!result.success) {
      invalid[key] = value
      continue
    }
    accepted[key] = value
  }

  const parsed = logQuerySchema.safeParse(accepted)
  if (!parsed.success) {
    // Unreachable by construction — every key in `accepted` passed its own schema part — but a
    // corrupt URL must never become a 500, so the page falls back to unfiltered defaults.
    for (const key of RAW_KEYS) if (!(key in invalid)) invalid[key] = "unusable combination"
    return { values, filter: { page: 1, perPage: DEFAULT_LOG_LIMIT }, invalid, activeFilters: 0 }
  }

  const data = parsed.data
  if (data.status !== undefined) values.status = data.status
  if (data.apiId !== undefined) values.apiId = data.apiId
  if (data.method !== undefined) values.method = data.method
  if (data.from !== undefined) values.from = data.from.toISOString().slice(0, 10)
  if (data.to !== undefined) values.to = data.to.toISOString().slice(0, 10)
  values.limit = data.limit
  values.offset = data.offset

  // Pagination is page-shaped downstream: floor the offset onto a page boundary so `page` is exact.
  const perPage = data.limit
  const offset = Math.floor(data.offset / perPage) * perPage
  values.offset = offset

  const filter: LogQueryFilter = { page: offset / perPage + 1, perPage }
  if (values.status !== "all") filter.status = values.status
  if (values.apiId !== "") filter.apiId = values.apiId
  if (values.method !== "") filter.method = values.method
  if (data.from !== undefined) filter.from = data.from
  if (data.to !== undefined) filter.to = nextUtcDay(data.to)

  let activeFilters = 0
  for (const key of ["status", "apiId", "method", "from", "to"] as const) {
    if (values[key] !== "" && values[key] !== "all") activeFilters += 1
  }

  return { values, filter, invalid, activeFilters }
}

export function logsHref(values: LogFilterValues, patch: Partial<LogFilterValues>): string {
  const next: LogFilterValues = { ...values, ...patch }
  const params = new URLSearchParams()
  if (next.status !== "all") params.set("status", next.status)
  if (next.apiId !== "") params.set("apiId", next.apiId)
  if (next.method !== "") params.set("method", next.method)
  if (next.from !== "") params.set("from", next.from)
  if (next.to !== "") params.set("to", next.to)
  if (next.limit !== DEFAULT_LOG_LIMIT) params.set("limit", String(next.limit))
  if (next.offset !== 0) params.set("offset", String(next.offset))
  const query = params.toString()
  return query === "" ? "/logs" : `/logs?${query}`
}

/** Echo-safe value for a `<select>`: an option the URL names that does not exist cannot be shown. */
export function selectValue(value: string, allowed: readonly string[]): string {
  return allowed.includes(value) ? value : allowed[0] ?? ""
}

export const LOG_METHOD_OPTIONS = METHOD_VALUES.map((method) => ({ value: method, label: method }))
export const LOG_STATUS_OPTIONS = STATUS_VALUES.map((status) => ({
  value: status,
  label: status === "all" ? "Any result" : status === "success" ? "Success only (< 400)" : "Failed only (>= 400)",
}))

/** Row-count options. `paginationSchema` allows 1-200; these are the useful stops inside it. */
export const LOG_LIMIT_OPTIONS = [25, 50, 100, 200].map((limit) => ({
  value: String(limit),
  label: `${limit} rows`,
}))
