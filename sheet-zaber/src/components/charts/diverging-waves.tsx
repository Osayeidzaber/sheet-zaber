/** Geometry adapted from FinanceBento (ink-orbit-saas-template), supplied by the project owner on 2026-11-05. Took the cash-flow mirrored waves (lines 323-357): one smoothPath per side of the mid axis, dir=+1 below, the symmetric gridline pairs with their right-edge nubs, the L/R gutters, the prior-year lines drawn at opacity [1,.55,.3] and weight 2.4/1.6, and the scrub highlight with a hit strip; dropped income/spending/saved, the thousands-and-currency math, the fixed max of 7, the month names and the invented six-month grid. */

import { cn } from "@/lib/cn"
import type { ReactNode } from "react"

import {
  consecutiveRuns,
  maxFinite,
  rawValue,
  smoothPath,
  type ChartTone,
  type DivergingRow,
  type Point2,
  type ValueFormatter,
} from "./series"

import "./charts.css"

const VIEW_W = 1000
/* Source line 334: L = 44, R = W - 36 - gutters for the axis labels, kept proportionally. */
const PAD_LEFT = 40
const PAD_RIGHT = 30
const GUTTER = 16
/** Source line 346: the newest window is solid at 2.4, earlier ones thin at 1.6. */
const PRIMARY_WEIGHT = 2.4
const SECONDARY_WEIGHT = 1.6
const SECONDARY_DASH = "10 4"
/** Above this many buckets the on-axis labels thin out to the three marks. */
const LABELS_ALL_UP_TO = 12

export interface DivergingWavesProps {
  /** The window being read: one row per time bucket. */
  readonly rows: readonly DivergingRow[]
  readonly label: string
  readonly description?: string
  /** Worded by the caller, e.g. "Successful requests" / "Failed requests". */
  readonly aboveName: string
  readonly belowName: string
  /** Optional earlier window drawn behind, dashed and recessive instead of coloured. */
  readonly previous?: readonly DivergingRow[]
  readonly previousName?: string
  readonly height?: number
  /** Caller-supplied scale for both sides; without it each side stops at its own largest bucket. */
  readonly domainMax?: number
  readonly formatValue?: ValueFormatter
  readonly caption?: string
  readonly alternative?: ReactNode
  readonly className?: string
}

interface WaveRow {
  readonly t: string
  readonly above: number | null
  readonly below: number | null
  readonly prevAbove: number | null
  readonly prevBelow: number | null
}

/** Buckets with no finite reading on either side are dropped, so a hole stays a hole. */
function indexRows(rows: readonly DivergingRow[]): Map<string, DivergingRow> {
  const map = new Map<string, DivergingRow>()
  for (const r of rows) {
    if (Number.isFinite(r.positive) || Number.isFinite(r.negative)) map.set(r.t, r)
  }
  return map
}

function finite(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null
}

function axisOf(rows: readonly DivergingRow[], previous: readonly DivergingRow[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const r of [...rows, ...previous]) {
    if (!seen.has(r.t)) {
      seen.add(r.t)
      keys.push(r.t)
    }
  }
  return keys
}

/**
 * Success and failure counts per time bucket, drawn as two waves mirrored about one axis:
 * the passing side above, the failing side below, both measured against the largest real
 * bucket on that side. Empty input leaves the axis line and a "no data yet" note; one bucket
 * is drawn as two discrete ticks with no wave, because one point cannot curve.
 */
export function DivergingWaves({
  rows,
  label,
  description,
  aboveName,
  belowName,
  previous = [],
  previousName,
  height = 246,
  domainMax,
  formatValue = rawValue,
  caption,
  alternative,
  className,
}: DivergingWavesProps) {
  const byCurrent = indexRows(rows)
  const byPrevious = indexRows(previous)
  const axis = axisOf(rows, previous)
  const n = axis.length

  const data: WaveRow[] = axis.map((t) => {
    const cur = byCurrent.get(t)
    const prev = byPrevious.get(t)
    return {
      t,
      above: cur ? finite(cur.positive) : null,
      below: cur ? finite(cur.negative) : null,
      prevAbove: prev ? finite(prev.positive) : null,
      prevBelow: prev ? finite(prev.negative) : null,
    }
  })

  const mid = height / 2
  const amp = mid - GUTTER
  const plotTop = GUTTER
  const plotBottom = height - GUTTER

  const xOf = (i: number) =>
    n <= 1 ? VIEW_W / 2 : PAD_LEFT + (i / (n - 1)) * (VIEW_W - PAD_LEFT - PAD_RIGHT)
  const pctOf = (i: number) => (xOf(i) / VIEW_W) * 100
  const step = n > 1 ? (VIEW_W - PAD_LEFT - PAD_RIGHT) / (n - 1) : VIEW_W

  const aboveValues = data.flatMap((d) => [d.above, d.prevAbove])
  const belowValues = data.flatMap((d) => [d.below, d.prevBelow])
  const aboveMax = domainMax ?? maxFinite(aboveValues.filter((v): v is number => v !== null))
  const belowMax = domainMax ?? maxFinite(belowValues.filter((v): v is number => v !== null))

  const yAbove = (v: number) => mid - (aboveMax > 0 ? Math.min(1, v / aboveMax) * amp : 0)
  const yBelow = (v: number) => mid + (belowMax > 0 ? Math.min(1, v / belowMax) * amp : 0)

  /** One path per contiguous run, so a bucket that was never measured stays a hole. */
  const pathsFor = (
    pick: (d: WaveRow) => number | null,
    yOf: (v: number) => number,
  ): string[] => {
    const present = data.reduce<number[]>((acc, d, i) => (pick(d) !== null ? [...acc, i] : acc), [])
    return consecutiveRuns(present)
      .map((run) =>
        run.length === 0
          ? ""
          : smoothPath(run.map((i) => [xOf(i), yOf(pick(data[i]!)!)] as Point2)),
      )
      .filter((d) => d !== "")
  }

  const currentAbove = pathsFor((d) => d.above, yAbove)
  const currentBelow = pathsFor((d) => d.below, yBelow)
  const pastAbove = pathsFor((d) => d.prevAbove, yAbove)
  const pastBelow = pathsFor((d) => d.prevBelow, yBelow)

  /** Single-value runs still need a mark, otherwise a real zero-only bucket looks like no data. */
  const marksFor = (pick: (d: WaveRow) => number | null, yOf: (v: number) => number): Point2[] =>
    data.reduce<Point2[]>((acc, d, i) => {
      const v = pick(d)
      if (v === null) return acc
      const alone =
        (i === 0 || pick(data[i - 1]!) === null) &&
        (i === n - 1 || pick(data[i + 1]!) === null)
      return alone ? [...acc, [xOf(i), yOf(v)]] : acc
    }, [])

  const soloAbove = marksFor((d) => d.above, yAbove)
  const soloBelow = marksFor((d) => d.below, yBelow)

  const markIndices = Array.from(new Set([0, Math.round((n - 1) / 2), n - 1])).filter(
    (i) => i >= 0 && i < n,
  )
  const labelIndices = n <= LABELS_ALL_UP_TO ? data.map((_, i) => i) : markIndices

  const aboveTotal = data.reduce((sum, d) => sum + (d.above ?? 0), 0)
  const belowTotal = data.reduce((sum, d) => sum + (d.below ?? 0), 0)

  const range =
    n === 0
      ? "no data yet"
      : n === 1
        ? `one bucket (${axis[0]})`
        : `${n} buckets from ${axis[0]} to ${axis[n - 1]}`
  const ariaLabel = `${label}: ${range}, ${aboveName} above the axis and ${belowName} below`

  const table = (
    <table className="sr-only">
      <caption>
        {label}
        {description ? ` - ${description}` : ""}
      </caption>
      <thead>
        <tr>
          <th scope="col">Bucket</th>
          <th scope="col">{aboveName}</th>
          <th scope="col">{belowName}</th>
          {previousName ? <th scope="col">{previousName}</th> : null}
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.t}>
            <th scope="row">{d.t}</th>
            <td className="szc-td-num">{d.above === null ? "no reading" : formatValue(d.above)}</td>
            <td className="szc-td-num">{d.below === null ? "no reading" : formatValue(d.below)}</td>
            {previousName ? (
              <td className="szc-td-num">
                {d.prevAbove === null && d.prevBelow === null
                  ? "no reading"
                  : `${d.prevAbove === null ? "—" : formatValue(d.prevAbove)} / ${
                      d.prevBelow === null ? "—" : formatValue(d.prevBelow)
                    }`}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  )

  const aboveTone: ChartTone = "neutral"
  const belowTone: ChartTone = belowTotal > 0 ? "failed" : "neutral"

  return (
    <figure className={cn("szc-figure szc-figure-waves", className)}>
      <div className="szc-head">
        <div className="szc-legend" aria-hidden="true">
          <WaveSwatch name={aboveName} tone={aboveTone} />
          <WaveSwatch name={belowName} tone={belowTone} />
          {previousName ? <WaveSwatch name={previousName} tone="neutral" secondary /> : null}
        </div>
        {description ? <p className="szc-readout">{description}</p> : null}
      </div>

      <div className="szc-plot" role="img" aria-label={ariaLabel} style={{ height }}>
        {n === 0 ? (
          <p className="szc-empty">No data yet</p>
        ) : (
          <>
            <svg
              aria-hidden="true"
              className="szc-svg szc-svg-stretch"
              viewBox={`0 0 ${VIEW_W} ${height}`}
              preserveAspectRatio="none"
              style={{ height }}
            >
              {/* Source lines 341-344: symmetric rails at the scale values, with right-edge nubs. */}
              {aboveMax > 0 ? (
                <>
                  <line x1={PAD_LEFT} x2={VIEW_W - PAD_RIGHT} y1={plotTop} y2={plotTop} className="szc-rail-line"  vectorEffect="non-scaling-stroke"/>
                  <line x1={VIEW_W - PAD_RIGHT + 8} x2={VIEW_W - PAD_RIGHT + 14} y1={plotTop} y2={plotTop} className="szc-rail-nub"  vectorEffect="non-scaling-stroke"/>
                </>
              ) : null}
              {belowMax > 0 ? (
                <>
                  <line x1={PAD_LEFT} x2={VIEW_W - PAD_RIGHT} y1={plotBottom} y2={plotBottom} className="szc-rail-line"  vectorEffect="non-scaling-stroke"/>
                  <line x1={VIEW_W - PAD_RIGHT + 8} x2={VIEW_W - PAD_RIGHT + 14} y1={plotBottom} y2={plotBottom} className="szc-rail-nub"  vectorEffect="non-scaling-stroke"/>
                </>
              ) : null}
              <line x1={PAD_LEFT} x2={VIEW_W - PAD_RIGHT} y1={mid} y2={mid} className="szc-axis szc-axis--strong"  vectorEffect="non-scaling-stroke"/>

              {pastAbove.map((d, i) => (
                <path key={`past-above-${i}`} d={d} fill="none" className="szc-line szc-secondary"  vectorEffect="non-scaling-stroke"/>
              ))}
              {pastBelow.map((d, i) => (
                <path key={`past-below-${i}`} d={d} fill="none" className="szc-line szc-secondary szc-danger"  vectorEffect="non-scaling-stroke"/>
              ))}
              {currentAbove.map((d, i) => (
                <path
                  key={`above-${i}`}
                  d={d}
                  fill="none"
                  className="szc-line szc-primary szc-draw"
                  strokeWidth={PRIMARY_WEIGHT}
                  pathLength={1}
                 vectorEffect="non-scaling-stroke"/>
              ))}
              {currentBelow.map((d, i) => (
                <path
                  key={`below-${i}`}
                  d={d}
                  fill="none"
                  className="szc-line szc-primary szc-danger szc-draw"
                  strokeWidth={PRIMARY_WEIGHT}
                  pathLength={1}
                 vectorEffect="non-scaling-stroke"/>
              ))}

              {soloAbove.map(([x, y], i) => (
                <line
                  key={`solo-above-${i}`}
                  x1={x - 30}
                  x2={x + 30}
                  y1={y}
                  y2={y}
                  className="szc-marker"
                  strokeWidth={PRIMARY_WEIGHT}
                 vectorEffect="non-scaling-stroke"/>
              ))}
              {soloBelow.map(([x, y], i) => (
                <line
                  key={`solo-below-${i}`}
                  x1={x - 30}
                  x2={x + 30}
                  y1={y}
                  y2={y}
                  className="szc-marker szc-danger"
                  strokeWidth={PRIMARY_WEIGHT}
                 vectorEffect="non-scaling-stroke"/>
              ))}

              {markIndices.map((i) => (
                <line
                  key={`guide-${i}`}
                  x1={xOf(i)}
                  x2={xOf(i)}
                  y1={plotTop - 6}
                  y2={plotBottom + 6}
                  className="szc-guide"
                 vectorEffect="non-scaling-stroke"/>
              ))}

              {/* Source lines 348-351: a hit strip per bucket and one vertical scrub line. */}
              {data.map((d, i) => (
                <g key={`bucket-${d.t}`} className="szc-bucket">
                  <title>
                    {[
                      d.t,
                      `${aboveName}: ${d.above === null ? "no reading" : formatValue(d.above)}`,
                      `${belowName}: ${d.below === null ? "no reading" : formatValue(d.below)}`,
                      previousName && (d.prevAbove !== null || d.prevBelow !== null)
                        ? `${previousName}: ${d.prevAbove === null ? "—" : formatValue(d.prevAbove)} / ${
                            d.prevBelow === null ? "—" : formatValue(d.prevBelow)
                          }`
                        : null,
                    ]
                      .filter((p) => p !== null)
                      .join(" - ")}
                  </title>
                  <line
                    x1={xOf(i)}
                    x2={xOf(i)}
                    y1={plotTop - 6}
                    y2={plotBottom + 6}
                    className="szc-scrub"
                   vectorEffect="non-scaling-stroke"/>
                  <rect
                    x={xOf(i) - step / 2}
                    y={0}
                    width={step}
                    height={height}
                    fill="transparent"
                  />
                </g>
              ))}
            </svg>

            <div className="szc-y-rail" aria-hidden="true">
              {aboveMax > 0 ? (
                <span className="szc-y-tick" style={{ top: plotTop }}>
                  {formatValue(aboveMax)}
                </span>
              ) : null}
              <span className="szc-y-tick szc-y-tick--axis" style={{ top: mid }}>
                {formatValue(0)}
              </span>
              {belowMax > 0 ? (
                <span className="szc-y-tick" style={{ top: plotBottom }}>
                  {formatValue(belowMax)}
                </span>
              ) : null}
            </div>

            <div className="szc-mark-rail szc-mark-rail--axis" aria-hidden="true">
              {labelIndices.map((i) => (
                <span key={`tick-${data[i]!.t}`} className="szc-mark" style={{ left: `${pctOf(i)}%` }}>
                  <span className="szc-mark-label">{data[i]!.t}</span>
                </span>
              ))}
            </div>

            {n === 1 ? (
              <div className="szc-single-list">
                <p className="szc-single-row">
                  <span className="szc-single-name">{aboveName}</span>
                  <span className="szc-single-value">
                    {data[0]!.above === null ? "no reading" : formatValue(data[0]!.above)}
                  </span>
                </p>
                <p className="szc-single-row">
                  <span className="szc-single-name">{belowName}</span>
                  <span className="szc-single-value">
                    {data[0]!.below === null ? "no reading" : formatValue(data[0]!.below)}
                  </span>
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="szc-totals" aria-hidden="true">
        <p className="szc-total">
          <span className="szc-cap">{aboveName}</span>
          <span className="szc-td-num">{formatValue(aboveTotal)}</span>
        </p>
        <p className="szc-total" data-tone="failed">
          <span className="szc-cap">{belowName}</span>
          <span className="szc-td-num">{formatValue(belowTotal)}</span>
        </p>
      </div>

      <figcaption className="szc-caption">
        {caption ??
          (n === 0
            ? "Nothing has been recorded for this window yet, so there is no wave to draw."
            : n === 1
              ? "One bucket: both sides are drawn as ticks with their readings, not as a curve."
              : "Both sides are drawn against the largest real bucket on that side; a wave breaks where a bucket was never measured.")}
      </figcaption>

      {alternative ? <div className="szc-alt">{alternative}</div> : table}
    </figure>
  )
}

function WaveSwatch({
  name,
  tone,
  secondary = false,
}: {
  name: string
  tone: ChartTone
  secondary?: boolean
}) {
  return (
    <span className="szc-legend-item" data-tone={tone}>
      <svg
        className="szc-legend-swatch"
        viewBox="0 0 22 10"
        width="22"
        height="10"
        aria-hidden="true"
        data-tone={tone}
      >
        <line
          x1="1"
          x2="21"
          y1="5"
          y2="5"
          className={cn("szc-line", secondary ? "szc-secondary" : "szc-primary", tone === "failed" && "szc-danger")}
          strokeWidth={secondary ? SECONDARY_WEIGHT : PRIMARY_WEIGHT}
          strokeDasharray={secondary ? SECONDARY_DASH : undefined}
         vectorEffect="non-scaling-stroke"/>
      </svg>
      {name}
    </span>
  )
}
