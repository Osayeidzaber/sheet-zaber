/** Geometry adapted from FinanceBento (ink-orbit-saas-template), supplied by the project owner on 2026-11-05. Took the net-worth stream (lines 223-259): mirrored stacked bands about a centre line, the smoothPath band builder, the three value marks with chips, the vertical scrub highlight, and the ResizeObserver-free overhang scale X(i)=-20+i/(n-1)*(W+40); dropped fiat/stocks/crypto as classes, the currency switch and money() formatter, the invented 36-month history generator (lines 178-187) and every derived percentage. */

import { useId, type ReactNode } from "react"

import { cn } from "@/lib/cn"

import {
  consecutiveRuns,
  maxFinite,
  minFinite,
  rawValue,
  smoothPath,
  type ChartTone,
  type NamedSeries,
  type Point2,
  type SeriesPoint,
  type ValueFormatter,
} from "./series"

import "./charts.css"

const VIEW_W = 1000
/** FinanceBento line 238: X(i) = -20 + i/(n-1)*(W+40) - the stream runs past both edges. */
const OVERHANG = 20
const PAD_TOP = 26
const PAD_BOTTOM = 26
/** Keeps a mark chip's own width inside the plot (source line 250 clamped x to 36..W-36). */
const LABEL_CLAMP = 10

const BAND_LUMINANCE = [0.95, 0.74, 0.52, 0.36, 0.24]
const LINE_LUMINANCE = [1, 0.72, 0.5, 0.36]
const LINE_WEIGHT = [2.4, 1.8, 1.5, 1.2]
const LINE_DASH: Array<string | undefined> = [undefined, "10 4", "3 3", "12 3 3 3"]
const TEXTURES = ["solid", "hatch", "dots", "grid"] as const

export interface AreaStreamProps {
  /** One entry per series. Series with no points are dropped from the legend. */
  readonly series: readonly NamedSeries[]
  readonly label: string
  readonly description?: string
  /**
   * `river` is the vendored mirrored stream (band thickness = a series' share of the bucket
   * total, ribbon height = the total). `overlay` gives every series its own line on one
   * zero-anchored axis.
   */
  readonly mode?: "river" | "overlay"
  /** Plot height in pixels; the width always comes from the container. */
  readonly height?: number
  /** Caller-supplied axis maximum for `overlay`. Without it the maximum is the largest input value. */
  readonly domainMax?: number
  readonly formatValue?: ValueFormatter
  readonly caption?: string
  readonly alternative?: ReactNode
  readonly className?: string
}

interface Bucket {
  readonly t: string
  /** One entry per series, in series order. `null` = never measured, so it is not a zero. */
  readonly values: ReadonlyArray<number | null>
  readonly total: number
}

function bucketAxis(series: readonly NamedSeries[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const s of series) {
    for (const p of s.points) {
      if (!seen.has(p.t)) {
        seen.add(p.t)
        keys.push(p.t)
      }
    }
  }
  return keys
}

function valueByBucket(points: readonly SeriesPoint[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const p of points) {
    if (Number.isFinite(p.v)) map.set(p.t, p.v)
  }
  return map
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function lumAt(ladder: readonly number[], index: number): number {
  return ladder[index % ladder.length]!
}

function textureName(index: number): (typeof TEXTURES)[number] {
  return TEXTURES[index % TEXTURES.length]!
}

function bucketTitle(
  bucket: Bucket,
  names: readonly string[],
  formatValue: ValueFormatter,
  mode: "river" | "overlay",
): string {
  const rows = bucket.values.map((v, i) => `${names[i] ?? `series ${i + 1}`}: ${v === null ? "no reading" : formatValue(v)}`)
  const total = mode === "river" ? `total: ${formatValue(bucket.total)}` : null
  return [bucket.t, ...rows, total].filter((p) => p !== null).join(" - ")
}

export function AreaStream({
  series,
  label,
  description,
  mode = "river",
  height = 240,
  domainMax,
  formatValue = rawValue,
  caption,
  alternative,
  className,
}: AreaStreamProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "")
  const named = series.filter((s) => s.points.length > 0)
  const axis = bucketAxis(named)
  const n = axis.length

  const bucketMaps = named.map((s) => valueByBucket(s.points))
  const buckets: Bucket[] = axis.map((t) => {
    const values = bucketMaps.map((m) => m.get(t) ?? null)
    return { t, values, total: values.reduce<number>((sum, v) => sum + (v ?? 0), 0) }
  })

  const xOf = (i: number) =>
    n <= 1 ? VIEW_W / 2 : -OVERHANG + (i / (n - 1)) * (VIEW_W + OVERHANG * 2)
  const pctOf = (i: number) => clamp((xOf(i) / VIEW_W) * 100, LABEL_CLAMP, 100 - LABEL_CLAMP)
  const step = n > 1 ? (VIEW_W + OVERHANG * 2) / (n - 1) : VIEW_W

  const mid = height / 2
  const half = (height - PAD_TOP - PAD_BOTTOM) / 2
  const plotTop = PAD_TOP
  const base = height - PAD_BOTTOM

  const totals = buckets.map((b) => b.total)
  const tMin = minFinite(totals)
  const tMax = maxFinite(totals)
  /* FinanceBento line 236: floor = mn - (mx - mn) * 0.9, so a growing stream reads as a
   * widening ribbon instead of a hairline above a hard zero. */
  const floor = tMin - (tMax - tMin) * 0.9
  const spread = tMax - floor

  const magnitude = (i: number): number => {
    const total = totals[i]!
    if (total <= 0) return 0
    if (spread <= 0) return 0.5
    return clamp((total - floor) / spread, 0, 1)
  }

  const mirroredBand = (heights: readonly number[]): string => {
    const top: Point2[] = heights.map((v, i): Point2 => [xOf(i), mid - v])
    const bottom: Point2[] = heights.map((v, i): Point2 => [xOf(i), mid + v]).reverse()
    return smoothPath(top) + smoothPath(bottom, "L") + "Z"
  }
  const mirroredEdges = (heights: readonly number[]): string => {
    const top: Point2[] = heights.map((v, i): Point2 => [xOf(i), mid - v])
    const bottom: Point2[] = heights.map((v, i): Point2 => [xOf(i), mid + v]).reverse()
    return smoothPath(top) + " " + smoothPath(bottom, "L")
  }

  /** Cumulative half-height of the stacked ribbon at bucket i, through series j. */
  const cumulativeHalfHeight = (i: number, j: number): number => {
    const b = buckets[i]!
    if (b.total <= 0) return 0
    let acc = 0
    for (let k = 0; k <= j; k++) acc += b.values[k] ?? 0
    return (acc / b.total) * magnitude(i) * half
  }

  const overlayMax = domainMax ?? maxFinite(named.flatMap((s) => s.points.map((p) => p.v)))
  const yOf = (v: number) =>
    overlayMax > 0 ? base - (clamp(v, 0, overlayMax) / overlayMax) * (base - plotTop) : base

  const runsOf = (seriesIndex: number): number[][] =>
    consecutiveRuns(
      buckets.reduce<number[]>(
        (acc, b, i) => (b.values[seriesIndex] !== null ? [...acc, i] : acc),
        [],
      ),
    )

  const markIndices = Array.from(new Set([0, Math.round((n - 1) / 2), n - 1])).filter(
    (i) => i >= 0 && i < n,
  )

  const range =
    n === 0
      ? "no data yet"
      : n === 1
        ? `one bucket (${axis[0]})`
        : `${n} buckets from ${axis[0]} to ${axis[n - 1]}`
  const names = named.map((s) => s.name)
  const ariaLabel = `${label}: ${range}${names.length > 0 ? `, ${mode === "river" ? "bands" : "series"} ${names.join(", ")}` : ", no series"}`

  const table = (
    <table className="sr-only">
      <caption>
        {label}
        {description ? ` - ${description}` : ""}
      </caption>
      <thead>
        <tr>
          <th scope="col">Bucket</th>
          {named.map((s) => (
            <th key={s.name} scope="col">
              {s.name}
            </th>
          ))}
          {mode === "river" ? <th scope="col">Total</th> : null}
        </tr>
      </thead>
      <tbody>
        {buckets.map((b) => (
          <tr key={b.t}>
            <th scope="row">{b.t}</th>
            {b.values.map((v, i) => (
              <td key={named[i]!.name}>{v === null ? "no reading" : formatValue(v)}</td>
            ))}
            {mode === "river" ? <td>{formatValue(b.total)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  )

  const defaultCaption =
    n === 0
      ? "Nothing has been recorded for this window yet, so there is no line to draw."
      : n === 1
        ? "One bucket: the reading is shown on its own, and no trend is drawn through a single point."
        : mode === "river"
          ? "Ribbon height tracks the total per bucket; each band is one series' share of that total. A bucket with no reading for a series adds no thickness there."
          : "Series share one zero-anchored axis; lines break where a bucket was never measured."

  return (
    <figure className={cn("szc-figure", className)}>
      <div className="szc-head">
        <div className="szc-legend" aria-hidden="true">
          {named.map((s, index) => (
            <span key={s.name} className="szc-legend-item" data-tone={s.tone ?? "neutral"}>
              <Swatch
                mode={mode}
                index={index}
                uid={uid}
                tone={s.tone ?? "neutral"}
              />
              {s.name}
            </span>
          ))}
        </div>
        {description ? <p className="szc-readout">{description}</p> : null}
      </div>

      <div className="szc-plot" role="img" aria-label={ariaLabel} style={{ height }}>
        {n === 0 ? (
          <p className="szc-empty">No data yet</p>
        ) : n === 1 ? (
          <SingleBucket
            bucket={buckets[0]!}
            names={names}
            mode={mode}
            height={height}
            base={base}
            plotTop={plotTop}
            overlayMax={overlayMax}
            yOf={yOf}
            formatValue={formatValue}
          />
        ) : (
          <>
            <svg
              aria-hidden="true"
              className="szc-svg szc-svg-stretch"
              viewBox={`0 0 ${VIEW_W} ${height}`}
              preserveAspectRatio="none"
              style={{ height }}
              shapeRendering="auto"
            >
              <defs>
                {/* FinanceBento lines 245-246: the ribbon fades in from the left edge. The
                 * source ramped 0 -> 1 across the first quarter of the plot, which hides the
                 * first buckets; the same alpha mask is kept but shortened to 5% of the width
                 * with a 0.55 floor, so the edge softens without suppressing a reading. */}
                <linearGradient id={`szc-fade-${uid}`} x1="0" x2="1" y1="0" y2="0">
                  <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
                  <stop offset="0.05" stopColor="#ffffff" stopOpacity="1" />
                </linearGradient>
                <mask
                  id={`szc-mask-${uid}`}
                  maskUnits="userSpaceOnUse"
                  x="0"
                  y="0"
                  width={VIEW_W}
                  height={height}
                >
                  <rect x="0" y="0" width={VIEW_W} height={height} fill={`url(#szc-fade-${uid})`} />
                </mask>
                {TEXTURES.map((name) =>
                  name === "solid" ? null : (
                    <pattern
                      key={name}
                      id={`szc-tex-${uid}-${name}`}
                      width="6"
                      height="6"
                      patternUnits="userSpaceOnUse"
                    >
                      {name === "hatch" ? (
                        <path
                          d="M-1,7 L7,-1 M5,7 L7,5 M-1,1 L1,-1"
                          stroke="#000000"
                          strokeWidth="1"
                          fill="none"
                        />
                      ) : name === "dots" ? (
                        <circle cx="3" cy="3" r="1" fill="#000000" />
                      ) : (
                        <path
                          d="M0,3 H6 M3,0 V6"
                          stroke="#000000"
                          strokeWidth="0.8"
                          fill="none"
                        />
                      )}
                    </pattern>
                  ),
                )}
              </defs>

              {mode === "overlay" ? (
                <g className="szc-grid">
                  <line x1="0" x2={VIEW_W} y1={base} y2={base} className="szc-axis"  vectorEffect="non-scaling-stroke"/>
                  {overlayMax > 0 ? (
                    <line x1="0" x2={VIEW_W} y1={plotTop} y2={plotTop} className="szc-rail-line"  vectorEffect="non-scaling-stroke"/>
                  ) : null}
                </g>
              ) : (
                <line x1="0" x2={VIEW_W} y1={mid} y2={mid} className="szc-axis"  vectorEffect="non-scaling-stroke"/>
              )}

              <g mask={`url(#szc-mask-${uid})`}>
                {mode === "river"
                  ? named.map((s, j) => {
                      const outer = buckets.map((_, i) => cumulativeHalfHeight(i, j))
                      const inner =
                        j === 0 ? null : buckets.map((_, i) => cumulativeHalfHeight(i, j - 1))
                      const hasHole = inner !== null && inner.some((v) => v > 0)
                      const d = mirroredBand(outer) + (hasHole ? ` ${mirroredBand(inner!)}` : "")
                      if (!outer.some((v) => v > 0)) return null
                      const fillLum = lumAt(BAND_LUMINANCE, j)
                      const texture = textureName(j)
                      return (
                        <g
                          key={s.name}
                          className="szc-band-group"
                          data-tone={s.tone ?? "neutral"}
                        >
                          <path
                            d={d}
                            fillRule="evenodd"
                            className="szc-band"
                            fillOpacity={fillLum}
                           vectorEffect="non-scaling-stroke"/>
                          {texture !== "solid" ? (
                            <path
                              d={d}
                              fillRule="evenodd"
                              fill={`url(#szc-tex-${uid}-${texture})`}
                              className="szc-band-texture"
                             vectorEffect="non-scaling-stroke"/>
                          ) : null}
                          <path
                            d={mirroredEdges(outer)}
                            fill="none"
                            className="szc-band-edge"
                            strokeDasharray={LINE_DASH[j % LINE_DASH.length]}
                            strokeOpacity={fillLum}
                           vectorEffect="non-scaling-stroke"/>
                        </g>
                      )
                    })
                  : named.map((s, j) => {
                      const dash = LINE_DASH[j % LINE_DASH.length]
                      const weight = lumAt(LINE_WEIGHT, j)
                      const lineLum = lumAt(LINE_LUMINANCE, j)
                      const runs = runsOf(j)
                      if (runs.length === 0) return null
                      return (
                        <g
                          key={s.name}
                          className="szc-band-group"
                          data-tone={s.tone ?? "neutral"}
                        >
                          {runs.map((run, runIndex) => {
                            const pts: Point2[] = run.map((i) => [
                              xOf(i),
                              yOf(buckets[i]!.values[j] ?? 0),
                            ])
                            const line = smoothPath(pts)
                            const last = pts[pts.length - 1]!
                            const first = pts[0]!
                            return (
                              <g key={`${s.name}-${runIndex}`}>
                                {run.length > 1 ? (
                                  <path
                                    d={`${line}L${last[0]},${base}L${first[0]},${base}Z`}
                                    className="szc-wash"
                                    fillOpacity={lineLum * 0.16}
                                   vectorEffect="non-scaling-stroke"/>
                                ) : null}
                                <path
                                  d={line}
                                  fill="none"
                                  className="szc-line"
                                  strokeDasharray={dash}
                                  strokeWidth={weight}
                                  strokeOpacity={lineLum}
                                 vectorEffect="non-scaling-stroke"/>
                                {run.length === 1 ? (
                                  <line
                                    x1={first[0] - 40}
                                    x2={first[0] + 40}
                                    y1={first[1]}
                                    y2={first[1]}
                                    className="szc-marker"
                                    strokeWidth={weight}
                                    strokeOpacity={lineLum}
                                   vectorEffect="non-scaling-stroke"/>
                                ) : null}
                              </g>
                            )
                          })}
                        </g>
                      )
                    })}
              </g>

              {markIndices.map((i) => (
                <line
                  key={`guide-${i}`}
                  x1={xOf(i)}
                  x2={xOf(i)}
                  y1={plotTop - 6}
                  y2={base + 6}
                  className="szc-guide"
                 vectorEffect="non-scaling-stroke"/>
              ))}

              {buckets.map((b, i) => (
                <g key={`bucket-${b.t}`} className="szc-bucket">
                  <title>{bucketTitle(b, names, formatValue, mode)}</title>
                  <line
                    x1={xOf(i)}
                    x2={xOf(i)}
                    y1={plotTop - 6}
                    y2={base + 6}
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

            {mode === "overlay" ? (
              <div className="szc-y-rail" aria-hidden="true">
                <span className="szc-y-tick" style={{ top: plotTop }}>
                  {formatValue(overlayMax)}
                </span>
                <span className="szc-y-tick" style={{ top: base }}>
                  {formatValue(0)}
                </span>
              </div>
            ) : null}

            <div className="szc-mark-rail" aria-hidden="true">
              {markIndices.map((i) => (
                <span
                  key={`mark-${buckets[i]!.t}`}
                  className="szc-mark"
                  style={{ left: `${pctOf(i)}%` }}
                >
                  {mode === "river" ? (
                    <span className="szc-mark-chip">{formatValue(buckets[i]!.total)}</span>
                  ) : null}
                  <span className="szc-mark-label">{buckets[i]!.t}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      <figcaption className="szc-caption">{caption ?? defaultCaption}</figcaption>

      {alternative ? <div className="szc-alt">{alternative}</div> : n > 0 ? table : null}
    </figure>
  )
}

function Swatch({
  mode,
  index,
  uid,
  tone,
}: {
  mode: "river" | "overlay"
  index: number
  uid: string
  tone: ChartTone
}) {
  const texture = textureName(index)
  const dash = LINE_DASH[index % LINE_DASH.length]
  const swatchLum = lumAt(mode === "river" ? BAND_LUMINANCE : LINE_LUMINANCE, index)
  return (
    <svg
      className="szc-legend-swatch"
      viewBox="0 0 22 10"
      width="22"
      height="10"
      aria-hidden="true"
      data-tone={tone}
    >
      {mode === "river" ? (
        <>
          <rect x="0" y="1" width="22" height="8" className="szc-band" fillOpacity={swatchLum} />
          {texture !== "solid" ? (
            <rect
              x="0"
              y="1"
              width="22"
              height="8"
              fill={`url(#szc-tex-${uid}-${texture})`}
              className="szc-band-texture"
            />
          ) : null}
        </>
      ) : (
        <line
          x1="1"
          x2="21"
          y1="5"
          y2="5"
          className="szc-line"
          strokeWidth={lumAt(LINE_WEIGHT, index)}
          strokeOpacity={swatchLum}
          strokeDasharray={dash}
         vectorEffect="non-scaling-stroke"/>
      )}
    </svg>
  )
}

/** One bucket, drawn as a discrete reading: no path, no implied slope. */
function SingleBucket({
  bucket,
  names,
  mode,
  height,
  base,
  plotTop,
  overlayMax,
  yOf,
  formatValue,
}: {
  bucket: Bucket
  names: readonly string[]
  mode: "river" | "overlay"
  height: number
  base: number
  plotTop: number
  overlayMax: number
  yOf: (v: number) => number
  formatValue: ValueFormatter
}) {
  const plotH = base - plotTop
  const cx = VIEW_W / 2
  const barW = 44

  let cursor = base
  const segments: Array<{ j: number; y1: number; y2: number } | null> =
    mode === "river"
      ? bucket.values.map((v, j) => {
          const value = v ?? 0
          const h = bucket.total > 0 ? (value / bucket.total) * plotH : 0
          const top = cursor - h
          const out = h > 0 ? { j, y1: cursor - 1, y2: top + 1 } : null
          cursor = top
          return out
        })
      : bucket.values.map((v, j) => {
          const value = v ?? 0
          const y = yOf(value)
          return y < base ? { j, y1: base - 1, y2: y + 1 } : null
        })

  return (
    <>
      <svg
        aria-hidden="true"
        className="szc-svg szc-svg-stretch"
        viewBox={`0 0 ${VIEW_W} ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
      >
        <line
          x1={cx}
          x2={cx}
          y1={plotTop}
          y2={base}
          className="szc-single-track"
          strokeWidth={barW}
         vectorEffect="non-scaling-stroke"/>
        {segments.map((s) =>
          s === null ? null : (
            <line
              key={`seg-${s.j}`}
              x1={cx}
              x2={cx}
              y1={s.y1}
              y2={s.y2}
              className="szc-single-segment"
              strokeWidth={barW - 6}
              strokeOpacity={lumAt(BAND_LUMINANCE, s.j)}
             vectorEffect="non-scaling-stroke"/>
          ),
        )}
      </svg>
      <div className="szc-single-list">
        {bucket.values.map((v, j) => (
          <p key={names[j] ?? j} className="szc-single-row">
            <span className="szc-single-name">{names[j] ?? `series ${j + 1}`}</span>
            <span className="szc-single-value">
              {v === null ? "no reading" : formatValue(v)}
            </span>
          </p>
        ))}
        {mode === "river" ? (
          <p className="szc-single-row">
            <span className="szc-single-name">Total</span>
            <span className="szc-single-value">{formatValue(bucket.total)}</span>
          </p>
        ) : null}
      </div>
      <div className="szc-mark-rail" aria-hidden="true">
        <span className="szc-mark" style={{ left: "50%" }}>
          <span className="szc-mark-chip szc-mark-chip--solo">{bucket.t}</span>
        </span>
      </div>
      {mode === "overlay" && overlayMax > 0 ? (
        <div className="szc-y-rail" aria-hidden="true">
          <span className="szc-y-tick" style={{ top: plotTop }}>
            {formatValue(overlayMax)}
          </span>
          <span className="szc-y-tick" style={{ top: base }}>
            {formatValue(0)}
          </span>
        </div>
      ) : null}
    </>
  )
}
