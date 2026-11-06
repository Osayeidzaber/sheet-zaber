import type { Metadata } from "next"
import Link from "next/link"

import { AnimatedCircularProgressBar } from "@/components/fx/progress-ring"
import { SetupChecklist, type SetupStep } from "@/components/app/setup-checklist"
import { ColumnChart } from "@/components/charts/column-chart"
import { Badge, isHttpMethod, MethodTag, StatusCode, StatusDot } from "@/components/ui/badge"
import { PillLink } from "@/components/ui/button"
import { Panel, PanelBody, PanelHeader, PageHeader, Row, RowTitle } from "@/components/ui/panel"
import { StatBand } from "@/components/ui/stat-band"
import { EmptyState, ErrorState } from "@/components/ui/state"
import { Table, TableScroll, Td, Th, Tr, MonoCell } from "@/components/ui/table"
import { isActionError } from "@/lib/action-result"
import {
  formatDateTime,
  formatDay,
  formatDuration,
  formatNumber,
  formatPercent,
  meta,
  shortId,
} from "@/lib/format"
import { listConnectionsAction } from "@/server/actions/connections"
import { requireUser } from "@/server/auth/guards"
import { listApis } from "@/server/apis/service"
import { analyticsOverview, listRequestLogs } from "@/server/db/queries/logs"
import { listSpreadsheets } from "@/server/db/queries/spreadsheets"
import { listKeys } from "@/server/keys/service"

export const metadata: Metadata = {
  title: "Overview",
  description: "Your spreadsheets, endpoints, keys and measured traffic at a glance.",
}

const WINDOW_DAYS = 14
const RECENT_ROWS = 8

/*
 * Real numbers only. Every figure below comes from one of: analyticsOverview (totals + the
 * by-day series), listRequestLogs (recent rows; the response-time tile is the measured mean
 * of exactly the rows fetched — analyticsOverview carries no latency), listApis/listKeys,
 * listSpreadsheets and listConnectionsAction. Nothing here is estimated or seeded; where a read
 * fails, the page says so instead of showing a number.
 */

export default async function OverviewPage() {
  const user = await requireUser()

  const to = new Date()
  const from = new Date(to.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const [connectionsResult, apisResult, keysResult, spreadsheets, analytics, logs] =
    await Promise.all([
      listConnectionsAction(),
      listApis(user.id),
      listKeys(user.id),
      listSpreadsheets(user.id),
      analyticsOverview(user.id, from, to),
      listRequestLogs({ userId: user.id, page: 1, perPage: 50 }),
    ])

  const readErrors: { label: string; body: string; code: string }[] = []
  if (isActionError(connectionsResult)) {
    readErrors.push({
      label: "Google connections",
      body: connectionsResult.error.message,
      code: connectionsResult.error.code,
    })
  }
  if (isActionError(apisResult)) {
    readErrors.push({ label: "Endpoints", body: apisResult.error.message, code: apisResult.error.code })
  }
  if (isActionError(keysResult)) {
    readErrors.push({ label: "API keys", body: keysResult.error.message, code: keysResult.error.code })
  }

  const connections = isActionError(connectionsResult) ? null : connectionsResult.data
  const apis = isActionError(apisResult) ? null : apisResult.data
  const keys = isActionError(keysResult) ? null : keysResult.data

  const connectedSheets = connections?.filter((c) => c.status === "connected").length ?? null
  const reauthSheets = connections?.filter((c) => c.status === "reauth_required").length ?? null
  const activeApis = apis?.filter((api) => api.enabled).length ?? null
  const lapsedKeys = keys?.filter((key) => key.expiresAt !== null && key.expiresAt <= to).length ?? null

  const errorRate = analytics.requests > 0 ? (analytics.failed / analytics.requests) * 100 : null
  const durations = logs.rows.map((row) => row.durationMs)
  const meanDuration =
    durations.length > 0 ? durations.reduce((sum, ms) => sum + ms, 0) / durations.length : null

  const freshAccount =
    readErrors.length === 0 &&
    analytics.requests === 0 &&
    logs.total === 0 &&
    spreadsheets.length === 0 &&
    (apis?.length ?? 0) === 0 &&
    (keys?.length ?? 0) === 0

  // Each step reads what the account actually holds; a failed read shows the step as not done.
  const setupSteps: SetupStep[] = [
    {
      title: "Register a spreadsheet",
      body: "Paste a Google Sheet link. Sheet Zaber proves your own Google grant can read it.",
      done: spreadsheets.length > 0,
      href: "/spreadsheets",
      action: "Register a spreadsheet",
    },
    {
      title: "Publish a tab as an endpoint",
      body: "One tab of one registered spreadsheet becomes one REST API.",
      done: (apis?.length ?? 0) > 0,
      href: "/apis/new",
      action: "Create an endpoint",
    },
    {
      title: "Create an API key",
      body: "The full key is shown once, when you create it. Only its hash is stored.",
      done: (keys?.length ?? 0) > 0,
      href: "/keys",
      action: "Create a key",
    },
    {
      title: "Send your first request",
      body: "Try the endpoint from the playground. It appears in your logs straight away.",
      done: logs.total > 0,
      href: "/playground",
      action: "Open the playground",
    },
  ]

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="01 — Overview"
        title="Overview" titleAside="at a glance"
        description={`What is registered, what is live, and what your endpoints did in the last ${WINDOW_DAYS} days.`}
        action={
          freshAccount ? undefined : (
            <PillLink href="/playground" variant="line" size="sm">
              Send a test request
            </PillLink>
          )
        }
      />

      {readErrors.map((failure) => (
        <ErrorState
          key={failure.label}
          title={`${failure.label} could not be read`}
          body={failure.body}
          code={failure.code}
        />
      ))}

      {freshAccount ? (
        <SetupChecklist steps={setupSteps} />
      ) : (
        <>
          <StatBand
            label="Key numbers"
            columns={6}
            items={[
              {
                label: "Spreadsheets",
                value: formatNumber(spreadsheets.length),
                sub: meta(
                `${spreadsheets.filter((s) => s.status === "active").length} readable`,
                spreadsheets.some((s) => s.status === "inaccessible")
                  ? `${spreadsheets.filter((s) => s.status === "inaccessible").length} inaccessible`
                  : null
              ),
              },
              {
                label: "Endpoints",
                value: apis === null ? "—" : formatNumber(apis.length),
                sub: apis === null ? "unreadable" : meta(`${activeApis} enabled`, reauthSheets ? `${reauthSheets} Google reauth` : null),
              },
              {
                label: "API keys",
                value: keys === null ? "—" : formatNumber(keys.length),
                sub: keys === null
                  ? "unreadable"
                  : meta(
                      "active only",
                      lapsedKeys && lapsedKeys > 0 ? `${lapsedKeys} lapsed` : null
                    ),
              },
              {
                label: `Requests · ${WINDOW_DAYS}d`,
                value: formatNumber(analytics.requests),
                sub: `${formatNumber(analytics.success)} ok · ${formatNumber(analytics.failed)} failed`,
              },
              {
                label: "Error rate",
                value: errorRate === null ? "—" : formatPercent(errorRate),
                sub: errorRate === null ? "no requests in window" : `${formatNumber(analytics.failed)} of ${formatNumber(analytics.requests)} failed`,
                tone: analytics.failed > 0 ? "failed" : "neutral",
              },
              {
                label: "Response time",
                value: meanDuration === null ? "—" : formatDuration(meanDuration),
                sub: meanDuration === null
                  ? "no logged requests"
                  : `mean of last ${durations.length} logged requests`,
              },
            ]}
          />

          <SetupChecklist steps={setupSteps} />

          <Panel as="section">
            <PanelHeader
              title="Requests over time"
              description={`Day buckets from analyticsOverview, ${formatDay(from.toISOString())} – ${formatDay(to.toISOString())}.`}
            />
            <PanelBody>
              <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <ColumnChart
                    label="Requests per day"
                    unitLabel="requests"
                    height={180}
                    formatValue={formatNumber}
                    buckets={analytics.byDay.map((bucket) => ({
                      label: formatDay(bucket.day),
                      value: bucket.count,
                    }))}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-5">
                  <AnimatedCircularProgressBar
                    value={errorRate === null ? 0 : Math.round(errorRate)}
                    label="Failed share of requests"
                    className="size-28"
                  />
                  <div>
                    <p className="folio">Failed share</p>
                    <p className="mt-2 text-[15px] text-paper num">
                      {errorRate === null ? "—" : `${formatPercent(errorRate)} of ${formatNumber(analytics.requests)} requests`}
                    </p>
                    <p className="mt-1 font-mono text-[12px] text-dust">
                      {formatNumber(analytics.failed)} failed · {formatNumber(analytics.success)} ok
                    </p>
                  </div>
                </div>
              </div>
            </PanelBody>
          </Panel>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel as="section">
              <PanelHeader
                title="Spreadsheets"
                description={
                  connections === null
                    ? "Connection status unreadable."
                    : `${connectedSheets ?? 0} Google ${connectedSheets === 1 ? "connection" : "connections"} active.`
                }
                action={
                  <Link href="/spreadsheets" className="pill pill-line min-h-10 px-4 text-[14px]">
                    Manage
                  </Link>
                }
              />
              {spreadsheets.length === 0 ? (
                <PanelBody>
                  <EmptyState
                    title="No spreadsheets registered"
                    body="Register a Google Sheet to publish its first endpoint."
                    action={
                      <PillLink href="/spreadsheets" variant="line" size="sm">
                        Register a spreadsheet
                      </PillLink>
                    }
                  />
                </PanelBody>
              ) : (
                <ul>
                  {spreadsheets.slice(0, RECENT_ROWS).map((sheet) => (
                    <Row key={sheet.id} as="li" interactive>
                      <RowTitle
                        title={sheet.title}
                        meta={meta(`${sheet.tabs.length} tabs`, shortId(sheet.googleSheetId, 8, 4))}
                      />
                      <StatusDot
                        tone={sheet.status === "active" ? "active" : "failed"}
                        label={sheet.status === "active" ? "Readable" : "No access"}
                      />
                    </Row>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel as="section">
              <PanelHeader
                title="Endpoints"
                description={
                  apis === null
                    ? "Endpoint read failed — see the notice above."
                    : meta(`${activeApis ?? 0} enabled`, `of ${apis.length} total`)
                }
                action={
                  <Link href="/apis" className="pill pill-line min-h-10 px-4 text-[14px]">
                    Manage
                  </Link>
                }
              />
              {apis === null || apis.length === 0 ? (
                <PanelBody>
                  <EmptyState
                    title="No endpoints yet"
                    body="Each endpoint publishes one tab of one registered spreadsheet as a REST API."
                    action={
                      <PillLink href="/apis" variant="line" size="sm">
                        Create an endpoint
                      </PillLink>
                    }
                  />
                </PanelBody>
              ) : (
                <ul>
                  {apis.slice(0, RECENT_ROWS).map((api) => (
                    <Row key={api.id} as="li" interactive>
                      <RowTitle title={api.name} meta={meta(api.tabTitle, api.permissions)} />
                      <Badge variant={api.enabled ? "inverted" : "neutral"}>
                        {api.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </Row>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <Panel as="section">
            <PanelHeader
              title="Recent activity"
              description={`Newest rows from your request log · ${formatNumber(logs.total)} total.`}
              action={
                <>
                  <Link href="/logs" className="pill pill-line min-h-10 px-4 text-[14px]">
                    All logs
                  </Link>
                  <Link href="/analytics" className="pill pill-line min-h-10 px-4 text-[14px]">
                    Analytics
                  </Link>
                </>
              }
            />
            {logs.rows.length === 0 ? (
              <PanelBody>
                <p className="text-[14px] text-dust">
                  No requests have been recorded for this account yet.
                </p>
              </PanelBody>
            ) : (
              <TableScroll label="Recent request activity">
                <Table>
                  <thead>
                    <tr>
                      <Th>Time</Th>
                      <Th>Method</Th>
                      <Th>Endpoint</Th>
                      <Th>Path</Th>
                      <Th align="right">Status</Th>
                      <Th align="right">Time</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.rows.slice(0, RECENT_ROWS).map((row) => (
                      <Tr key={row.id} interactive>
                        <Td className="whitespace-nowrap text-dust">
                          {formatDateTime(row.createdAt.toISOString())}
                        </Td>
                        <Td>
                          {isHttpMethod(row.method) ? (
                            <MethodTag method={row.method} />
                          ) : (
                            <span className="font-mono text-[12px]">{row.method}</span>
                          )}
                        </Td>
                        <Td>
                          <span className="block max-w-[200px] truncate text-paper">
                            {row.apiName ?? "Unknown endpoint"}
                          </span>
                        </Td>
                        <Td>
                          <MonoCell value={row.path} />
                        </Td>
                        <Td align="right">
                          <StatusCode code={row.statusCode} />
                        </Td>
                        <Td numeric>{formatDuration(row.durationMs)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableScroll>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
