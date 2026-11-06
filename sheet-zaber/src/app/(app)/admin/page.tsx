import type { Metadata } from "next"
import Link from "next/link"

import { KpiTileRow } from "@/components/charts/tick-gauge"
import type { KpiTileReading } from "@/components/charts/series"
import { Badge } from "@/components/ui/badge"
import { PageHeader, Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { Banner, EmptyState, ErrorState } from "@/components/ui/state"
import { Table, TableScroll, Td, Th, Tr, MonoCell } from "@/components/ui/table"
import { formatDateTime, formatNumber, formatPercent, shortId } from "@/lib/format"
import { requireOwner } from "@/server/auth/guards"
import { listAudit } from "@/server/db/queries/audit"
import { getPlatformStats } from "@/server/db/queries/platform-stats"
import {
  ELEVATED_ERROR_RATE_PERCENT,
  MIN_ERROR_RATE_SAMPLE,
  errorRatePercent,
  isElevatedErrorRate,
} from "../analytics/thresholds"
import { readAdminWindow } from "./platform-range"

export const metadata: Metadata = {
  title: "Admin · Platform",
  description: "Platform totals for the owner: accounts, connections, spreadsheets, endpoints, traffic.",
}

/*
 * The owner's platform tile. The read is `getPlatformStats()`
 * (`src/server/db/queries/platform-stats.ts:60`) — the same function `GET /api/internal/admin/analytics`
 * binds (`src/app/api/internal/admin/analytics/route.ts:52-62`), so this page and that route return the
 * identical `PlatformStats` and cannot drift.
 *
 * WHAT THE WINDOW ACTUALLY BINDS — and this is the whole reason the labels below are pedantic: the
 * route documents that `?from`/`?to` narrow `requests` and the error rate ONLY, because they are a
 * `WHERE created_at` over `api_request_logs`, while `users`, `google_connections`,
 * `registered_spreadsheets` and `api_configurations` are bare `count(*)` reads (`platform-stats.ts:67-95`).
 * So with no window every figure is since inception, and with a window the four entity counts are
 * STILL since inception. Saying "last 7 days" above an all-time count would be the lie this page exists
 * to avoid.
 *
 * Hue appears exactly once, on the error rate, with the numbers the app already publishes
 * (`src/app/(app)/analytics/thresholds.ts`: elevated at ≥25% and only over a ≥20-request sample), and
 * every coloured state carries its word in the chip too.
 */

const AUDIT_ROWS = 15

type SearchParams = Record<string, string | string[] | undefined>

export default async function AdminPlatformPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  await requireOwner()
  const window = readAdminWindow(await searchParams)

  const statsRead = await getPlatformStats(window.range).then(
    (stats) => ({ ok: true as const, stats }),
    () => ({ ok: false as const })
  )
  const auditRead = await listAudit({ limit: AUDIT_ROWS }).then(
    (rows) => ({ ok: true as const, rows }),
    () => ({ ok: false as const })
  )

  const ignored = [window.invalid.from, window.invalid.to].filter((v): v is string => v !== null)

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="A1 — Admin · Platform"
        title="Platform"
        description="Whole-table counts and the measured traffic behind them. Nothing here is estimated, sampled or seeded — and every figure says which window it covers, because three of them are all-time no matter what you type."
        action={
          <>
            <Badge variant="neutral">{window.label}</Badge>
            <Link href="/admin/users" className="pill pill-line min-h-10 px-4 text-[14px]">
              Users
            </Link>
            <Link href="/admin/invitations" className="pill pill-line min-h-10 px-4 text-[14px]">
              Invitations
            </Link>
          </>
        }
      />

      {ignored.length > 0 ? (
        <Banner
          tone="attention"
          title={`Ignored window value: ${ignored.join(", ")}`}
          body="A date this page could not read as a real UTC day was dropped rather than guessed at, exactly as the analytics route drops it. The traffic figures below therefore cover a wider window than you asked for — the badge in the header names the window that was actually used."
        />
      ) : null}

      <Panel as="section">
        <PanelHeader
          title="Traffic window"
          description="Applies to Requests and Error rate. The four entity counts above it are whole-table reads that a date cannot narrow — that is what the route does, not a choice made here."
        />
        <PanelBody>
          <form action="/admin" method="get" className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="admin-from" className="text-[14px] text-mist">
                From (UTC day, inclusive)
              </label>
              <input
                id="admin-from"
                name="from"
                type="date"
                defaultValue={window.raw.from ?? ""}
                className="field min-w-0 font-mono text-[14px]"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="admin-to" className="text-[14px] text-mist">
                To (UTC day, exclusive)
              </label>
              <input
                id="admin-to"
                name="to"
                type="date"
                defaultValue={window.raw.to ?? ""}
                className="field min-w-0 font-mono text-[14px]"
              />
            </div>
            <button type="submit" className="pill pill-solid">
              Apply window
            </button>
            <a href="/admin" className="pill pill-line">
              Since inception
            </a>
          </form>
          <p className="mt-3 font-mono text-[11px] leading-[1.6] text-dust">
            Both fields are optional. A date-only value means the whole UTC day and the second day is
            the first one NOT counted — the same rule{" "}
            <span className="text-mist">/api/internal/admin/analytics</span> applies.
          </p>
        </PanelBody>
      </Panel>

      {!statsRead.ok ? (
        <ErrorState
          title="The platform totals could not be read"
          body="One count query per table failed, so no figure is shown. A zero on this screen means the database counted nothing — it must never mean the read did not run."
          code="internal_error"
          action={
            <a href="/admin" className="pill pill-line min-h-10 px-4 text-[14px]">
              Try again
            </a>
          }
        />
      ) : (
        <PlatformTiles stats={statsRead.stats} windowLabel={window.label} bounded={window.bounded} />
      )}

      <Panel as="section">
        <PanelHeader
          title="Recent owner actions"
          description={`The newest rows in \`audit_logs\`, newest first, up to ${AUDIT_ROWS}. Written in the same transaction as the change each one describes, so an action listed here happened. Detail values are scrubbed before they are stored: a key named code, hash, token, secret or email is dropped and secret-shaped values become \`[redacted]\`, which is why an invitation batch records a count and never a code.`}
          action={
            <Link href="/admin/invitations" className="pill pill-line min-h-10 px-4 text-[14px]">
              Invitations
            </Link>
          }
        />

        {!auditRead.ok ? (
          <PanelBody>
            <ErrorState
              title="The audit trail could not be read"
              body="No action rows are shown. The platform totals above are unaffected — they come from a different query."
              code="internal_error"
            />
          </PanelBody>
        ) : auditRead.rows.length === 0 ? (
          <PanelBody>
            <EmptyState
              title="No owner actions recorded yet"
              body="`audit_logs` is empty, so nobody has disabled or promoted an account, minted or revoked a code, or bootstrapped this platform from a script. The first mutation on this console writes the first row here."
            />
          </PanelBody>
        ) : (
          <TableScroll label="Recent audit log rows">
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Action</Th>
                  <Th>Subject</Th>
                  <Th>Actor</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {auditRead.rows.map((row) => (
                  <Tr key={row.id} interactive>
                    <Td className="whitespace-nowrap text-dust">
                      {formatDateTime(row.createdAt.toISOString())}
                    </Td>
                    <Td>
                      <span className="font-mono text-[12px] text-paper">{row.action}</span>
                    </Td>
                    <Td>
                      {row.subjectType === null ? (
                        <span className="font-mono text-[12px] text-dust">—</span>
                      ) : (
                        <span className="flex flex-col gap-1">
                          <span className="text-[13px] text-mist">{row.subjectType}</span>
                          <MonoCell value={shortId(row.subjectId)} title={row.subjectId ?? undefined} />
                        </span>
                      )}
                    </Td>
                    <Td>
                      {row.actorId === null ? (
                        <span className="font-mono text-[12px] text-dust">no actor (system)</span>
                      ) : (
                        <MonoCell value={shortId(row.actorId)} title={row.actorId} />
                      )}
                    </Td>
                    <Td>
                      <span className="block max-w-[36ch] truncate font-mono text-[12px] text-dust">
                        {detailSummary(row.detail)}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <p className="max-w-[80ch] text-[13px] leading-[1.7] text-dust">
        Log retention is set with <span className="font-mono text-[12px]">LOG_RETENTION_DAYS</span>. Rate limits
        are set per endpoint on the Endpoints screen and per account on the Users screen.
      </p>
    </div>
  )
}

function PlatformTiles({
  stats,
  windowLabel,
  bounded,
}: {
  stats: Awaited<ReturnType<typeof getPlatformStats>>
  windowLabel: string
  bounded: boolean
}) {
  const disabled = stats.users - stats.activeUsers
  const rate = errorRatePercent(stats.requests, stats.failedRequests)
  const elevated = isElevatedErrorRate(stats.requests, stats.failedRequests)
  const allFailed = stats.requests > 0 && stats.failedRequests === stats.requests

  const trafficWindow = bounded ? windowLabel : "since inception"

  const tiles: KpiTileReading[] = [
    {
      caption: "Accounts",
      value: formatNumber(stats.users),
      detail: `${disabled} disabled · all time`,
      chip: "platform-wide",
    },
    {
      caption: "Active accounts",
      value: formatNumber(stats.activeUsers),
      detail: "status = 'active' — the only rows a session can open",
      chip: "all time",
    },
    {
      caption: "Google connections",
      value: formatNumber(stats.connections),
      detail: "one row per authorized account, refresh token stored encrypted",
      chip: "all time",
    },
    {
      caption: "Spreadsheets",
      value: formatNumber(stats.spreadsheets),
      detail: "registered workbooks across every account",
      chip: "all time",
    },
    {
      caption: "Endpoints",
      value: formatNumber(stats.apis),
      detail: "published tabs serving as REST APIs",
      chip: "all time",
    },
    {
      caption: `Requests · ${trafficWindow}`,
      value: formatNumber(stats.requests),
      detail: `${formatNumber(stats.failedRequests)} answered 4xx or 5xx`,
      chip: trafficWindow,
    },
    {
      caption: `Error rate · ${trafficWindow}`,
      value: rate === null ? "—" : formatPercent(rate),
      detail: elevated
        ? `${formatNumber(stats.failedRequests)} of ${formatNumber(stats.requests)} failed · elevated at ${ELEVATED_ERROR_RATE_PERCENT}% over a ${MIN_ERROR_RATE_SAMPLE}-request sample`
        : stats.requests === 0
          ? "no requests logged in this window — nothing to divide"
          : `${formatNumber(stats.failedRequests)} of ${formatNumber(stats.requests)} failed · below the ${ELEVATED_ERROR_RATE_PERCENT}% line${
              stats.requests < MIN_ERROR_RATE_SAMPLE
                ? ` · sample under ${MIN_ERROR_RATE_SAMPLE}, so the percentage is noise`
                : ""
            }`,
      chip: allFailed
        ? "every request failed"
        : elevated
          ? "elevated"
          : stats.requests === 0
            ? "no traffic"
            : stats.requests < MIN_ERROR_RATE_SAMPLE
              ? "too few to judge"
              : "within range",
      tone: allFailed ? "failed" : elevated ? "elevated" : "neutral",
    },
  ]

  return (
    <section aria-label="Platform totals" className="flex flex-col gap-3">
      <KpiTileRow tiles={tiles} solidIndex={0} />
      <p className="font-mono text-[11px] leading-[1.6] text-dust">
        The five platform-wide counts are whole-table reads; the two traffic figures follow the window
        named in their captions. A colour here is always paired with a word, and only the error rate is
        ever coloured at all.
      </p>
    </section>
  )
}

/**
 * `audit_logs.detail` is jsonb, so its shape is whatever the writing service passed after
 * scrubbing (`src/server/admin/audit.ts:57`). Scalars are printed as `key=value`; anything nested is
 * JSON-stringified and clipped rather than flattened into something that would read differently.
 */
function detailSummary(detail: unknown): string {
  if (detail === null || detail === undefined) return "—"
  if (typeof detail !== "object") return clip(String(detail))

  const parts: string[] = []
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    parts.push(`${key}=${clip(scalar(value))}`)
  }
  return parts.length === 0 ? "no detail recorded" : parts.join(" · ")
}

function scalar(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  try {
    return JSON.stringify(value) ?? "—"
  } catch {
    return "—"
  }
}

function clip(value: string): string {
  return value.length > 48 ? `${value.slice(0, 47)}…` : value
}
