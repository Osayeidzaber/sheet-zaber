/*
 * The analytics window lives in the URL (`/analytics?days=30`), so a view is a link and the numbers
 * on screen can be pointed at. Only four windows are offered, because each one costs real aggregate
 * queries and `analyticsOverview` is a grouped scan — a free-form `days` would let a URL ask for a
 * five-year sweep.
 *
 * A rejected value is reported, not swallowed: the page falls back to the default window AND says so,
 * then labels every figure with the window it actually measured (`days=` is in every panel copy).
 */

export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000

export const ANALYTICS_WINDOWS = [7, 14, 30, 90] as const
export type AnalyticsWindowDays = (typeof ANALYTICS_WINDOWS)[number]

/** The window `overview/page.tsx` uses, so the two pages agree on "recent". */
export const DEFAULT_ANALYTICS_WINDOW: AnalyticsWindowDays = 14

export type SearchParamsValue = Record<string, string | string[] | undefined>

/** Four bounded, adjacent ranges: `[from, to)` and `[previousFrom, previousTo)`, both UTC instants. */
export type AnalyticsWindow = {
  days: AnalyticsWindowDays
  to: Date
  from: Date
  previousFrom: Date
  previousTo: Date
  /** `[now - 1h, now)` — the rolling lookback the hourly budget is read against. */
  hourFrom: Date
  /** `[now - 24h, now)` — the rolling lookback the daily budget is read against. */
  dayFrom: Date
}

export type ParsedAnalyticsWindow = {
  window: AnalyticsWindow
  /** The raw `days` text that was rejected, or `null` when the URL was usable. */
  invalid: string | null
}

function first(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

export function isAnalyticsWindowDays(value: number): value is AnalyticsWindowDays {
  return (ANALYTICS_WINDOWS as readonly number[]).includes(value)
}

export function analyticsHref(days: number): string {
  return days === DEFAULT_ANALYTICS_WINDOW ? "/analytics" : `/analytics?days=${String(days)}`
}

export function windowFor(days: AnalyticsWindowDays, now: Date): AnalyticsWindow {
  return {
    days,
    to: now,
    from: new Date(now.getTime() - days * DAY_MS),
    previousFrom: new Date(now.getTime() - 2 * days * DAY_MS),
    previousTo: new Date(now.getTime() - days * DAY_MS),
    hourFrom: new Date(now.getTime() - HOUR_MS),
    dayFrom: new Date(now.getTime() - DAY_MS),
  }
}

export function parseAnalyticsWindow(
  searchParams: SearchParamsValue,
  now: Date = new Date()
): ParsedAnalyticsWindow {
  const raw = first(searchParams.days)
  if (raw === undefined || raw.trim() === "") {
    return { window: windowFor(DEFAULT_ANALYTICS_WINDOW, now), invalid: null }
  }

  const value = Number(raw.trim())
  if (Number.isInteger(value) && isAnalyticsWindowDays(value)) {
    return { window: windowFor(value, now), invalid: null }
  }
  return { window: windowFor(DEFAULT_ANALYTICS_WINDOW, now), invalid: raw.trim() }
}

/** `<7> days`, spelled for a sentence that begins with it. */
export function windowDaysLabel(days: AnalyticsWindowDays): string {
  return `${String(days)} days`
}
