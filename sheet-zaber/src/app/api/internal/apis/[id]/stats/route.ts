import { fail, ok } from "@/lib/action-result"
import { getApi } from "@/server/apis/service"
import { analyticsByApi, listRequestLogs } from "@/server/db/queries/logs"
import { userRoute } from "@/server/http/internal-route"
import { methodNotAllowed } from "@/server/http/request"

/*
 * GET /api/internal/apis/{id}/stats?from&to (`backend-api-contract.md` §2, §4.6).
 *
 * Aggregate counters for ONE API's detail page, composed from the existing exported query
 * functions in `src/server/db/queries/logs.ts` — no new repository file and no SQL here.
 * The contract's §4.6 body table sketches `{ overview, usage }`; the per-day `Overview.must`
 * series is NOT expressible per-API (`analyticsOverview` is user-wide), so `overview` carries
 * the exact counts only. `usage` matches the §4.6 `ApiUsageRow` key set, lifetime-scoped.
 *
 * Ownership: `getApi` is owner-scoped and answers "absent" and "not yours" byte-identically
 * (`security.md` §3 item 4) — this route is never an existence oracle. Dates are `YYYY-MM-DD`
 * and inclusive on both ends (the repository treats `to` as exclusive, so it is advanced to
 * the next UTC midnight). No secret of any kind is echoed: messages are fixed strings.
 */

export const dynamic = "force-dynamic"

/** Counts inside `range` (or the whole lifetime when unbounded). */
export type ApiStatsOverview = {
  requests: number
  success: number
  failed: number
}

/** One API's `ApiUsageRow` (§4.6) — lifetime counters, `success + failed === requests`. */
export type ApiUsage = {
  apiId: string
  name: string
  requests: number
  success: number
  failed: number
  /** failed / requests, 0 when requests is 0. */
  errorRate: number
  lastRequestAt: Date | null
}

export type ApiStats = {
  apiId: string
  /** The range actually applied; null on a side means unbounded there. */
  range: { from: string | null; to: string | null }
  overview: ApiStatsOverview
  usage: ApiUsage
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/** Strict `YYYY-MM-DD` → UTC start of day; a rolled-over day (2024-02-30) is rejected too. */
function startOfUtcDay(value: string): Date | null {
  if (!DAY_RE.test(value)) return null
  const parsed = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10))))
  return parsed.toISOString().slice(0, 10) === value ? parsed : null
}

export const GET = userRoute(async (ctx) => {
  // ctx.path is ["apis", "{id}", "stats"] for this route file.
  const apiId = ctx.path.length >= 3 ? ctx.path[1] : undefined
  if (apiId === undefined || apiId === "stats") {
    return fail("not_found", "No API was found with that id.", "not_found")
  }

  const rawFrom = ctx.url.searchParams.get("from") || null
  const rawTo = ctx.url.searchParams.get("to") || null
  const fromDay = rawFrom === null ? null : startOfUtcDay(rawFrom)
  const toDay = rawTo === null ? null : startOfUtcDay(rawTo)

  const fields: Record<string, string> = {}
  if (rawFrom !== null && fromDay === null) fields.from = "from must be a real YYYY-MM-DD date"
  if (rawTo !== null && toDay === null) fields.to = "to must be a real YYYY-MM-DD date"
  if (fromDay !== null && toDay !== null && fromDay.getTime() > toDay.getTime()) {
    fields.from = "from must not be after to"
    fields.to = "to must not be before from"
  }
  if (Object.keys(fields).length > 0) {
    return fail("validation_failed", "The date range is not valid.", "validation", fields)
  }

  // Owner-scoped gate BEFORE any counting: a foreign id fails here with the same envelope
  // an unknown id gets, and no aggregate for another user is ever computed.
  const api = await getApi(apiId, ctx.user.id)
  if (!api.ok) return api

  const from = fromDay ?? undefined
  const to = toDay === null ? undefined : new Date(toDay.getTime() + DAY_MS)
  const scoped = { userId: ctx.user.id, apiId, from, to }

  const [successWindow, failedWindow, newest, usageRows] = await Promise.all([
    listRequestLogs({ ...scoped, status: "success", page: 1, perPage: 1 }),
    listRequestLogs({ ...scoped, status: "failed", page: 1, perPage: 1 }),
    // Lifetime newest row (no range): `rows` is id-desc, so [0] is the last request.
    listRequestLogs({ userId: ctx.user.id, apiId, page: 1, perPage: 1 }),
    analyticsByApi(ctx.user.id),
  ])

  const lifetime = usageRows.find((row) => row.apiId === apiId)
  const requests = lifetime?.count ?? 0
  const failed = lifetime?.errors ?? 0

  return ok({
    apiId,
    range: { from: rawFrom, to: rawTo },
    overview: {
      requests: successWindow.total + failedWindow.total,
      success: successWindow.total,
      failed: failedWindow.total,
    },
    usage: {
      apiId,
      name: api.data.name,
      requests,
      success: requests - failed,
      failed,
      errorRate: requests > 0 ? failed / requests : 0,
      lastRequestAt: newest.rows[0]?.createdAt ?? null,
    },
  } satisfies ApiStats)
})

export function POST(): Response {
  return methodNotAllowed(["GET"])
}

export function PUT(): Response {
  return methodNotAllowed(["GET"])
}

export function PATCH(): Response {
  return methodNotAllowed(["GET"])
}

export function DELETE(): Response {
  return methodNotAllowed(["GET"])
}
