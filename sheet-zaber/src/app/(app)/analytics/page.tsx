import type { Metadata } from "next"

import { ColumnChart } from "@/components/charts/column-chart"
import { DivergingWaves } from "@/components/charts/diverging-waves"
import { TickGauge } from "@/components/charts/tick-gauge"
import { PillLink } from "@/components/ui/button"
import { Metric, Panel, PanelBody, PanelHeader, PageHeader } from "@/components/ui/panel"
import { Banner, ErrorState } from "@/components/ui/state"
import {
  formatDay,
  formatDuration,
  formatNumber,
  formatPercent,
  meta,
} from "@/lib/format"
import { isActionError } from "@/lib/action-result"
import { requireUser } from "@/server/auth/guards"
import { listApis } from "@/server/apis/service"
import {
  analyticsByApi,
  analyticsOverview,
  listRequestLogs,
  type AnalyticsOverview,
  type LogRow,
} from "@/server/db/queries/logs"
import type { SeriesPoint } from "@/components/charts/series"
import { EndpointUsageTable, type EndpointUsageRow } from "./endpoint-usage"
import {
  DEFAULT_REQUESTS_PER_DAY,
  DEFAULT_REQUESTS_PER_HOUR,
  ELEVATED_ERROR_RATE_PERCENT,
  MIN_ERROR_RATE_SAMPLE,
  errorRatePercent,
  isElevatedErrorRate,
} from "./thresholds"
import { WindowSwitch } from "./window-switch"
import { parseAnalyticsWindow, windowDaysLabel, type SearchParamsValue } from "./window-params"

export const metadata: Metadata = {
  title: "Analytics",
  description: "Measured traffic: what your endpoints handled, how much of it failed, and how counts compare with default limits.",
}

/*
 * Traffic readings come from three queries in `src/server/db/queries/logs.ts`, mapped into the
 * chart kit's primitive inputs. Rates, shares, deltas and the sample mean are calculated from
 * those results; configured limits come from listApis, with documented defaults as references.
 *
 *   analyticsOverview(user, from, to)  -> totals + the per-day groups for one bounded window
 *   analyticsByApi(user)               -> ALL-TIME requests and errors per endpoint
 *   listRequestLogs({ userId, ... })   -> the most recent rows, used for the labelled sample
 *                                         readings (mean duration, per-endpoint day trend)
 *
 * `AnalyticsOverview` carries no latency and no per-day status split, so this page has no
 * window-wide latency tile and no per-day failure wave; the alternatives it does show state their
 * own scope, and the last panel lists what cannot be measured with the queries that exist.
 */

/** Rows read for the sample-scoped readings. `paginationSchema` allows 1-200 (`src/lib/schemas.ts:14`). */
const SAMPLE_ROWS = 200
/** Per-endpoint bars drawn before the chart goes dense; the table below always lists all of them. */
const TOP_ENDPOINTS = 12

type Read<T> = { ok: true; data: T } | { ok: false; message: string }

/**
 * A failed aggregate is reported as a failed read, never replaced with a zero: a `0` would be a
 * number the database did not give us, and on a traffic page that is indistinguishable from a quiet
 * account.
 */
async function read<T>(message: string, fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch {
    return { ok: false, message }
  }
}

/** UTC day key for sampled rows; the aggregate query groups in the database session timezone. */
function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function signed(value: number): string {
  if (value > 0) return `+${formatNumber(value)}`
  if (value < 0) return `−${formatNumber(Math.abs(value))}`
  return "0"
}

/** Oldest-first day buckets for one endpoint, counted out of the rows the page actually read. */
function trendOf(rows: readonly LogRow[]): SeriesPoint[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = dayKey(row.createdAt.toISOString())
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([t, v]) => ({ t, v }))
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsValue>
}) {
  const user = await requireUser()
  const { window: win, invalid } = parseAnalyticsWindow(await searchParams)
  const windowName = windowDaysLabel(win.days)

  const [currentRead, previousRead, hourRead, dayRead, usageRead, sampleRead, apisResult] =
    await Promise.all([
      read("The window aggregate did not run.", () => analyticsOverview(user.id, win.from, win.to)),
      read("The comparison window did not run.", () =>
        analyticsOverview(user.id, win.previousFrom, win.previousTo)
      ),
      read("The last-hour aggregate did not run.", () =>
        analyticsOverview(user.id, win.hourFrom, win.to)
      ),
      read("The last-24-hour aggregate did not run.", () =>
        analyticsOverview(user.id, win.dayFrom, win.to)
      ),
      read("The per-endpoint aggregate did not run.", () => analyticsByApi(user.id)),
      read("The most recent log rows could not be read.", () =>
        listRequestLogs({ userId: user.id, page: 1, perPage: SAMPLE_ROWS })
      ),
      listApis(user.id),
    ])

  const current: AnalyticsOverview | null = currentRead.ok ? currentRead.data : null
  const previous: AnalyticsOverview | null = previousRead.ok ? previousRead.data : null
  const hour: AnalyticsOverview | null = hourRead.ok ? hourRead.data : null
  const day: AnalyticsOverview | null = dayRead.ok ? dayRead.data : null
  const usage = usageRead.ok ? usageRead.data : null
  const sample = sampleRead.ok ? sampleRead.data : null
  const apis = isActionError(apisResult) ? null : apisResult.data

  const failures: Array<{ label: string; body: string; code?: string }> = []
  for (const [label, result] of [
    ["Window aggregate", currentRead],
    ["Comparison window", previousRead],
    ["Last-hour aggregate", hourRead],
    ["Last-24-hour aggregate", dayRead],
    ["Per-endpoint aggregate", usageRead],
    ["Recent log rows", sampleRead],
  ] as const) {
    if (!result.ok) failures.push({ label, body: result.message })
  }
  if (isActionError(apisResult)) {
    failures.push({
      label: "Endpoints",
      body: apisResult.error.message,
      code: apisResult.error.code,
    })
  }

  const errorRate = current === null ? null : errorRatePercent(current.requests, current.failed)
  const previousRate = previous === null ? null : errorRatePercent(previous.requests, previous.failed)
  const requestDelta = current !== null && previous !== null ? current.requests - previous.requests : null

  // Sample-scoped readings, labelled as such wherever they appear.
  const durations = sample?.rows.map((row) => row.durationMs) ?? []
  const meanDuration =
    durations.length > 0 ? durations.reduce((sum, ms) => sum + ms, 0) / durations.length : null

  const apiById = new Map((apis ?? []).map((api) => [api.id, api]))
  const overridden = apis?.filter((api) => api.rateLimitPerHour !== null).length ?? null

  const trendRows = new Map<string, LogRow[]>()
  for (const row of sample?.rows ?? []) {
    if (row.apiId === null) continue
    const bucket = trendRows.get(row.apiId)
    if (bucket === undefined) trendRows.set(row.apiId, [row])
    else bucket.push(row)
  }

  const usageRows: EndpointUsageRow[] = (usage ?? []).map((row) => {
    const api = apiById.get(row.apiId)
    const rows = trendRows.get(row.apiId) ?? []
    return {
      apiId: row.apiId,
      name: row.name,
      enabled: api === undefined ? null : api.enabled,
      count: row.count,
      errors: row.errors,
      limitPerHour:
        api === undefined ? null : (api.rateLimitPerHour ?? DEFAULT_REQUESTS_PER_HOUR),
      limitIsOverride: api !== undefined && api.rateLimitPerHour !== null,
      series: sample === null ? [] : trendOf(rows),
      seriesRows: rows.length,
    }
  })

  const usageTotal = (usage ?? []).reduce((sum, row) => sum + row.count, 0)
  const drawnUsage = usageRows.slice(0, TOP_ENDPOINTS)

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="07 — Analytics"
        title="Analytics" titleAside="measured"
        description={`Aggregates of your own request log. Each figure names the query and the window it came from, so a number here is never a guess dressed up as a measurement.`}
        action={
          <>
            <PillLink href="/logs?status=failed" variant="line" size="sm">
              Failed rows
            </PillLink>
            <PillLink href="/logs" variant="line" size="sm">
              Request log
            </PillLink>
          </>
        }
      />

      {invalid !== null ? (
        <Banner
          tone="attention"
          title={`days=${invalid} is not an offered window`}
          body={`7, 14, 30 and 90 days are the choices, and this page measured ${windowName} instead — every label below says so. Pick a window and the URL will carry it.`}
        />
      ) : null}

      {failures.map((failure) => (
        <ErrorState
          key={failure.label}
          title={`${failure.label} could not be read`}
          body={`${failure.body} No figure that depends on it is shown — a zero here would be a number the database did not give.`}
          code={failure.code ?? null}
        />
      ))}

      <WindowSwitch current={win.days} window={win} />

      <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <Metric
          label={`Requests · ${win.days}d`}
          value={current === null ? "—" : formatNumber(current.requests)}
          sub={
            current === null
              ? "unreadable"
              : meta(`${formatNumber(current.success)} ok`, `${formatNumber(current.failed)} failed`)
          }
        />
        <Metric
          label="Error rate"
          value={errorRate === null ? "—" : formatPercent(errorRate)}
          sub={
            errorRate === null
              ? current === null
                ? "unreadable"
                : "no requests in this window"
              : meta(
                  `${formatNumber(current?.failed ?? 0)} of ${formatNumber(current?.requests ?? 0)}`,
                  previousRate === null ? null : `previous ${formatPercent(previousRate)}`
                )
          }
          tone={current !== null && current.failed > 0 ? "failed" : "neutral"}
        />
        <Metric
          label={`Previous ${win.days}d`}
          value={previous === null ? "—" : formatNumber(previous.requests)}
          sub={
            previous === null
              ? "unreadable"
              : meta(
                  `${formatNumber(previous.failed)} failed`,
                  `${formatDay(win.previousFrom.toISOString())} – ${formatDay(win.previousTo.toISOString())}`
                )
          }
        />
        <Metric
          label="Change vs previous"
          value={requestDelta === null ? "—" : signed(requestDelta)}
          sub={
            requestDelta === null
              ? "needs both windows"
              : requestDelta === 0
                ? "same count as the window before it"
                : `requests, ${windowName} against the ${windowName} before it`
          }
        />
        <Metric
          label="Mean response time"
          value={meanDuration === null ? "—" : formatDuration(meanDuration)}
          sub={
            meanDuration === null
              ? sampleRead.ok
                ? "no rows read"
                : "rows unreadable"
              : `measured mean of the last ${formatNumber(durations.length)} logged rows`
          }
        />
        <Metric
          label="Endpoints with traffic"
          value={usage === null ? "—" : formatNumber(usage.length)}
          sub={
            usage === null
              ? "unreadable"
              : meta(
                  "all time",
                  apis === null ? "registered count unreadable" : `${formatNumber(apis.length)} registered`
                )
          }
        />
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel as="section">
          <PanelHeader
            title={`Requests per day · ${windowName}`}
            description="Groups from analyticsOverview's byDay series. A day with no traffic produces no group at all, so it is absent rather than drawn as a zero — the labels name the days that do exist."
          />
          <PanelBody>
            {current === null ? (
              <p className="text-[13px] leading-[1.7] text-dust">
                <span className="folio-strong">Day groups not shown.</span> The window aggregate did
                not run, so an empty plot would read as &ldquo;no traffic in this window&rdquo; — which
                the database did not say.
              </p>
            ) : (
              <ColumnChart
                label="Requests"
                unitLabel="requests"
                height={180}
                formatValue={formatNumber}
                buckets={current.byDay.map((bucket) => ({
                  label: formatDay(bucket.day),
                  value: bucket.count,
                }))}
              />
            )}
          </PanelBody>
        </Panel>

        <Panel as="section">
          <PanelHeader
            title="Success against failure · whole window"
            description="One bucket, because analyticsOverview counts the window rather than splitting it by day: the wave draws a reading, not a curve it does not have."
          />
          <PanelBody>
            {current === null ? (
              <p className="text-[13px] leading-[1.7] text-dust">
                <span className="folio-strong">Success and failure not shown.</span> The window
                aggregate did not run, so there is no reading to place on either side of the axis.
              </p>
            ) : current.requests === 0 ? (
              <p className="text-[13px] leading-[1.7] text-dust">
                <span className="folio-strong">Nothing to split.</span> The window aggregate ran and
                found no requests at all, so both sides of the axis are genuinely zero — not
                unreadable.
              </p>
            ) : (
              <DivergingWaves
                rows={[
                  {
                    t: `${windowName} total`,
                    positive: current.success,
                    negative: current.failed,
                  },
                ]}
                label="Successful and failed requests"
                aboveName="Successful (status below 400)"
                belowName="Failed (400 and up)"
                height={246}
                formatValue={formatNumber}
              />
            )}
          </PanelBody>
        </Panel>
      </div>

      <Panel as="section">
        <PanelHeader
          title="Traffic against default limits"
          description="Account-wide logged requests compared with the 1,000/hour and 10,000/day default limits. These are rolling log totals, not the engine's fixed-window counters or your remaining allowance. Per-endpoint overrides, per-user daily quotas and IP limits also apply."
        />
        <div className="grid gap-6 md:grid-cols-2">
          <PanelBody>
            {hour === null ? (
              <p className="text-[13px] leading-[1.7] text-dust">
                <span className="folio-strong">Hourly comparison not shown.</span> The last-60-minutes
                aggregate did not run, and an empty gauge would read as &ldquo;nothing used&rdquo; — which
                the database did not say.
              </p>
            ) : (
              <TickGauge
                label="Last-hour requests · default-limit comparison"
                description="analyticsOverview over the last 60 minutes, against the default per-endpoint, per-key hourly limit."
                used={hour.requests}
                limit={DEFAULT_REQUESTS_PER_HOUR}
                warnAt={DEFAULT_REQUESTS_PER_HOUR}
                formatValue={formatNumber}
                readoutNote={`${formatNumber(hour.failed)} of them failed`}
                caption="Filled ticks compare logged traffic with the default limit; headroom is the difference, not an available quota."
                alternative={
                  <p className="text-[12px] leading-[1.6] text-dust">
                    This rolling 60-minute read is independent of the page window and does not
                    track a fixed-window reset.{" "}
                    {overridden === null
                      ? "Per-endpoint overrides could not be read."
                      : overridden === 0
                        ? "No endpoint overrides the hourly limit today."
                        : `${formatNumber(overridden)} endpoint${overridden === 1 ? " uses" : "s use"} a custom hourly limit.`}
                  </p>
                }
              />
            )}
          </PanelBody>
          <PanelBody>
            {day === null ? (
              <p className="text-[13px] leading-[1.7] text-dust">
                <span className="folio-strong">Daily comparison not shown.</span> The last-24-hours
                aggregate did not run, so there is no reading to place against the daily limit.
              </p>
            ) : (
              <TickGauge
                label="Last-24-hour requests · default-limit comparison"
                description="analyticsOverview over the last 24 hours, against the default per-key daily limit."
                used={day.requests}
                limit={DEFAULT_REQUESTS_PER_DAY}
                warnAt={DEFAULT_REQUESTS_PER_DAY}
                formatValue={formatNumber}
                readoutNote={`${formatNumber(day.failed)} of them failed`}
                caption="Filled ticks compare logged traffic with the default limit; headroom is the difference, not an available quota."
                alternative={
                  <p className="text-[12px] leading-[1.6] text-dust">
                    The engine enforces fixed windows and returns 429 with Retry-After when a
                    limit is reached. This rolling log total does not read those counters; some
                    logged failures never reach the limiter.
                  </p>
                }
              />
            )}
          </PanelBody>
        </div>
      </Panel>

      {current !== null && isElevatedErrorRate(current.requests, current.failed) ? (
        <Banner
          tone="attention"
          title={`Elevated error rate: ${formatPercent(errorRate)} over ${windowName}`}
          body={`This page calls a rate elevated at ${ELEVATED_ERROR_RATE_PERCENT}% or more once there are at least ${formatNumber(MIN_ERROR_RATE_SAMPLE)} requests to judge — here ${formatNumber(current.failed)} of ${formatNumber(current.requests)} failed. The failure categories live in the log, filtered for you.`}
          action={
            <PillLink href="/logs?status=failed" variant="line" size="sm">
              Open the failed rows
            </PillLink>
          }
        />
      ) : null}

      {usage === null ? null : usage.length === 0 ? (
        <Panel as="section">
          <PanelHeader
            title="Per endpoint · all time"
            description="No endpoint has a logged request yet, so the aggregate returned no rows. This is not a zero-filled table — the query is an inner join, and an endpoint without traffic simply is not in it."
          />
        </Panel>
      ) : (
        <>
          <Panel as="section">
            <PanelHeader
              title={`Busiest endpoints · ${formatNumber(usage.length)} of them`}
              description={
                usageRows.length > TOP_ENDPOINTS
                  ? `The ${formatNumber(TOP_ENDPOINTS)} busiest of ${formatNumber(usageRows.length)} by all-time request count. Chart shares use only these displayed endpoints; the table below lists every endpoint and its account-wide share. Amber marks an elevated error rate, also labelled in the table.`
                  : `All ${formatNumber(usageRows.length)} endpoints with logged requests. Amber marks an error rate of at least ${ELEVATED_ERROR_RATE_PERCENT}% over at least ${formatNumber(MIN_ERROR_RATE_SAMPLE)} requests; the table also labels it elevated.`
              }
            />
            <PanelBody>
              <ColumnChart
                label="Requests per endpoint"
                unitLabel="requests"
                height={200}
                formatValue={formatNumber}
                formatShare={(share) => formatPercent(share * 100)}
                buckets={drawnUsage.map((row) => ({
                  label: row.name,
                  value: row.count,
                  tone:
                    row.count >= MIN_ERROR_RATE_SAMPLE &&
                    (row.errors / row.count) * 100 >= ELEVATED_ERROR_RATE_PERCENT
                      ? ("elevated" as const)
                      : undefined,
                }))}
              />
            </PanelBody>
          </Panel>

          <EndpointUsageTable
            rows={usageRows}
            totalRequests={usageTotal}
            sampleRows={sample?.rows.length ?? 0}
            sampleReadable={sample !== null}
          />
        </>
      )}

      <Panel as="section">
        <PanelHeader
          title="What this page cannot measure"
          description="Stated plainly, because the alternative is a chart that looks like it knows."
        />
        <PanelBody className="flex flex-col gap-3 text-[13px] leading-[1.7] text-mist">
          <p>
            <span className="text-paper">Latency over the window.</span> <span className="font-mono">AnalyticsOverview</span> returns
            counts only, so there is no p50/p95 and no window-wide mean here. The tile above is a
            measured mean of up to {formatNumber(SAMPLE_ROWS)} recent rows; its sub-line gives the actual count.
          </p>
          <p>
            <span className="text-paper">Success against failure per day.</span> The by-day group has no
            status split, so the wave is one labelled bucket for the whole window instead of a daily
            failure series.
          </p>
          <p>
            <span className="text-paper">Per-endpoint counts inside the page window.</span>{" "}
            <span className="font-mono">analyticsByApi</span> is an all-time GROUP BY (the same one{" "}
            <span className="font-mono">GET /api/internal/apis/&#123;id&#125;/stats</span> uses), which is why that
            table is headed &ldquo;all time&rdquo;.
          </p>
          <p>
            <span className="text-paper">A per-endpoint trend over the whole window.</span> The trend column
            counts UTC day buckets out of up to {formatNumber(SAMPLE_ROWS)} recent rows the page read; a
            busier endpoint than that sample simply has fewer days of it, and an absent endpoint shows
            no line.
          </p>
          <p>
            <span className="text-paper">Enforced quota consumption.</span>{" "}
            <span className="font-mono">analyticsOverview</span> counts account-wide log rows, not{" "}
            <span className="font-mono">rate_limit_buckets</span>. The gauges compare rolling traffic
            with defaults, not per-key, per-user or IP consumption and remaining quota.
          </p>
          <p>
            <span className="text-paper">Hourly buckets.</span> Only day buckets are grouped
            (<span className="font-mono">to_char(created_at, &apos;YYYY-MM-DD&apos;)</span>), so nothing here is
            drawn at a resolution finer than a day except the two rolling 60-minute and 24-hour totals.
          </p>
        </PanelBody>
      </Panel>

      <p className="text-[13px] leading-[1.7] text-dust">
        {meta(
          `Counts come from api_request_logs only — no body, header, key or cell value is ever recorded.`,
          `All-time means all retained rows. pruneOldLogs is available, but no scheduler is wired in this app; these queries cannot establish why older rows are absent.`,
          "Share and rate are derived from the two columns they name; nothing is averaged over a bucket that has no rows."
        )}
      </p>
    </div>
  )
}
