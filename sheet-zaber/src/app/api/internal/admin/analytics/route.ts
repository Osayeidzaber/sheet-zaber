import { internalError, ok } from "@/lib/action-result"
import { getPlatformStats, type PlatformRange } from "@/server/db/queries/platform-stats"
import { methodNotAllowed } from "@/server/http/request"
import { ownerRoute } from "@/server/http/internal-route"

/*
 * `GET /api/internal/admin/analytics` (`backend-api-contract.md` §2 Admin — "platform totals:
 * users, active, connections, spreadsheets, APIs, requests, error rate").
 *
 * The tile is a read of whole tables, so the only thing decided here is the optional window:
 * `?from`/`?to` bound `requests`/`errorRate` (the §4.6 `OverviewRange` spelling), while the entity
 * counts are always platform-wide — an admin panel that hides "how many APIs exist" because a date
 * was typed would be a worse panel. Dates are `YYYY-MM-DD` or ISO datetime; a bad one is ignored
 * rather than guessed at, because the range has no field errors of its own to report — see
 * `src/server/logs/service.ts` for the validating copy of the same rule.
 */

export const dynamic = "force-dynamic"

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 86_400_000

/**
 * Date-only means the whole UTC day, and `to` is exclusive, so it becomes the next midnight.
 * A calendar-impossible day (`2026-02-30`) would roll over in `Date.UTC`, so the round trip is
 * checked and the value dropped rather than guessed at.
 */
function bound(value: string | null, side: "from" | "to"): Date | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined

  const parts = DATE_ONLY_RE.exec(trimmed)
  if (parts !== null) {
    const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
    const start = Date.UTC(year, month - 1, day)
    const midnight = new Date(start)
    if (
      midnight.getUTCFullYear() !== year ||
      midnight.getUTCMonth() !== month - 1 ||
      midnight.getUTCDate() !== day
    ) {
      return undefined
    }
    return side === "from" ? midnight : new Date(start + MS_PER_DAY)
  }

  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? undefined : new Date(parsed)
}

const handler = ownerRoute(async (ctx) => {
  const range: PlatformRange = {
    from: bound(ctx.url.searchParams.get("from"), "from"),
    to: bound(ctx.url.searchParams.get("to"), "to"),
  }
  try {
    return ok(await getPlatformStats(range))
  } catch {
    return internalError()
  }
})

export function GET(req: Request): Promise<Response> {
  return handler(req)
}

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
