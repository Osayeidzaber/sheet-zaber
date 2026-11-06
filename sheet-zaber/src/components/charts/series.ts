/** Geometry adapted from FinanceBento (ink-orbit-saas-template), supplied by the project owner on 2026-11-05. Took only its shared `smoothPath` Catmull-Rom helper (lines 200-202), which every taken diagram calls; dropped the module it lived in, the `GR` asset-class colour table (lines 192-199) and the invented history it was fed. The input types below are this app's own: they carry no finance vocabulary and no chart may fabricate a series. */

/**
 * Primitive input types for the chart kit in `src/components/charts/`.
 *
 * Every chart takes one of these shapes and nothing else: no chart imports from
 * `src/server/**`, and no chart knows what a Sheet Zaber row looks like. A page maps its
 * own query result into `SeriesPoint` / `NamedSeries` / `DivergingRow` /
 * `DistributionBucket` / `QuotaReading`, and passes pre-formatted strings for anything
 * the eye reads, so the numbers on screen are the caller's own numbers.
 *
 * The rule the geometry may never break: a chart fabricates nothing. A bucket that is
 * absent stays absent (broken path, no thickness, "—" in the readout), an empty input
 * renders an empty plot instead of a flat line dressed up as a trend, and axis maxima come
 * from the input or from an explicit `domainMax` the caller passes in.
 */

/**
 * Semantic hue only. `elevated` maps to `--warn`, `failed` to `--danger`; anything else
 * that needs to stand out stands out by dash, weight, opacity or pattern - never by colour.
 */
export type ChartTone = "neutral" | "elevated" | "failed"

/** One reading in one time bucket. `t` is the bucket label exactly as the caller words it. */
export interface SeriesPoint {
  readonly t: string
  readonly v: number
}

/** A labelled sequence over time, e.g. requests per bucket for one endpoint. */
export interface NamedSeries {
  readonly name: string
  readonly points: readonly SeriesPoint[]
  /** Optional semantic tone; `elevated` and `failed` are the only colour channels a chart may use. */
  readonly tone?: ChartTone
}

/**
 * A diverging row: two magnitudes for one bucket, plotted on opposite sides of the axis.
 * Both are given as positive magnitudes - the chart decides the side, never the sign - so
 * "3 failed" is written as `3`, not `-3`.
 */
export interface DivergingRow {
  readonly t: string
  /** Above the axis (e.g. requests that succeeded). */
  readonly positive: number
  /** Below the axis (e.g. requests that failed). */
  readonly negative: number
}

/** A used/limit pair for the tick gauge and the tick strip: quota and rate-limit burn. */
export interface QuotaReading {
  readonly used: number
  readonly limit: number
  /** Caller's own early-warning value; at or above it the reading renders `elevated`. */
  readonly warnAt?: number
}

/** One bar of a distribution: requests per bucket, requests per endpoint, status-code counts. */
export interface DistributionBucket {
  readonly label: string
  readonly value: number
  readonly tone?: ChartTone
}

/**
 * KPI tile reading. `value`, `caption` and `detail` are strings the caller has already
 * formatted from real rows; the tile computes nothing.
 */
export interface KpiTileReading {
  readonly caption: string
  readonly value: string
  readonly detail?: string
  readonly chip?: string
  readonly tone?: ChartTone
  /** `solid` inverts the tile (paper field, ink type) - emphasis by weight, not hue. */
  readonly variant?: "line" | "solid"
  /** Optional tick strip under the value: filled = used, remaining = headroom. */
  readonly ticks?: QuotaReading
}

/** Formats a value for display. Called with the untouched input value. */
export type ValueFormatter = (value: number) => string
/** Formats a 0-1 part-to-whole share, which only exists because the caller asked for it. */
export type ShareFormatter = (share: number) => string

/** Fallback formatter: the exact number, stringified. No rounding, no unit invention. */
export const rawValue: ValueFormatter = (value) => String(value)

/** A plot-space coordinate: `[x, y]`. */
export type Point2 = readonly [number, number]

/** Pixel-space rounding for path data only; displayed numbers never pass through here. */
function r(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Catmull-Rom-to-Bezier smoothing with tension `k = 0.17`, the same math and the same
 * endpoint clamp (`P[i-1] || P[i]`, `P[i+2] || P[i+1]`) as the vendored source's
 * `smoothPath` helper (lines 200-202). Returns `""` for no points and a single `M` for one
 * point, so a caller can never accidentally draw an implied trend.
 */
export function smoothPath(points: readonly Point2[], start: "M" | "L" = "M", k = 0.17): string {
  const first = points[0]
  if (first === undefined) return ""
  let d = `${start}${r(first[0])},${r(first[1])}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[i + 2] ?? p2
    d +=
      `C${r(p1[0] + (p2[0] - p0[0]) * k)},${r(p1[1] + (p2[1] - p0[1]) * k)} ` +
      `${r(p2[0] - (p3[0] - p1[0]) * k)},${r(p2[1] - (p3[1] - p1[1]) * k)} ` +
      `${r(p2[0])},${r(p2[1])}`
  }
  return d
}

/**
 * Straight (never smoothed) polyline through points, used when a chart must not imply a
 * curve between two real readings. `""` for none, `M` only for one.
 */
export function linePath(points: readonly Point2[], start: "M" | "L" = "M"): string {
  if (points.length === 0) return ""
  return points.reduce(
    (acc, p, i) => `${acc}${i === 0 ? start : "L"}${r(p[0])},${r(p[1])}`,
    "",
  )
}

/**
 * Splits ascending indices into runs of consecutive numbers. A series with a hole in the
 * shared bucket axis becomes two paths instead of one line drawn across data that was
 * never measured.
 */
export function consecutiveRuns(indices: readonly number[]): number[][] {
  const runs: number[][] = []
  for (const index of indices) {
    const run = runs[runs.length - 1]
    if (run !== undefined && index === run[run.length - 1]! + 1) run.push(index)
    else runs.push([index])
  }
  return runs
}

/** Largest of the given values, or 0 when there are none; non-finite values are ignored. */
export function maxFinite(values: readonly number[]): number {
  let out = Number.NEGATIVE_INFINITY
  for (const v of values) if (Number.isFinite(v) && v > out) out = v
  return Number.isFinite(out) ? out : 0
}

/** Smallest of the given values, or 0 when there are none; non-finite values are ignored. */
export function minFinite(values: readonly number[]): number {
  let out = Number.POSITIVE_INFINITY
  for (const v of values) if (Number.isFinite(v) && v < out) out = v
  return Number.isFinite(out) ? out : 0
}

/** Sum of the finite values given; 0 for none. Used only for real readings. */
export function sumFinite(values: readonly number[]): number {
  let out = 0
  for (const v of values) if (Number.isFinite(v)) out += v
  return out
}
