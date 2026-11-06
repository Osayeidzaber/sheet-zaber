import type { Metadata } from "next"

import { PillLink } from "@/components/ui/button"
import { Panel, PanelBody, PanelHeader, PageHeader } from "@/components/ui/panel"
import { Banner, EmptyState, ErrorState } from "@/components/ui/state"
import { isActionError } from "@/lib/action-result"
import { formatNumber, meta } from "@/lib/format"
import { requireUser } from "@/server/auth/guards"
import { listApis } from "@/server/apis/service"
import { listRequestLogs, type LogRow } from "@/server/db/queries/logs"
import { listKeys } from "@/server/keys/service"
import { logsHref, parseLogQuery, type SearchParamsValue } from "./filter-params"
import { LogFilterForm } from "./log-filter-form"
import { LogTable, type KeyInfo } from "./log-table"

export const metadata: Metadata = {
  title: "Request log",
  description: "Every recorded call to your endpoints, filtered by the query itself so the view is a link.",
}

/*
 * Server-side filtering only. `parseLogQuery` validates the URL with the shared `logQuerySchema`
 * (`src/lib/schemas.ts:107`) and hands `listRequestLogs` (`src/server/db/queries/logs.ts:110`) a
 * `ListLogsFilter`, so the WHERE clause and the LIMIT/OFFSET run in Postgres. Nothing is sliced in
 * the browser: `/logs?status=failed&apiId=…&from=…&to=…&limit=…&offset=…` is the whole state of the
 * page, which is what makes it shareable and bookmarkable.
 *
 * A rejected parameter means NO log query at all. Silently dropping a mistyped `from` would show a
 * wider window than the user asked for, and an unlabelled wider window is the same lie as a
 * fabricated row, so the page reports the bad value and waits.
 */

/** `LOG_RETENTION_DAYS` default (`src/lib/env.ts:41`); the sweep is `pruneOldLogs`. */
const RETENTION_DEFAULT_DAYS = 90

type LogsRead =
  | { ok: true; rows: LogRow[]; total: number }
  | { ok: false; message: string }

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsValue>
}) {
  const user = await requireUser()
  const { values, filter, invalid, activeFilters } = parseLogQuery(await searchParams)

  const invalidEntries = Object.entries(invalid)
  const queryLogs = invalidEntries.length === 0

  // The endpoint and key reads feed the filter bar and the Key column, so they still run when the
  // log query is withheld — a corrupt URL should not cost the user the controls they need to fix it.
  const [logsRead, apisResult, keysResult] = await Promise.all([
    queryLogs
      ? listRequestLogs({ userId: user.id, ...filter })
          .then((paged) => ({ ok: true as const, rows: paged.rows, total: paged.total }))
          .catch(() => ({ ok: false as const, message: "The request-log query failed to run." }))
      : Promise.resolve<LogsRead | null>(null),
    listApis(user.id),
    listKeys(user.id),
  ])

  const apis = isActionError(apisResult) ? null : apisResult.data
  const keys = isActionError(keysResult) ? null : keysResult.data

  const keyInfo = new Map<string, KeyInfo>(
    (keys ?? []).map((key) => [key.id, { name: key.name, scopes: [...key.scopes] }])
  )

  // Disabled endpoints stay in the picker: their history is still in the log, and filtering it out
  // would hide rows the user can see.
  const endpointOptions = (apis ?? []).map((api) => ({
    value: api.id,
    label: api.enabled ? api.name : `${api.name} (disabled)`,
  }))

  const total = logsRead?.ok === true ? logsRead.total : 0
  const rows = logsRead?.ok === true ? logsRead.rows : []
  const totalPages = Math.max(1, Math.ceil(total / filter.perPage))
  const pastLastPage = logsRead?.ok === true && rows.length === 0 && total > 0

  const readErrors: Array<{ label: string; body: string; code?: string }> = []
  // A withheld query (`logsRead === null`) is not a read failure: the banner above explains it.
  if (logsRead !== null && !logsRead.ok) {
    readErrors.push({ label: "Request log", body: logsRead.message })
  }
  if (isActionError(apisResult)) {
    readErrors.push({
      label: "Endpoints",
      body: apisResult.error.message,
      code: apisResult.error.code,
    })
  }
  if (isActionError(keysResult)) {
    readErrors.push({
      label: "Key names",
      body: keysResult.error.message,
      code: keysResult.error.code,
    })
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="06 — Logs"
        title="Request log" titleAside="as it ran"
        description="One row per recorded call: the verb, the endpoint it hit, the status, how long it took and which key was used."
        action={
          <>
            <PillLink href="/analytics" variant="line" size="sm">
              Analytics
            </PillLink>
            <PillLink href="/playground" variant="line" size="sm">
              Send a test request
            </PillLink>
          </>
        }
      />

      {invalidEntries.length > 0 ? (
        <Banner
          tone="attention"
          title="No query was run — the URL has a value this page cannot trust"
          body={`Rejected: ${invalidEntries
            .map(([name, raw]) => `${name}=${raw}`)
            .join(", ")}. Fix or clear the marked control and apply again; until then the table is empty by choice, not because you have no traffic.`}
          action={
            <PillLink href="/logs" variant="line" size="sm">
              Open an unfiltered log
            </PillLink>
          }
        />
      ) : null}

      {readErrors.map((failure) => (
        <ErrorState
          key={failure.label}
          title={`${failure.label} could not be read`}
          body={failure.body}
          code={failure.code ?? null}
        />
      ))}

      <LogFilterForm
        values={values}
        endpointOptions={endpointOptions}
        endpointsReadable={apis !== null}
        activeFilters={activeFilters}
      />

      {logsRead === null ? (
        <Panel as="section">
          <PanelHeader
            title="Requests"
            description="Withheld: the filter values above were rejected, so no windowed query was issued."
          />
          <PanelBody>
            <p className="text-[13px] leading-[1.7] text-dust">
              Guessing which bounds you meant would change the row set without saying so. The
              controls above keep your other values, so correcting the rejected one and pressing
              Apply is the whole recovery.
            </p>
          </PanelBody>
        </Panel>
      ) : !logsRead.ok ? (
        <ErrorState
          title="The log query failed"
          body={logsRead.message}
          action={
            <PillLink href={logsHref(values, {})} variant="line" size="sm">
              Retry this query
            </PillLink>
          }
        />
      ) : total === 0 && activeFilters === 0 ? (
        <EmptyState
          title="No requests recorded yet"
          body="Nothing has called your endpoints, so there is no log to filter. Create a key, send one request from the playground, and this page will have a real row within a moment."
          action={
            <div className="flex flex-wrap gap-3">
              <PillLink href="/keys" variant="solid" size="md">
                Create a key
              </PillLink>
              <PillLink href="/playground" variant="line" size="md">
                Open the playground
              </PillLink>
            </div>
          }
        />
      ) : total === 0 ? (
        <EmptyState
          title={`No requests match these ${activeFilters === 1 ? "filter" : "filters"}`}
          body="This is a filter result, not an empty account: the same window without the filters may well hold rows. Widen the dates, or switch the result filter — success means a status below 400, failed means 400 and up."
          action={
            <div className="flex flex-wrap gap-3">
              <PillLink href={logsHref(values, { status: "all", apiId: "", method: "", from: "", to: "", offset: 0 })} variant="line" size="md">
                Clear the filters
              </PillLink>
              <PillLink href="/analytics" variant="line" size="md">
                See traffic instead
              </PillLink>
            </div>
          }
        />
      ) : pastLastPage ? (
        <EmptyState
          title={`Page ${filter.page} starts past the last row`}
          body={`${formatNumber(total)} ${total === 1 ? "row matches" : "rows match"} this query, which fills ${formatNumber(totalPages)} ${totalPages === 1 ? "page" : "pages"} at ${formatNumber(filter.perPage)} rows each. The offset in the URL was not produced by the links below the table.`}
          action={
            <PillLink href={logsHref(values, { offset: 0 })} variant="line" size="md">
              Back to page 1
            </PillLink>
          }
        />
      ) : (
        <LogTable
          rows={rows}
          total={total}
          values={values}
          page={filter.page}
          totalPages={totalPages}
          keyInfo={keyInfo}
          keysReadable={keys !== null}
        />
      )}

      <p className="text-[13px] leading-[1.7] text-dust">
        {meta(
          `Rows older than the retention window (${RETENTION_DEFAULT_DAYS} days by default) are swept by pruneOldLogs, so an empty range far in the past is expected.`,
          "Rows are append-only metadata: no request body, header, key or cell value is ever recorded.",
          "A row with no endpoint id is a call that did not resolve to one endpoint, not a missing name."
        )}
      </p>
    </div>
  )
}
