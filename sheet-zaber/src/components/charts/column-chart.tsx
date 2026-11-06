/** Geometry adapted from FinanceBento (ink-orbit-saas-template), supplied by the project owner on 2026-11-05. Took the weekday capsule columns (lines 383-401): a recessive track capsule behind every value capsule with rx = bw/2, Y(x) = (Hh-pb)*(1-x/max), the recessive full-height track, the wider hit strip per column and the emphasised latest bucket; dropped "trading volume", the bought/sold 64/36 split the tooltip invented, the fixed 5K axis maximum and the hard-coded weekday names. */

import { cn } from "@/lib/cn"
import type { ReactNode } from "react"

import {
  maxFinite,
  rawValue,
  sumFinite,
  type DistributionBucket,
  type ShareFormatter,
  type ValueFormatter,
} from "./series"

import "./charts.css"

/* Source line 390 hard-codes `bw = 22`, `pb = 18` (the label gutter) and `max = 5`. The fixed bar
 * width is not carried over — `.szc-cols` sizes columns with CSS grid — and the hard-coded axis
 * maximum is replaced by the data or an explicit `domainMax`; only the gutter is taken verbatim. */
const LABEL_GUTTER = 18
/** Columns stop wearing their value above the capsule once this many compete for width. */
const DENSE_AFTER = 8

export interface ColumnChartProps {
  readonly buckets: readonly DistributionBucket[]
  readonly label: string
  readonly description?: string
  /** Plot height in pixels, excluding the label gutter underneath. */
  readonly height?: number
  /** Caller-supplied axis maximum; without it the axis stops at the largest bucket given. */
  readonly domainMax?: number
  readonly formatValue?: ValueFormatter
  /** When given, each bucket also shows its part-to-whole share, formatted by the caller. */
  readonly formatShare?: ShareFormatter
  /** Word for the aggregate line, e.g. "requests". The chart never invents a unit. */
  readonly unitLabel?: string
  readonly caption?: string
  readonly alternative?: ReactNode
  readonly className?: string
}

/**
 * Capsule columns for requests per day/hour bucket, or for any one-dimensional distribution
 * such as status codes. Empty input renders the bare gutter, and a single bucket renders one
 * capsule with no comparison implied.
 */
export function ColumnChart({
  buckets,
  label,
  description,
  height = 160,
  domainMax,
  formatValue = rawValue,
  formatShare,
  unitLabel,
  caption,
  alternative,
  className,
}: ColumnChartProps) {
  const usable = buckets.filter((b) => Number.isFinite(b.value))
  const n = usable.length
  const largest = maxFinite(usable.map((b) => b.value))
  const hasDomainMax = domainMax !== undefined && Number.isFinite(domainMax) && domainMax > 0
  const top = hasDomainMax ? domainMax : Math.max(0, largest)
  const allZero = usable.every((b) => b.value === 0)
  const total = sumFinite(usable.map((b) => b.value))

  const pctOf = (v: number) => (top > 0 ? Math.min(100, Math.max(0, (v / top) * 100)) : 0)

  const range =
    n === 0
      ? "no data yet"
      : n === 1
        ? `one bucket (${usable[0]!.label})`
        : `${n} buckets from ${usable[0]!.label} to ${usable[n - 1]!.label}`
  const ariaLabel = `${label}: ${range}${
    n > 0
      ? allZero
        ? `, every bucket is ${formatValue(0)}`
        : `, largest bucket ${formatValue(largest)}${unitLabel ? ` of ${formatValue(total)} ${unitLabel}` : ""}`
      : ""
  }`

  const dense = n > DENSE_AFTER
  /* A dense chart hides values behind hover, so the same numbers go into a visible table;
   * a sparse one shows them above each capsule and keeps the table for assistive tech. */
  const tableClass = dense ? "szc-table" : "szc-table sr-only"

  const table = (
    <table className={tableClass}>
      <caption className="sr-only">
        {label}
        {description ? ` - ${description}` : ""}
      </caption>
      <thead>
        <tr>
          <th scope="col">Bucket</th>
          <th scope="col">{unitLabel ? `Value (${unitLabel})` : "Value"}</th>
          {formatShare ? <th scope="col">Share</th> : null}
        </tr>
      </thead>
      <tbody>
        {usable.map((b) => (
          <tr key={`${b.label}-${formatValue(b.value)}`}>
            <th scope="row">{b.label}</th>
            <td className="szc-td-num">{formatValue(b.value)}</td>
            {formatShare ? (
              <td className="szc-td-num">{total > 0 ? formatShare(b.value / total) : "—"}</td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <figure className={cn("szc-figure szc-figure-columns", className)}>
      <div className="szc-head">
        <p className="szc-cap">{label}</p>
        {n > 0 ? (
          <p className="szc-readout">
            <span className="szc-td-num">{formatValue(total)}</span>
            {unitLabel ? <span className="szc-readout-unit">{unitLabel}</span> : null}
          </p>
        ) : null}
      </div>

      {description ? <p className="szc-sub">{description}</p> : null}

      {n === 0 ? (
        <div className="szc-plot" role="img" aria-label={ariaLabel} style={{ height }}>
          <p className="szc-empty">No data yet</p>
        </div>
      ) : (
        <div className="szc-columns" style={{ height: height + LABEL_GUTTER }}>
          <div className="szc-y-rail" style={{ height }} aria-hidden="true">
            {top > 0 ? (
              <span className="szc-y-tick" style={{ bottom: `${pctOf(top)}%` }}>
                {formatValue(top)}
              </span>
            ) : null}
            <span className="szc-y-tick" style={{ bottom: 0 }}>
              {formatValue(0)}
            </span>
          </div>

          <div className="szc-col-plot" role="img" aria-label={ariaLabel} style={{ height }}>
            {top > 0 ? <span className="szc-gridline" style={{ bottom: "100%" }} aria-hidden="true" /> : null}
            <span className="szc-gridline szc-gridline--base" aria-hidden="true" />
            <div
              className="szc-cols"
              data-dense={dense || undefined}
              style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
            >
              {usable.map((b, i) => {
                const pct = pctOf(b.value)
                return (
                  <div
                    key={`col-${b.label}-${i}`}
                    className="szc-col"
                    data-tone={b.tone ?? "neutral"}
                    data-latest={i === n - 1 && n > 1 ? "true" : undefined}
                    title={
                      formatShare && total > 0
                        ? `${b.label}: ${formatValue(b.value)} (${formatShare(b.value / total)})`
                        : `${b.label}: ${formatValue(b.value)}`
                    }
                  >
                    <div className="szc-col-track">
                      <span className="szc-col-rail" aria-hidden="true" />
                      <span
                        className="szc-col-bar"
                        aria-hidden="true"
                        style={{ height: pct <= 0 ? "0%" : `max(${pct}%, 6px)` }}
                      />
                      <span
                        className="szc-col-note"
                        aria-hidden="true"
                        style={{ insetBlockEnd: `calc(min(${pct}%, 92%) + 4px)` }}
                      >
                        {formatValue(b.value)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div
            className="szc-col-foots"
            aria-hidden="true"
            style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
          >
            {usable.map((b, i) => (
              <span key={`foot-${b.label}-${i}`} className="szc-foot" data-tone={b.tone ?? "neutral"}>
                <span className="szc-foot-label">{b.label}</span>
                {formatShare && total > 0 ? (
                  <span className="szc-foot-share">{formatShare(b.value / total)}</span>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      )}

      <figcaption className="szc-caption">
        {caption ??
          (n === 0
            ? "Nothing has been recorded for this window yet, so there are no columns to draw."
            : n === 1
              ? "One bucket: a single reading, with nothing to compare it against."
              : allZero
                ? "Every bucket is zero, so only the tracks are drawn."
                : dense
                  ? "Hover a column for its value; the full table below carries the same numbers."
                  : hasDomainMax
                    ? "Capsule height is the bucket value against the supplied axis maximum."
                    : "Capsule height is the bucket value against the largest bucket in this data.")}
      </figcaption>

      {alternative ? <div className="szc-alt">{alternative}</div> : table}
    </figure>
  )
}
