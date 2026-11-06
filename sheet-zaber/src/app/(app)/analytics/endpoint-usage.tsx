import { Badge } from "@/components/ui/badge"
import { Sparkline } from "@/components/charts/sparkline"
import { Panel, PanelHeader } from "@/components/ui/panel"
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import { formatDay, formatNumber, formatPercent, shortId } from "@/lib/format"
import type { SeriesPoint } from "@/components/charts/series"
import { ELEVATED_ERROR_RATE_PERCENT, MIN_ERROR_RATE_SAMPLE } from "./thresholds"

/*
 * Per-endpoint usage. `count` and `errors` are the real columns of `analyticsByApi`
 * (`src/server/db/queries/logs.ts:204`), which is an ALL-TIME GROUP BY on `api_configurations` — so
 * the heading says all time instead of borrowing the page window that query cannot answer.
 *
 * The trend column is the only per-endpoint series this page can draw honestly: day buckets counted
 * out of the most recent log rows it actually read (`sampleRows`), with that scope printed in every
 * hint. An endpoint absent from that sample gets a "—" and the reason, never a flat line — the
 * chart kit's own rule (`src/components/charts/series.ts`) is that an unmeasured bucket stays absent.
 */

export type EndpointUsageRow = {
  apiId: string
  /** From the usage join itself, which is an inner join, so a name is always present. */
  name: string
  /** `null` = the endpoint list failed to read, so enabled-ness is unknown, not true. */
  enabled: boolean | null
  count: number
  errors: number
  /** `null` = unknown limit, because the endpoint row could not be read. Never a guess. */
  limitPerHour: number | null
  limitIsOverride: boolean
  /** Day buckets from the sample this page read; empty means the endpoint was not in it. */
  series: SeriesPoint[]
  /** How many sampled rows belong to this endpoint — the denominator behind the line. */
  seriesRows: number
}

export function EndpointUsageTable({
  rows,
  totalRequests,
  sampleRows,
  sampleReadable,
}: {
  rows: readonly EndpointUsageRow[]
  totalRequests: number
  /** The row count the trend was counted from, shown so the scope of the line is not a mystery. */
  sampleRows: number
  sampleReadable: boolean
}) {
  const anyDisabled = rows.some((row) => row.enabled === false)

  return (
    <Panel as="section">
      <PanelHeader
        title="Per endpoint · all time"
        description={`Requests, errors and the rate derived from them, straight from analyticsByApi. ${
          sampleReadable
            ? `The trend is UTC day buckets counted out of the ${formatNumber(sampleRows)} most recent log rows this page read, so an endpoint quieter than that sample shows no line.`
            : `The most recent log rows could not be read, so no trend is drawn at all.`
        }`}
      />
      <TableScroll label="Per-endpoint usage">
        <Table>
          <thead>
            <tr>
              <Th>Endpoint</Th>
              <Th align="right">Requests</Th>
              <Th align="right">Errors</Th>
              <Th align="right">Error rate</Th>
              <Th align="right">Share</Th>
              <Th align="right">Hour limit</Th>
              <Th>Trend</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rate = row.count > 0 ? (row.errors / row.count) * 100 : null
              const elevated =
                rate !== null &&
                row.count >= MIN_ERROR_RATE_SAMPLE &&
                rate >= ELEVATED_ERROR_RATE_PERCENT
              const share = totalRequests > 0 ? (row.count / totalRequests) * 100 : null
              const oldest = row.series[0]
              const newest = row.series[row.series.length - 1]

              return (
                <Tr key={row.apiId} interactive>
                  <Td>
                    <span className="block max-w-[240px] truncate text-paper" title={row.name}>
                      {row.name}
                    </span>
                    <span className="block font-mono text-[11px] text-dust">
                      {shortId(row.apiId)}
                      {row.enabled === null
                        ? " · not in the endpoint list read"
                        : row.enabled
                          ? ""
                          : " · disabled"}
                    </span>
                  </Td>
                  <Td numeric>{formatNumber(row.count)}</Td>
                  <Td numeric>{formatNumber(row.errors)}</Td>
                  <Td numeric>
                    {rate === null ? "—" : formatPercent(rate)}
                    {elevated ? (
                      <span className="ml-2 font-mono text-[11px] text-warn">elevated</span>
                    ) : null}
                  </Td>
                  <Td numeric>{share === null ? "—" : formatPercent(share)}</Td>
                  <Td numeric>
                    {row.limitPerHour === null ? (
                      <span className="text-dust">—</span>
                    ) : (
                      formatNumber(row.limitPerHour)
                    )}
                    <span className="block font-mono text-[11px] text-dust">
                      {row.limitPerHour === null
                        ? "no endpoint row"
                        : row.limitIsOverride
                          ? "endpoint override"
                          : "platform default"}
                    </span>
                  </Td>
                  <Td>
                    {!sampleReadable ? (
                      <span className="font-mono text-[11px] text-dust">not read</span>
                    ) : row.series.length === 0 ? (
                      <span className="font-mono text-[11px] text-dust">
                        none of the {formatNumber(sampleRows)} sampled rows
                      </span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-3">
                        <Sparkline
                          points={row.series}
                          label={`Requests per day for ${row.name}, counted from the ${formatNumber(sampleRows)} most recent log rows`}
                          tone={elevated ? "elevated" : "neutral"}
                          readout={`${formatNumber(row.seriesRows)} sampled ${row.seriesRows === 1 ? "row" : "rows"}`}
                        />
                        {row.series.length > 1 && oldest && newest ? (
                          <span className="font-mono text-[11px] text-dust">
                            {formatDay(oldest.t)} – {formatDay(newest.t)}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </Table>
      </TableScroll>

      <div className="flex flex-wrap items-center gap-3 border-t border-rule px-4 py-4">
        {anyDisabled ? <Badge variant="neutral">Disabled</Badge> : null}
        <p className="text-[13px] leading-[1.6] text-dust">
          {formatNumber(rows.length)} endpoint{rows.length === 1 ? "" : "s"} have at least one logged
          request{rows.length === 1 ? "" : "s"} — the query is an inner join, so an endpoint with no
          traffic is absent rather than zero-filled. A disabled endpoint keeps its history; the
          switch only stops new calls.
        </p>
      </div>
    </Panel>
  )
}
