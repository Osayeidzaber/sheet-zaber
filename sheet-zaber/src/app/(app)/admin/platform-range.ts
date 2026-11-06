import "server-only"

import { formatDay } from "@/lib/format"
import type { PlatformRange } from "@/server/db/queries/platform-stats"

/*
 * The optional traffic window for `/admin`, read from `?from`/`?to`.
 *
 * The semantics are `GET /api/internal/admin/analytics`'s own (`src/app/api/internal/admin/analytics/
 * route.ts:20-50`) and are reproduced here rather than imported because the route file is a route
 * adapter, not a shared module: date-only `YYYY-MM-DD` means the whole UTC day, `to` is EXCLUSIVE and
 * becomes the next midnight, and a value that cannot be parsed — including a calendar-impossible day
 * like `2026-02-30`, which `Date.UTC` would happily roll over — is dropped rather than guessed at.
 *
 * The one thing this file adds is honesty about the drop: the route has no field errors to report a
 * bad window through, so a page that silently showed a wider window than the owner typed would be
 * lying about a number. `invalid` therefore travels back to the page, which names the value it
 * ignored.
 */

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 86_400_000

export type AdminWindow = {
  /** Passed to `getPlatformStats`. Empty when the whole platform history is in scope. */
  range: PlatformRange
  /** True when `?from`/`?to` bound at least one edge of the traffic tiles. */
  bounded: boolean
  /** `since inception`, or the two validated day labels the owner asked for. */
  label: string
  /** Raw values that were present but unreadable, so the page can say what it ignored. */
  invalid: { from: string | null; to: string | null }
  /** The untouched query values, so the window form re-renders with what the owner asked for. */
  raw: { from: string | null; to: string | null }
}

function first(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** `bound()` in the route's own shape: undefined means "no bound", never "guess". */
function bound(value: string | null, side: "from" | "to"): Date | undefined {
  if (value === null) return undefined

  const parts = DATE_ONLY_RE.exec(value)
  if (parts !== null) {
    const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
    const start = Date.UTC(year, month - 1, day)
    const midnight = new Date(start)
    const impossible =
      midnight.getUTCFullYear() !== year ||
      midnight.getUTCMonth() !== month - 1 ||
      midnight.getUTCDate() !== day
    return impossible ? undefined : side === "from" ? midnight : new Date(start + MS_PER_DAY)
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed)
}

/** Day label for the raw value the owner typed — the bound itself is exclusive, the label is not. */
function dayLabel(value: string, fallback: string): string {
  const date = new Date(DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value)
  return Number.isNaN(date.getTime()) ? fallback : formatDay(date.toISOString())
}

export function readAdminWindow(raw: {
  from?: string | string[]
  to?: string | string[]
}): AdminWindow {
  const fromText = first(raw.from)
  const toText = first(raw.to)
  const from = bound(fromText, "from")
  const to = bound(toText, "to")

  const invalid = {
    from: fromText !== null && from === undefined ? fromText : null,
    to: toText !== null && to === undefined ? toText : null,
  }

  const bounded = from !== undefined || to !== undefined
  const label = !bounded
    ? "since inception"
    : `${fromText !== null ? dayLabel(fromText, "—") : "start"} – ${
        toText !== null ? dayLabel(toText, "—") : "now"
      }`

  return {
    range: { from, to },
    bounded,
    label,
    invalid,
    raw: { from: fromText, to: toText },
  }
}
