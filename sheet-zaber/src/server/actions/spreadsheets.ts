"use server"

/*
 * Spreadsheet mutations and the owner-scoped list read (`backend-api-contract.md` §2
 * "Spreadsheets (user)", §4.6, §4.7).
 *
 * Thin by rule: read the session, hand the input to `src/server/spreadsheets/service.ts`, return
 * its `ActionResult` unchanged. URL normalization, tab snapshots, the `google_not_connected` vs
 * `google_reauth_required` split, `not_found` for "absent or not yours" and zod validation of
 * `url` / `connectionId` / `tabTitle` / `headerRow` are ALL the service's (`service.ts:274`,
 * `:338`, `:375`, `:454`); none of them is re-implemented here, which is what `integration-status.md`
 * B10 asks of both lanes.
 *
 * Google is only ever reached through the caller's OWN connection: `buildSheetsDeps` resolves the
 * connection owner-scoped (`support.ts`), and the service's `spreadsheets.get` — not the pasted
 * link — is the permission boundary (`google-integration.md` §3).
 *
 * CACHE NOTE for the frontend: `revalidatePath` is deliberately absent (the layer is exactly
 * guard + delegate + return). A page that renders these lists server-side must revalidate after an
 * `ok` result, or keep its own wrapper — `(app)/spreadsheets/actions.ts` already does.
 */

import type { ActionResult } from "@/lib/action-result"
import {
  listSpreadsheetsForUser,
  previewTab,
  refreshSpreadsheetTabs,
  registerSpreadsheet,
  removeSpreadsheet,
  type Spreadsheet,
  type SpreadsheetTab,
  type TabPreview,
} from "@/server/spreadsheets/service"

import { buildSheetsDeps, userAction } from "./support"

/** §4.7 `registerSpreadsheet(input, userId)`: paste a link or a bare id, snapshot the tabs, upsert. */
export async function registerSpreadsheetAction(
  input: { url: string; connectionId?: string }
): Promise<ActionResult<Spreadsheet>> {
  return userAction((session) => registerSpreadsheet(input, session.id, buildSheetsDeps(session.id)))
}

/** §4.7 `refreshSpreadsheetTabs(id, userId, deps)`: re-read the snapshot; marks the row `inaccessible` on a 403/404. */
export async function refreshSpreadsheetTabsAction(
  id: string
): Promise<ActionResult<{ tabs: SpreadsheetTab[] }>> {
  return userAction((session) => refreshSpreadsheetTabs(id, session.id, buildSheetsDeps(session.id)))
}

/**
 * §4.7 `previewTab(input, userId, deps)`: detected headers + the first 10 records. Cell data stops
 * at that cap inside the service (`service.ts:79`), and `headerRow` rides in as text or a number —
 * the service's `z.coerce.number()` decides, so the reported field error stays the schema's wording.
 */
export async function previewSpreadsheetTabAction(input: {
  spreadsheetId: string
  tabTitle: string
  headerRow: number
}): Promise<ActionResult<TabPreview>> {
  return userAction((session) => previewTab(input, session.id, buildSheetsDeps(session.id)))
}

/** §4.7 `removeSpreadsheet(id, userId)`: owner-scoped delete; the DB cascades this user's APIs. */
export async function removeSpreadsheetAction(id: string): Promise<ActionResult<{ id: string }>> {
  return userAction((session) => removeSpreadsheet(id, session.id))
}

/**
 * `GET /api/internal/spreadsheets` as an action (`listSpreadsheetsForUser`). A pure read: no
 * `SheetsDeps`, no Google call, and the §4.6 payload has no `userId` — the projection lives in the
 * service, not here.
 */
export async function listSpreadsheetsAction(
  connectionId?: string | null
): Promise<ActionResult<Spreadsheet[]>> {
  return userAction((session) => listSpreadsheetsForUser(session.id, connectionId ?? null))
}
