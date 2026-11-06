/** Geometry adapted from FinanceBento (ink-orbit-saas-template), supplied by the project owner on 2026-11-05. Took the allocation half-gauge of tick marks (lines 269-285: P2() polar helper, 56 ticks over 180-360 degrees, R 136 with a major tick every 7 at R 112/118, stroke-width 3.2, per-tick opacity fade), the KPI tile shell (lines 89-101: cap, big light-weight tabular number, chip, one solid inverted tile) and the runway-tick strip (lines 297-305, 36 hairline ticks, taller every sixth); dropped fiat/stocks/crypto shares, the "invested" percentage, the "Target 60/40" and "Runway 12 mo" wording, the lime/blue gradient fields and glass, the dot-matrix money counter and the invented history all of it was computed from. */

import { cn } from "@/lib/cn"
import type { ReactNode } from "react"

import {
  rawValue,
  type ChartTone,
  type KpiTileReading,
  type ValueFormatter,
} from "./series"

import "./charts.css"

/** FinanceBento line 202: P2(r, a) = [r*cos(a), r*sin(a)] with a in degrees. */
function polar(radius: number, angleDeg: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180
  return [radius * Math.cos(a), radius * Math.sin(a)]
}

const OUTER_R = 136
const MINOR_R = 118
const MAJOR_R = 112
/** Source's `i % 7 === 0` at 56 ticks: every 12.5% of the sweep gets a long tick. */
const MAJOR_EVERY = 7
/** Source line 278 used a slightly longer tick for the gauge's own gate marker. */
const GATE_R = 104
const SWEEP_FROM = 180
const SWEEP_SPAN = 180
const DEFAULT_TICKS = 56
const STRIP_TICKS = 36
const STRIP_MAJOR_EVERY = 6

export interface TickGaugeProps {
  /** Accessible name of the gauge; also the visible caption. */
  readonly label: string
  readonly description?: string
  /** Exact readings. Nothing here is scaled to a display unit. */
  readonly used: number
  readonly limit: number
  /** The caller's own early-warning value in the same unit as `used` / `limit`. */
  readonly warnAt?: number
  /** Sweep resolution; clamped to 7-120 so the ticks stay readable. */
  readonly tickCount?: number
  /** Caller-formatted centre text. Defaults to `used / limit` through `formatValue`. */
  readonly readout?: string
  readonly readoutNote?: string
  readonly formatValue?: ValueFormatter
  readonly caption?: string
  readonly alternative?: ReactNode
  readonly className?: string
}

interface Geometry {
  readonly measurable: boolean
  readonly ratio: number
  readonly over: boolean
  readonly tone: ChartTone
}

/**
 * A quota reading as a half gauge of tick marks: filled ticks are consumption, the rest is
 * headroom. Series differentiation is done with tick weight and length, and hue appears only
 * for the two semantic states (`elevated` at the caller's warning value, `failed` past limit).
 */
export function TickGauge({
  label,
  description,
  used,
  limit,
  warnAt,
  tickCount = DEFAULT_TICKS,
  readout,
  readoutNote,
  formatValue = rawValue,
  caption,
  alternative,
  className,
}: TickGaugeProps) {
  const hasReading = Number.isFinite(used) && Number.isFinite(limit) && limit > 0
  const safeUsed = hasReading ? Math.max(0, used) : 0
  const ratio = hasReading ? safeUsed / limit : 0
  const over = hasReading && ratio > 1
  const atRisk = hasReading && warnAt !== undefined && limit > 0 && safeUsed >= warnAt
  const tone: ChartTone = over ? "failed" : atRisk ? "elevated" : "neutral"

  const n = Math.min(120, Math.max(7, Math.round(tickCount)))
  const filled = hasReading ? Math.min(n, Math.floor(ratio * n + 1e-9)) : 0
  const gateIndex =
    hasReading && warnAt !== undefined && warnAt > 0 && warnAt < limit
      ? Math.min(n, Math.max(0, Math.round((warnAt / limit) * n)))
      : null

  const headroom = hasReading ? limit - used : null
  const geo: Geometry = { measurable: hasReading, ratio, over, tone }

  const ariaLabel = hasReading
    ? `${label}: ${formatValue(used)} used of ${formatValue(limit)}${
        over
          ? `, ${formatValue(used - limit)} over the limit`
          : headroom !== null
            ? `, ${formatValue(headroom)} left`
            : ""
      }`
    : `${label}: no limit set, nothing to measure`

  const ticks: ReactNode[] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const angle = SWEEP_FROM + f * SWEEP_SPAN
    const [x1, y1] = polar(OUTER_R, angle)
    const major = i % MAJOR_EVERY === 0
    const isGate = gateIndex !== null && i === gateIndex
    const [x2, y2] = polar(isGate ? GATE_R : major ? MAJOR_R : MINOR_R, angle)
    const isUsed = hasReading && i <= filled
    const state = !hasReading
      ? "unknown"
      : isUsed
        ? over
          ? "over"
          : "used"
        : isGate
          ? "gate"
          : "headroom"
    ticks.push(
      <line
        key={i}
        x1={round1(x1)}
        y1={round1(y1)}
        x2={round1(x2)}
        y2={round1(y2)}
        className="szc-tick"
        data-state={state}
        strokeWidth={major ? 4 : 3.2}
        style={{ animationDelay: `${Math.min(i * 12, 900)}ms` }}
      />,
    )
  }

  return (
    <figure className={cn("szc-figure szc-figure-gauge", className)} data-tone={tone}>
      <div className="szc-head">
        <p className="szc-cap">{label}</p>
        {warnAt !== undefined && Number.isFinite(warnAt) ? (
          <span className="szc-chip">{formatValue(warnAt)}</span>
        ) : null}
      </div>

      <div className="szc-gauge" role="img" aria-label={ariaLabel}>
        <svg
          aria-hidden="true"
          className="szc-gauge-svg"
          viewBox="-150 -150 300 168"
          preserveAspectRatio="xMidYMid meet"
        >
          {ticks}
        </svg>
        <div className="szc-gauge-readout" aria-hidden="true">
          <p className="szc-gauge-big">
            {hasReading
              ? (readout ?? `${formatValue(used)} / ${formatValue(limit)}`)
              : "—"}
          </p>
          {readoutNote ? <p className="szc-gauge-note">{readoutNote}</p> : null}
        </div>
      </div>

      <table className="szc-table">
        <caption className="sr-only">
          {label}
          {description ? ` - ${description}` : ""}
        </caption>
        <tbody>
          <tr>
            <th scope="row">Used</th>
            <td className="szc-td-num">{hasReading ? formatValue(used) : "no reading"}</td>
          </tr>
          <tr>
            <th scope="row">Limit</th>
            <td className="szc-td-num">{hasReading ? formatValue(limit) : "not set"}</td>
          </tr>
          <tr>
            <th scope="row">{over ? "Over limit" : "Headroom"}</th>
            <td className="szc-td-num">
              {headroom === null
                ? "—"
                : formatValue(over ? used - limit : headroom)}
            </td>
          </tr>
          {warnAt !== undefined && Number.isFinite(warnAt) ? (
            <tr>
              <th scope="row">Warning at</th>
              <td className="szc-td-num">{formatValue(warnAt)}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <figcaption className="szc-caption">
        {caption ??
          (hasReading
            ? gaugeCaption(geo)
            : "No limit has been given, so the sweep has nothing to measure against.")}
      </figcaption>

      {alternative ? <div className="szc-alt">{alternative}</div> : null}
    </figure>
  )
}

function gaugeCaption({ over, tone }: Geometry): string {
  if (over) return "Consumption is past the limit: every tick is filled and the headroom is gone."
  if (tone === "elevated") return "Consumption has reached the warning value passed in by the caller."
  return "Filled ticks are consumption, the rest is headroom. The sweep spans the used and limit readings given below, nothing else."
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export interface TickStripProps {
  /** Accessible name, e.g. "Rate limit this minute". */
  readonly label: string
  readonly used: number
  readonly limit: number
  /** The caller's own early-warning value in the same unit. */
  readonly warnAt?: number
  readonly tickCount?: number
  readonly formatValue?: ValueFormatter
  /** Short text shown to the right of the strip; the caller words it. */
  readonly note?: string
  readonly className?: string
}

/**
 * The KPI-tile tick strip on its own: 36 hairline ticks, taller every sixth, filled = used,
 * remaining = headroom. Values are printed as text, so the strip is decoration-proof and the
 * numbers survive without it.
 */
export function TickStrip({
  label,
  used,
  limit,
  warnAt,
  tickCount = STRIP_TICKS,
  formatValue = rawValue,
  note,
  className,
}: TickStripProps) {
  const hasReading = Number.isFinite(used) && Number.isFinite(limit) && limit > 0
  const safeUsed = hasReading ? Math.max(0, used) : 0
  const ratio = hasReading ? safeUsed / limit : 0
  const over = hasReading && ratio > 1
  const atRisk = hasReading && warnAt !== undefined && safeUsed >= warnAt
  const tone: ChartTone = over ? "failed" : atRisk ? "elevated" : "neutral"

  const n = Math.min(120, Math.max(4, Math.round(tickCount)))
  const filled = hasReading ? Math.min(n, Math.floor(ratio * n + 1e-9)) : 0
  const gateIndex =
    hasReading && warnAt !== undefined && warnAt > 0 && warnAt < limit
      ? Math.min(n - 1, Math.max(0, Math.round((warnAt / limit) * n)))
      : null

  const cells: ReactNode[] = []
  for (let i = 0; i < n; i++) {
    const state = !hasReading ? "unknown" : i < filled ? (over ? "over" : "used") : "headroom"
    cells.push(
      <span
        key={i}
        className="szc-strip-tick"
        data-state={state}
        data-major={i % STRIP_MAJOR_EVERY === 0 || undefined}
        data-gate={gateIndex === i || undefined}
      />,
    )
  }

  return (
    <div className={cn("szc-strip-wrap", className)} data-tone={tone}>
      <div
        className="szc-strip"
        role="img"
        aria-label={
          hasReading
            ? `${label}: ${formatValue(used)} used of ${formatValue(limit)}`
            : `${label}: no data yet`
        }
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      >
        {hasReading ? cells : <span className="szc-strip-tick" data-state="unknown" />}
      </div>
      <p className="szc-strip-readout">
        <span className="szc-td-num">
          {hasReading ? `${formatValue(used)} / ${formatValue(limit)}` : "—"}
        </span>
        {note ? <span className="szc-strip-note">{note}</span> : null}
      </p>
    </div>
  )
}

export interface KpiTileProps extends KpiTileReading {
  readonly className?: string
}

/**
 * KPI tile carrying the source's two treatments: the solid inverted tile (one per row, so a
 * row has an entry point) and the tile with runway ticks. Every string is the caller's own
 * formatting; when `ticks` is present the used/limit numbers are also printed as text, so the
 * strip is never the only way to read the value.
 */
export function KpiTile({
  caption,
  value,
  detail,
  chip,
  tone = "neutral",
  variant = "line",
  ticks,
  className,
  formatValue = rawValue,
}: KpiTileProps & { formatValue?: ValueFormatter }) {
  return (
    <div
      className={cn("szc-tile", variant === "solid" && "szc-tile--solid", className)}
      data-tone={tone}
    >
      <div className="szc-tile-top">
        <p className="szc-tile-cap">{caption}</p>
        {chip ? <span className="szc-tile-chip">{chip}</span> : null}
      </div>
      <p className="szc-tile-value">{value}</p>
      {detail ? <p className="szc-tile-detail">{detail}</p> : null}
      {ticks ? (
        <TickStrip
          label={`${caption} ticks`}
          used={ticks.used}
          limit={ticks.limit}
          warnAt={ticks.warnAt}
          formatValue={formatValue}
        />
      ) : null}
    </div>
  )
}

/** A row of tiles. `solidIndex` marks which one inverts, mirroring the source's one accent tile. */
export function KpiTileRow({
  tiles,
  solidIndex = -1,
  className,
  formatValue = rawValue,
}: {
  tiles: readonly KpiTileReading[]
  solidIndex?: number
  className?: string
  formatValue?: ValueFormatter
}) {
  return (
    <div className={cn("szc-tile-row", className)}>
      {tiles.map((tile, index) => (
        <KpiTile
          key={`${tile.caption}-${index}`}
          {...tile}
          variant={index === solidIndex ? "solid" : "line"}
          formatValue={formatValue}
        />
      ))}
    </div>
  )
}
