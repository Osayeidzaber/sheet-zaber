/*
 * Display formatters. Every value rendered from the API passes through here so the
 * dashboard reads as one voice: tabular figures, one date style, one unit style.
 */

const numberFormat = new Intl.NumberFormat("en-US")

export function formatNumber(value: number): string {
  return numberFormat.format(value)
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  return `${value.toFixed(digits)}%`
}

/** `143 ms` under a second, `1.2 s` above it — the two units a latency table needs. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" })

const fullFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
})

/** `05 Nov, 14:32` — the column width stays stable because day numbers are padded. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  return dateTimeFormat.format(new Date(iso))
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—"
  return dayFormat.format(new Date(iso))
}

/** Unambiguous timestamp for `title` attributes and detail screens. */
export function formatFull(iso: string | null | undefined): string {
  if (!iso) return "—"
  return fullFormat.format(new Date(iso))
}

/**
 * Compact relative text. Rendered only in client components: the same string computed
 * on the server and again on the client can differ, so a Server Component must use
 * formatDateTime instead.
 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "—"
  const seconds = Math.round((now - then) / 1000)
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 31) return `${days} d ago`
  return formatDay(iso)
}

/** `0f4c1a…b7d2` — uuid-shaped ids stay scannable, with the full value in `title`. */
export function shortId(value: string | null | undefined, head = 6, tail = 4): string {
  if (!value) return "—"
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`)
}

/** `12 · endpoints` style meta rows, joined with the reference's own separator. */
export function meta(...parts: Array<string | number | null | undefined>): string {
  return parts.filter((part) => part !== null && part !== undefined && part !== "").join(" · ")
}
