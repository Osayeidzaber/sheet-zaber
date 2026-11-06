/** Geometry adapted from FinanceBento (ink-orbit-saas-template), supplied by the project owner on 2026-11-05. Took the crypto 7-day sparkline (lines 366-372): lo/hi bounds with a 15% pad, Y(v) = H-3-(v-lo+pad)/(hi-lo+2*pad)*(H-6), the smoothPath line closed to the floor for the wash, and the r=3 terminal dot; dropped OHLC candles, the coin symbol, the 24h-change badge and the per-asset invented price series. */

import { cn } from "@/lib/cn"

import { rawValue, smoothPath, type ChartTone, type Point2, type SeriesPoint, type ValueFormatter } from "./series"

import "./charts.css"

/* The source's candle strip: 96x30 with a 2px inset and a 3px floor/ceiling gutter. */
const W = 96
const H = 30
const INSET = 2
const FLOOR = 3
const PAD_RATIO = 0.15
/** Two-point series get real spacing instead of stacked dots (source divided by length-1). */
const TWO_POINT_INSET = 10
const DOT_R = 3

export interface SparklineProps {
  /** The readings, oldest first. Non-finite values are dropped, never guessed. */
  readonly points: readonly SeriesPoint[]
  /** Accessible name, e.g. "Requests per hour, this endpoint". */
  readonly label: string
  readonly description?: string
  /** Semantic hue only: `elevated` = warn, `failed` = danger. */
  readonly tone?: ChartTone
  /** Draw the soft wash under the line (the source's 16%-opacity gradient, flattened). */
  readonly wash?: boolean
  /** Caller-formatted text appended to the accessible name, e.g. "p95 412 ms". */
  readonly readout?: string
  readonly formatValue?: ValueFormatter
  readonly className?: string
}

/**
 * A tiny per-row series for endpoint tables and log rows. Empty input renders the baseline
 * gutter with a "no data yet" note; one point renders that point as a dot with no line,
 * because a single reading has no shape to draw.
 */
export function Sparkline({
  points,
  label,
  description,
  tone = "neutral",
  wash = true,
  readout,
  formatValue = rawValue,
  className,
}: SparklineProps) {
  const pts = points.filter((p) => Number.isFinite(p.v))
  const n = pts.length
  const values = pts.map((p) => p.v)

  /* Source line 368: lo/hi from the closes, with a 15% pad and `|| 1` so a flat series
   * still has a scale. A flat series is genuinely flat, so it draws on the mid line. */
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pad = (hi - lo) * PAD_RATIO || 1
  const span = hi - lo + 2 * pad
  const yOf = (v: number) => H - FLOOR - ((v - lo + pad) / span) * (H - 2 * FLOOR)
  const xOf = (i: number) => {
    if (n === 1) return W / 2
    if (n === 2) return i === 0 ? TWO_POINT_INSET : W - TWO_POINT_INSET
    return INSET + (i / (n - 1)) * (W - 2 * INSET)
  }

  const coords: Point2[] = pts.map((p, i) => [xOf(i), yOf(p.v)])
  const line = smoothPath(coords)
  const first = pts[0]
  const last = pts[n - 1]
  const ends =
    first !== undefined && last !== undefined && n > 1
      ? ` from ${formatValue(first.v)} to ${formatValue(last.v)}`
      : first !== undefined
        ? ` ${formatValue(first.v)}`
        : " no data yet"

  const ariaLabel = `${label}: ${n} readings${ends}${tone === "failed" ? ", failing" : tone === "elevated" ? ", elevated" : ""}`

  const tooltip =
    n > 0
      ? pts.map((p) => `${p.t}: ${formatValue(p.v)}`).join(" - ")
      : `${label}: no data yet`

  const alternative = (
    <table className="sr-only">
      <caption>
        {label}
        {description ? ` - ${description}` : ""}
      </caption>
      <tbody>
        {pts.map((p) => (
          <tr key={`${p.t}-${formatValue(p.v)}`}>
            <th scope="row">{p.t}</th>
            <td>{formatValue(p.v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <span className={cn("szc-spark", className)} data-tone={tone}>
      <span role="img" aria-label={ariaLabel}>
        {n === 0 ? (
          <svg
            aria-hidden="true"
            className="szc-spark-svg"
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
          >
            {/* Empty plot: the gutter line only, not a flat series. */}
            <line x1={INSET} x2={W - INSET} y1={H - FLOOR} y2={H - FLOOR} className="szc-spark-empty" />
          </svg>
        ) : (
          <svg
            aria-hidden="true"
            className="szc-spark-svg"
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
          >
            <title>{tooltip}</title>
            <line x1={INSET} x2={W - INSET} y1={H - FLOOR} y2={H - FLOOR} className="szc-spark-base" />
            {n > 1 && wash ? (
              <path
                d={`${line}L${coords[n - 1]![0]},${H - FLOOR}L${coords[0]![0]},${H - FLOOR}Z`}
                className="szc-spark-wash"
              />
            ) : null}
            {n > 1 ? (
              <path d={line} fill="none" className="szc-spark-line" pathLength={1} />
            ) : null}
            {n === 1 ? (
              <circle
                className="szc-spark-dot"
                cx={coords[0]![0]}
                cy={coords[0]![1]}
                r={DOT_R}
              />
            ) : (
              <circle
                className="szc-spark-dot"
                cx={coords[n - 1]![0]}
                cy={coords[n - 1]![1]}
                r={DOT_R}
              />
            )}
          </svg>
        )}
      </span>
      {readout ? <span className="szc-spark-readout">{readout}</span> : null}
      {n > 0 ? alternative : null}
    </span>
  )
}
