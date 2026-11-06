"use server"

/*
 * The request-log and analytics READS the dashboard pages call
 * (`backend-api-contract.md` §2 "Logs & analytics (user: own; owner: all)", §4.6/§4.7).
 *
 * They exist here only because a client component (the log filter form, the window switch) needs a
 * refresh without a page navigation. No new SQL: each one is a delegate to
 * `src/server/logs/service.ts`, which takes the WHOLE `AuthenticatedUser` — deliberately, because
 * `scopeFor(user)` (`logs/service.ts:160`) derives owner-vs-self from the session's DB role, so a
 * `user_id` in a client-supplied query record can only ever NARROW an owner's view and is IGNORED
 * for a user. Passing the session instead of `session.id` is what keeps that rule intact, and it is
 * the one §4.7 exception to "the user id last".
 *
 * Raw query records are validated inside the service (`logsRequestSchema` / `overviewRequestSchema`)
 * before anything reaches the database, so a malformed `from`/`page` is `validation_failed`, never a
 * 500 — and never echoed back.
 *
 * NAMING NOTE (doc-vs-code, reported): §4.6 publishes `Overview`/`ApiUsageRow` living in
 * `src/server/logs/analytics.ts`; that file does not exist. The shipped aggregates are the
 * repository's `AnalyticsOverview`/`ApiAnalyticsRow`, and `src/server/logs/service.ts:19` documents
 * the divergence itself. This layer forwards what shipped rather than inventing the §4.6 shape.
 */

import type { ActionResult } from "@/lib/action-result"
import type { AnalyticsOverview, ApiAnalyticsRow } from "@/server/db/queries/logs"
import {
  listLogs,
  overview,
  usageByApi,
  type LogsPage,
} from "@/server/logs/service"

import { userAction } from "./support"

export async function listLogsAction(
  raw: Record<string, string | string[]>
): Promise<ActionResult<LogsPage>> {
  return userAction((session) => listLogs(session, raw))
}

export async function analyticsOverviewAction(
  raw: Record<string, string | string[]>
): Promise<ActionResult<AnalyticsOverview>> {
  return userAction((session) => overview(session, raw))
}

export async function analyticsUsageByApiAction(): Promise<ActionResult<ApiAnalyticsRow[]>> {
  return userAction((session) => usageByApi(session))
}
