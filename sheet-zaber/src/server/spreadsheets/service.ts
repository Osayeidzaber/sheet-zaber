import "server-only"

import { z } from "zod"

import { fail, internalError, ok, type ActionError, type ActionResult } from "@/lib/action-result"
import { apiConfigSchema, registerSpreadsheetSchema } from "@/lib/schemas"
import {
  findConnectionForUser,
  listConnections,
  markConnectionStatus,
  touchConnectionUsed,
} from "@/server/db/queries/google-connections"
import {
  deleteSpreadsheet,
  findSpreadsheet,
  listSpreadsheets,
  setSpreadsheetStatus,
  updateSpreadsheetTabs,
  upsertSpreadsheet,
  type RegisteredSpreadsheetRow,
  type RegisteredSpreadsheetStatus,
  type SpreadsheetTab,
} from "@/server/db/queries/spreadsheets"
import {
  fromGoogleError,
  googleActionError,
  GoogleApiError,
  isInaccessible,
  isReauthRequired,
} from "@/server/google/errors"
import type { SheetTab, SheetsClient } from "@/server/google/sheets"

/*
 * Owner-facing spreadsheet service (`backend-api-contract.md` §2, §4.6, §4.7).
 *
 * Session-scoped: every function takes the session `userId` and every lookup is owner-scoped,
 * so a foreign id reads as absent (`security.md` §3 item 4). It returns `ActionResult`, never
 * throws a Google error, and depends on `SheetsClient` (an interface) — never on `googleapis`.
 *
 * Registration/refresh make `spreadsheets.get` with the registering user's OWN connection:
 * that call, not the pasted URL, is the ownership/permission boundary (`google-integration.md` §3).
 */

/** `google_connections.status` values are owned by the query module; this is §4.6's payload name. */
export type SpreadsheetStatus = RegisteredSpreadsheetStatus
export type { SpreadsheetTab }

/** §4.6 payload — `userId` is omitted because every list is already session-scoped. */
export type Spreadsheet = {
  id: string
  connectionId: string
  googleSheetId: string
  title: string
  tabs: SpreadsheetTab[]
  status: SpreadsheetStatus
  createdAt: Date
  updatedAt: Date
}

/** §4.7 `previewTab`: at most `PREVIEW_BODY_ROWS` records — more cell data never leaves this file. */
export type TabPreview = {
  headers: string[]
  records: Record<string, string>[]
  truncated: boolean
}

/**
 * Token minting lives in `src/server/google/tokens.ts` (wave 3 wires it in). `forceRefresh`
 * means "ignore any cached access token": it is set on the single retry after a Google 401.
 */
export type GetAccessToken = (connectionId: string, forceRefresh?: boolean) => Promise<string>

export type SheetsDeps = {
  getAccessToken: GetAccessToken
  /** A client bound to one (token, workbook) pair — `createSheetsClient` in production. */
  client(accessToken: string, spreadsheetId: string): SheetsClient
}

const PREVIEW_BODY_ROWS = 10

const VALIDATION_URL = "Paste a Google Sheets link (docs.google.com/spreadsheets/d/…) or a spreadsheet id."

/* ---------------------------------------------------------------- spreadsheet URL parsing */

const SHEET_ID = /^[A-Za-z0-9_-]{10,120}$/

/**
 * The only hosts a pasted link may name. `docs.google.com` is the human URL;
 * `sheets.googleapis.com/v4/spreadsheets/<id>` is the REST form the docs/picker may paste.
 * Nothing is fetched from these hosts — only the id is extracted — and no other host is accepted,
 * so a link to an attacker's domain cannot register anything (`google-integration.md` §3).
 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["docs.google.com", "sheets.googleapis.com"])

function asId(candidate: string | undefined): string | undefined {
  return candidate !== undefined && SHEET_ID.test(candidate) ? candidate : undefined
}

/**
 * Normalize → `google_sheet_id` (§3 step 2): a bare id, `/spreadsheets/d/<id>/edit#gid=…`,
 * `/spreadsheets/u/<n>/d/<id>/…` (secondary account) and `/v4/spreadsheets/<id>`.
 * Query strings and hashes are dropped by `URL`, so a `#tid=`/`?usp=` suffix never pollutes the id.
 */
export function parseSpreadsheetId(input: string): string | undefined {
  const value = input.trim()
  const bare = asId(value)
  if (bare !== undefined) return bare

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) return undefined
  if (url.username !== "" || url.password !== "") return undefined

  const segments = url.pathname.split("/").filter((segment) => segment !== "")
  let index = 0
  if (url.hostname === "sheets.googleapis.com") {
    if (segments[0] === "v4") index = 1
    if (segments[index] !== "spreadsheets") return undefined
    return asId(segments[index + 1])
  }

  if (segments[0] !== "spreadsheets") return undefined
  index = 1
  if (segments[index] === "u" && /^\d+$/.test(segments[index + 1] ?? "")) index += 2
  if (segments[index] !== "d") return undefined
  return asId(segments[index + 1])
}

/* ---------------------------------------------------------------- payload projection */

function toPayload(row: RegisteredSpreadsheetRow): Spreadsheet {
  return {
    id: row.id,
    connectionId: row.connectionId,
    googleSheetId: row.googleSheetId,
    title: row.title,
    tabs: row.tabs,
    status: row.status === "inaccessible" ? "inaccessible" : "active",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * The §4.6 `Spreadsheet[]` list for one session user (`GET /api/internal/spreadsheets`).
 * A pure read — no `SheetsDeps`, no Google call — so it belongs beside the projection it must
 * share; a route that listed rows itself would have to duplicate `toPayload` and could drift
 * the `userId`-drop that keeps one user's list from naming its owner.
 */
export async function listSpreadsheetsForUser(
  userId: string,
  connectionId?: string | null
): Promise<ActionResult<Spreadsheet[]>> {
  try {
    const rows = (await listSpreadsheets(userId)).map(toPayload)
    return ok(connectionId ? rows.filter((row) => row.connectionId === connectionId) : rows)
  } catch {
    return internalError()
  }
}

/**
 * Snapshot → §4.6 `SpreadsheetTab`, whose `id` is Google's numeric gid. A non-numeric gid is a
 * contract break, not something to store: the caller turns it into `internal_error`.
 */function snapshotTabs(tabs: SheetTab[]): SpreadsheetTab[] | undefined {
  const snapshot: SpreadsheetTab[] = []
  for (const tab of tabs) {
    if (!/^\d+$/.test(tab.id)) return undefined
    snapshot.push({ id: Number(tab.id), title: tab.title, rows: tab.rows, columns: tab.columns })
  }
  return snapshot
}

function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join(".")
    if (key !== "" && fields[key] === undefined) fields[key] = issue.message
  }
  return fields
}

/** §4.4: `fields` rides only on `validation_failed`, and only when zod has a path to point at. */
function validationFail(message: string, error: z.ZodError): ActionError {
  const fields = zodFields(error)
  return Object.keys(fields).length > 0
    ? fail("validation_failed", message, "validation", fields)
    : fail("validation_failed", message, "validation")
}

const NOT_FOUND: ActionError = fail("not_found", "No spreadsheet was found for that id.", "not_found")
const REAUTH: ActionError = fail(
  "google_reauth_required",
  "Google needs you to reconnect your account before Sheet Zaber can read that spreadsheet.",
  "google"
)

/* ---------------------------------------------------------------- Google call plumbing */

type GoogleOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GoogleApiError }

/**
 * One logical Google call: mint token → bump usage → run, and on 401 force exactly ONE refresh
 * and exactly ONE retry (`google-integration.md` §2). A second 401 — or a token we cannot mint
 * at all (revoked grant, decryption failure) — flips the connection to `reauth_required`, which
 * is what drives the dashboard banner. There is no third attempt and no loop.
 */
async function callGoogle<T>(input: {
  deps: SheetsDeps
  connectionId: string
  spreadsheetId: string
  run(client: SheetsClient): Promise<T>
}): Promise<GoogleOutcome<T>> {
  const { deps, connectionId, spreadsheetId, run } = input

  const first = await deps.getAccessToken(connectionId).catch(() => undefined)
  if (first === undefined) return reauthOutcome(connectionId)

  // Usage, not a change: one bump per call, so a retry does not double-count.
  await touchConnectionUsed(connectionId)
  try {
    return { ok: true, value: await run(deps.client(first, spreadsheetId)) }
  } catch (error) {
    if (!isReauthRequired(error)) return failure(error)
  }

  const second = await deps.getAccessToken(connectionId, true).catch(() => undefined)
  if (second === undefined) return reauthOutcome(connectionId)
  try {
    return { ok: true, value: await run(deps.client(second, spreadsheetId)) }
  } catch (error) {
    if (isReauthRequired(error)) return reauthOutcome(connectionId)
    return failure(error)
  }
}

async function reauthOutcome(connectionId: string): Promise<GoogleOutcome<never>> {
  await markConnectionStatus(connectionId, "reauth_required")
  return {
    ok: false,
    error: new GoogleApiError(401, "reauth", "Google rejected the access token after one refresh"),
  }
}

function failure(error: unknown): GoogleOutcome<never> {
  return { ok: false, error: fromGoogleError(error) }
}

/** `callGoogle` failures never leak an SDK error upward; they become the §4.4 envelope. */
function googleFail(outcome: { ok: false; error: GoogleApiError }): ActionError {
  return googleActionError(outcome.error)
}

/* ---------------------------------------------------------------- actions */

const registerInputSchema = z.object({
  url: registerSpreadsheetSchema.shape.url,
  // Optional: a user with a single connection does not have to pick one.
  connectionId: registerSpreadsheetSchema.shape.connectionId.optional(),
})

/**
 * §3 end to end: normalize the link → `spreadsheets.get` with the user's connection (the
 * permission check) → snapshot tabs → upsert. A 403/404 writes NO row; a 429 writes no row either.
 * `(user_id, google_sheet_id)` is unique, so re-registering an already-registered sheet updates
 * that row in place and returns it — idempotent by design, never a duplicate.
 */
export async function registerSpreadsheet(
  input: { url: string; connectionId?: string },
  userId: string,
  deps: SheetsDeps
): Promise<ActionResult<Spreadsheet>> {
  const parsed = registerInputSchema.safeParse(input)
  if (!parsed.success) {
    return validationFail("Check the spreadsheet link and try again.", parsed.error)
  }

  const googleSheetId = parseSpreadsheetId(parsed.data.url)
  if (googleSheetId === undefined) {
    return fail("validation_failed", "Check the spreadsheet link and try again.", "validation", {
      url: VALIDATION_URL,
    })
  }

  const connection = await findConnectionForUser(userId, parsed.data.connectionId)
  if (connection === undefined) return noConnection(userId, parsed.data.connectionId)

  const outcome = await callGoogle({
    deps,
    connectionId: connection.id,
    spreadsheetId: googleSheetId,
    run: (client) => client.getSpreadsheetMeta(googleSheetId),
  })
  if (!outcome.ok) return googleFail(outcome)

  const tabs = snapshotTabs(outcome.value.tabs)
  if (tabs === undefined) return internalError()

  const row = await upsertSpreadsheet({
    userId,
    connectionId: connection.id,
    googleSheetId,
    title: outcome.value.title,
    tabs,
  })
  return ok(toPayload(row))
}

/**
 * No usable connection. A `connectionId` that resolves to nothing is reported as `not_found`
 * (same shape as "not yours"); with no id given, "never connected" and "grant is dead" are
 * distinguishable, so the dashboard can show Connect versus the reconnect banner.
 */
async function noConnection(userId: string, connectionId: string | undefined): Promise<ActionError> {
  if (connectionId !== undefined) return NOT_FOUND
  const rows = await listConnections(userId)
  if (rows.length === 0) {
    return fail(
      "google_not_connected",
      "Connect your Google account before registering a spreadsheet.",
      "auth"
    )
  }
  return REAUTH
}

/**
 * "Refresh tabs" (§3 step 4 re-run). If Google now answers 403/404 the row is kept and marked
 * `inaccessible` — the user still owns it and has to see it to fix it — and the action fails
 * with `google_sheet_inaccessible`.
 */
export async function refreshSpreadsheetTabs(
  id: string,
  userId: string,
  deps: SheetsDeps
): Promise<ActionResult<{ tabs: SpreadsheetTab[] }>> {
  const row = await findSpreadsheet(userId, id)
  if (row === undefined) return NOT_FOUND

  const outcome = await callGoogle({
    deps,
    connectionId: row.connectionId,
    spreadsheetId: row.googleSheetId,
    run: (client) => client.getSpreadsheetMeta(row.googleSheetId),
  })
  if (!outcome.ok) {
    if (isInaccessible(outcome.error)) await setSpreadsheetStatus(row.id, "inaccessible")
    return googleFail(outcome)
  }

  const tabs = snapshotTabs(outcome.value.tabs)
  if (tabs === undefined) return internalError()

  await updateSpreadsheetTabs(row.id, tabs, outcome.value.title)
  return ok({ tabs })
}

const previewInputSchema = z.object({
  spreadsheetId: apiConfigSchema.shape.spreadsheetId,
  tabTitle: apiConfigSchema.shape.tabTitle,
  headerRow: apiConfigSchema.shape.headerRow,
})

/**
 * Header + first 10 records for the registration dialog (§2 "previewTab").
 * The header row is read at `headerRow` and the body band starts directly below it; one extra
 * row is read only to answer `truncated` and is never returned.
 */
export async function previewTab(
  input: { spreadsheetId: string; tabTitle: string; headerRow: number },
  userId: string,
  deps: SheetsDeps
): Promise<ActionResult<TabPreview>> {
  const parsed = previewInputSchema.safeParse(input)
  if (!parsed.success) {
    return validationFail("Check the tab name and header row.", parsed.error)
  }
  const { spreadsheetId, tabTitle, headerRow } = parsed.data

  const row = await findSpreadsheet(userId, spreadsheetId)
  if (row === undefined) return NOT_FOUND

  const tab = row.tabs.find((candidate) => candidate.title === tabTitle)
  if (tab === undefined) {
    return fail(
      "tab_not_found",
      "That tab is not in this spreadsheet's snapshot. Refresh the tabs and try again.",
      "validation",
      { tabTitle: `No tab named "${tabTitle}" in this snapshot.` }
    )
  }

  const call = {
    deps,
    connectionId: row.connectionId,
    spreadsheetId: row.googleSheetId,
  }

  const header = await callGoogle({
    ...call,
    run: (client) => client.getValues(tabRowRange(tabTitle, headerRow, headerRow)),
  })
  if (!header.ok) return googleFail(header)

  const body = await callGoogle({
    ...call,
    run: (client) => client.getValues(tabRowRange(tabTitle, headerRow + 1, headerRow + 1 + PREVIEW_BODY_ROWS)),
  })
  if (!body.ok) return googleFail(body)

  const headers = headerCellKeys(header.value.values[0] ?? [])
  const records = body.value.values.slice(0, PREVIEW_BODY_ROWS).map((cells) => recordFrom(headers, cells))

  return ok({ headers, records, truncated: body.value.values.length > PREVIEW_BODY_ROWS })
}

/**
 * A1 row bands (`'My Tab'!2:4`) rather than cell boxes: a whole row needs no column count, so
 * nothing here duplicates the client's A1 grammar. Titles are quoted the way Google and the
 * stub read them (spaces quoted, `'` doubled).
 */
function tabRowRange(tabTitle: string, fromRow: number, toRow: number): string {
  return `${quotedTabName(tabTitle)}!${fromRow}:${toRow}`
}

function quotedTabName(tabTitle: string): string {
  return /[^A-Za-z0-9_]/.test(tabTitle) ? `'${tabTitle.replace(/'/g, "''")}'` : tabTitle
}

/** Header cells are the object keys; an empty cell becomes `column_N` (architecture.md §3). */
function headerCellKeys(header: string[]): string[] {
  return header.map((cell, index) => (cell.trim() === "" ? `column_${index + 1}` : cell))
}

function recordFrom(headers: string[], cells: string[]): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((key, index) => {
    record[key] = cells[index] ?? ""
  })
  return record
}

/**
 * Delete the owner's row. `api_configurations.spreadsheet_id` is `onDelete: "cascade"`, so the
 * user's APIs (and their keys' traffic) go with it — the payload's `id` is what the dashboard
 * removes from its list.
 */
export async function removeSpreadsheet(
  id: string,
  userId: string
): Promise<ActionResult<{ id: string }>> {
  const row = await findSpreadsheet(userId, id)
  if (row === undefined) return NOT_FOUND

  await deleteSpreadsheet(userId, id)
  return ok({ id: row.id })
}
