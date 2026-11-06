import "server-only"

import { and, eq } from "drizzle-orm"

import { fail, internalError, type ActionError, type ErrorCategory } from "@/lib/action-result"
import type { SnippetMethod } from "@/lib/snippets"
import { resolveEngineApi, type EngineApi } from "@/server/apis/service"
import { db } from "@/server/db/client"
import { findConnectionForUser, markConnectionStatus } from "@/server/db/queries/google-connections"
import { insertRequestLog } from "@/server/db/queries/logs"
import type { ApiKeyScope } from "@/server/db/queries/api-keys"
import { findUserById } from "@/server/db/queries/users"
import { apiKeys } from "@/server/db/schema"
import { createSheetsClient, type SheetTab, type SheetsClient } from "@/server/google/sheets"
import { evictAccessToken, getAccessToken } from "@/server/google/tokens"
import { authenticateKey, authorizeKeyCall, markKeyUsed, type EngineKey } from "@/server/keys/service"

import {
  apiNotFound,
  bodyTooLarge,
  EngineNotConnected,
  EngineRejection,
  GOOGLE_RULES,
  headerMismatch,
  invalidJson,
  INVALID_KEY,
  invalidRange,
  JSON_CONTENT_TYPE,
  missingKey,
  primaryKeyError,
  rateLimited,
  readRequiresPrimaryKey,
  reject,
  restrictedMessage,
  retryAfterFromError,
  tabNotFound,
  toGoogleError,
  validationFailed,
  writeRequiresPrimaryKey,
} from "./errors"
import { consumeEngineRate, engineHourLimit, rateLimitHeaders, type RateVerdict } from "./ratelimit"
import {
  bandCells,
  bandHeaders,
  buildTable,
  columnRuns,
  findRowsByPrimaryKey,
  parseBand,
  recordFromCells,
  resolveBand,
  rowSpanRef,
  stringifyCell,
  tabRef,
} from "./records"
import { applyListQuery, parseListQuery, projectRecord, type ListQuery } from "./query"
import type {
  EngineAuth,
  EngineCall,
  EngineDeps,
  EngineMeta,
  EngineOutcome,
  EngineRow,
  EngineTable,
} from "./types"

/*
 * The public data engine (`backend-api-contract.md` §1), ONE entry point: `handleEngineCall`.
 *
 * It owns the whole lifecycle — authenticate → resolve API → authorize → rate limit → read/write
 * Google → build the §1.2 envelope → log → bump `last_used_at` — and it is called IN PROCESS by both
 * surfaces: the `/api/v1/**` route (the Bearer arm) and the playground (§4.8, the `keyId` arm, which
 * holds a key ROW id plus the session owner because `api_keys` stores only a hash).
 *
 * Four rules this file keeps:
 *   1. it never throws — anything unexpected is a 500 `internal_error` whose cause is written to the
 *      server log and never echoed to the client (§1.2);
 *   2. every request is logged exactly once, including 401/403/404, with no key, header, body or cell
 *      value in it (§1.5);
 *   3. `gridRow` is internal only (§1.5): a record is addressed by its primary-key VALUE, so no
 *      response body can contain a row number;
 *   4. the envelope is serialised HERE and nowhere else (§4.8), so the route and the playground
 *      forward identical bytes and neither can re-format an error the other would have to reproduce.
 *
 * The wire codes and their statuses are in `./errors`, the grid grammar in `./records`, the query
 * parameters in `./query`, the windows in `./ratelimit`. What is left is the ORDER the contract is
 * enforced in, and the statuses are carried explicitly rather than derived from the error category,
 * because §1.2 pins 409/413/422 — statuses `CATEGORY_STATUS` has no category for.
 */

/* ---------------------------------------------------------------- constants */

/** §1.3 Create: "one object or an array of objects (≤500 per request)". */
const MAX_CREATE_RECORDS = 500
/** §1.2 413 `body_too_large` (>1 MB), checked on the RAW text before `JSON.parse`. */
const MAX_BODY_BYTES = 1_000_000

/** The key shape §1.1 pins: `sz_live_` + 32 lowercase hex. Anything else is `invalid_key`. */
const API_KEY_TOKEN = /^sz_live_[0-9a-f]{32}$/

const encoder = new TextEncoder()

/* ---------------------------------------------------------------- internal shapes */

/** What one operation produced, plus the status its success answers with. */
type OpOutcome = {
  data: unknown
  count: number
  limit: number | null
  offset: number
  status?: number
}

/** An answer before it is serialised: `handleEngineCall` turns one into `EngineOutcome`. */
type WireResult = {
  status: number
  envelope: unknown
  headers: Record<string, string>
}

/** Per-request bookkeeping for the log line and `markKeyUsed`. */
type EngineTrace = {
  keyId: string | null
  userId: string | null
  apiId: string | null
  /** True once `authorizeKeyCall` AND the rate window passed — only then may `last_used_at` move. */
  authorized: boolean
  /** The failing envelope's category, so `api_request_logs.error_category` says what broke. */
  errorCategory: ErrorCategory | null
  /** The same measured duration the success envelope publishes as `meta.duration_ms` (§4.8). */
  durationMs: number
}

/**
 * The path grammar (§1.3), resolved once. `[]`, `/search` without a term, a bare `/range` and
 * anything deeper are all `null`, which the caller answers with 404 `api_not_found` — the same code
 * as "no such API", so probing the grammar learns nothing about what exists.
 */
type EngineShape =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "search" }
  | { kind: "range"; a1: string }
  | { kind: "record"; record: string }

/**
 * The one operation `dispatch` performs, fully resolved BEFORE any Google call: the grammar and the
 * primary-key gate are both answered from the database row alone, so a 404/403 costs no Google quota
 * and no `{record}` value is ever sent to Google to discover it cannot be addressed.
 */
type EngineOp = {
  method: SnippetMethod
  pathSegments: string[]
  searchParams: URLSearchParams
  bodyText: string | null
  shape: EngineShape
  /** Empty exactly when the call is not a `{record}` call; the PK gate ran before this was built. */
  pkColumn: string
}

/** A resolved `{record}` call: the operation plus the one row its primary-key value matched. */
type RecordTarget = { op: EngineOp; pkColumn: string; row: EngineRow }

/** The two fields a body reader needs, so readers take the op and cannot drift from its guards. */
type BodySource = Pick<EngineOp, "method" | "bodyText">

/* ---------------------------------------------------------------- 1. authentication (§1.1) */

/**
 * §1.1's two arms, one blind shape.
 *
 * `missing_key` is reserved for a caller that sent no credential at all: the route has already
 * stripped the `Bearer` scheme, and a header that is not a Bearer scheme is not a credential either
 * (hence `""`), which types.ts documents as `missing_key`. Everything else that fails is
 * `invalid_key`, and the reasons — revoked, expired, never existed, and "not yours" on the `keyId`
 * arm — are byte-identical, because the route must not be an existence oracle (§1.1, `security.md`
 * §3 item 2).
 */
async function authenticate(auth: EngineAuth, trace: EngineTrace): Promise<EngineKey> {
  if (auth.kind === "keyId") {
    // §4.8's playground path: a row id plus the session owner, matched in ONE statement, so a
    // foreign id cannot be told apart from a missing one and a plaintext key never existed.
    const key = await findKeyOwnedById(auth.apiKeyId, auth.ownerId)
    if (key === null) reject(401, INVALID_KEY)
    trace.keyId = key.id
    trace.userId = key.userId
    return key
  }

  const token = auth.token.trim()
  if (token === "") reject(401, missingKey())
  if (!API_KEY_TOKEN.test(token)) reject(401, INVALID_KEY)

  const key = await authenticateKey(token)
  if (key === null) reject(401, INVALID_KEY)
  trace.keyId = key.id
  trace.userId = key.userId
  return key
}

/**
 * Key row by id, owned by `ownerId`, for the playground's `keyId` arm (§4.8).
 *
 * `keys/service.ts` exports no by-id lookup (`findOwnedKey` there is private, `authenticateKey` takes
 * the plaintext), so this mirrors BOTH of its guarantees: the column list is `findOwnedKey`'s —
 * `key_hash` is absent by construction, not filtered — and the revoked/expired blindness is
 * `findApiKeyByHash`'s, so a dead key answers with the same 401 as a missing one. Ownership is a
 * WHERE term rather than a comparison after the read, which is what makes "not yours" and "no such
 * row" indistinguishable; `authorizeKeyCall` still guards the API's own owner.
 */
async function findKeyOwnedById(apiKeyId: string, ownerId: string): Promise<EngineKey | null> {
  if (apiKeyId.trim() === "" || ownerId.trim() === "") return null

  const [row] = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      name: apiKeys.name,
      scopes: apiKeys.scopes,
      allowedApiIds: apiKeys.allowedApiIds,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.userId, ownerId)))
    .limit(1)

  if (row === undefined) return null
  if (row.revokedAt !== null) return null
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) return null

  return {
    id: row.id,
    userId: row.userId,
    scopes: row.scopes as ApiKeyScope[],
    allowedApiIds: row.allowedApiIds as string[] | null,
    name: row.name,
  }
}

/* ---------------------------------------------------------------- 2. path grammar (§1.3) */

/**
 * RESERVED WORDS: `/search` and `/range` are matched before the `{record}` slot, so an API whose
 * primary key literally holds the value `search` is unreachable by id. The grammar is fixed and does
 * not fall back — the same trade-off as SheetDB, and why the docs send that case to list+filter.
 */
function shapeOf(pathSegments: string[], method: SnippetMethod): EngineShape | null {
  const rest = pathSegments.slice(1)

  if (rest.length === 0) {
    if (method === "GET") return { kind: "list" }
    if (method === "POST") return { kind: "create" }
    return null
  }

  if (rest.length === 1) {
    if (rest[0] === "search") return method === "GET" ? { kind: "search" } : null
    // `/range` with no A1 part behind it names nothing; it is 404, not 400 `invalid_range`.
    if (rest[0] === "range") return null
    return recordMethod(method) ? { kind: "record", record: rest[0] } : null
  }

  if (rest[0] === "range") {
    // An A1 band can itself contain no `/`, but a caller may split it across segments anyway
    // (`/range/A1/D20`); the remainder is rejoined so the grammar, not the transport, decides.
    return method === "GET" ? { kind: "range", a1: rest.slice(1).join("/") } : null
  }

  return null
}

function recordMethod(method: SnippetMethod): boolean {
  return method === "GET" || method === "PATCH" || method === "PUT" || method === "DELETE"
}

/* ---------------------------------------------------------------- 3. Google plumbing (§1.5) */

/** Raises the dashboard's reconnect banner; a database failure must not mask the Google answer. */
async function flagReauth(connectionId: string): Promise<void> {
  evictAccessToken(connectionId)
  try {
    await markConnectionStatus(connectionId, "reauth_required")
  } catch (error) {
    console.error("[engine] could not flag reauth", error)
  }
}

/**
 * One logical Google call with §1.5's single retry: run the verb, and on a 401-class failure evict the
 * cached access token, force one refresh (by asking for the client again — the default `sheetsFor`
 * mints a fresh token because the cache is now empty) and retry the SAME verb exactly once. A second
 * failure propagates; there is no loop and no third attempt.
 */
async function callGoogle<T>(
  deps: EngineDeps,
  api: EngineApi,
  run: (sheet: SheetsClient) => Promise<T>
): Promise<T> {
  const sheet = await deps.sheetsFor(api)
  try {
    return await run(sheet)
  } catch (error) {
    const first = toGoogleError(error)
    if (first.kind !== "reauth") throw first

    evictAccessToken(api.connectionId)
    const retry = await deps.sheetsFor(api)
    try {
      return await run(retry)
    } catch (retryError) {
      const second = toGoogleError(retryError)
      if (second.kind === "reauth") await flagReauth(api.connectionId)
      throw second
    }
  }
}

/**
 * The default seam: the API owner's connection → a minted access token → a client bound to that
 * workbook. Token material never leaves this function.
 *
 * A missing, `disconnected` or `reauth_required` connection is the documented 503
 * `google_not_connected` (§4.4 keeps it distinct from `google_reauth_required` because the user's fix
 * differs); minting a token that `tokens.ts` cannot produce surfaces as a `GoogleAuthError`, which
 * `toGoogleError` puts on the one-retry path.
 */
export async function defaultSheetsFor(api: EngineApi): Promise<SheetsClient> {
  const connection = await findConnectionForUser(api.userId, api.connectionId)
  if (connection === undefined || connection.status !== "connected") throw new EngineNotConnected()

  const accessToken = await getAccessToken(connection)
  return createSheetsClient(accessToken, api.googleSheetId)
}

/* ---------------------------------------------------------------- 4. reading the table */

type Grid = { values: string[][]; tab: SheetTab }

/**
 * One `getValues("<Tab>")` whole-tab read (§1.3), plus the one `spreadsheets.get` that says which tabs
 * exist and how big they are. The metadata call keeps the engine honest about two things the grid
 * cannot tell it: the tab's declared size (a range's bounds) and Google's numeric gid (`deleteRow`'s
 * first argument, per `sheets.ts`'s interface).
 */
async function readGrid(deps: EngineDeps, api: EngineApi): Promise<Grid> {
  const meta = await callGoogle(deps, api, (sheet) => sheet.getSpreadsheetMeta(api.googleSheetId))
  const tab = meta.tabs.find((candidate) => candidate.title === api.tabTitle)
  if (tab === undefined) reject(422, tabNotFound())

  const result = await callGoogle(deps, api, (sheet) => sheet.getValues(tabRef(api.tabTitle)))
  return { values: result.values, tab }
}

function tableOf(grid: Grid, api: EngineApi): EngineTable {
  return buildTable(grid.values, api.headerRow, grid.tab)
}

/* Column allowlist. Filters, search and sort run on this view, so a hidden value cannot be inferred. */
function visibleHeaders(table: EngineTable, api: EngineApi): string[] {
  const exposed = api.exposedColumns
  return exposed ? table.headers.filter((key) => exposed.includes(key)) : table.headers
}

function visibleRecord<T extends Record<string, string>>(record: T, table: EngineTable, api: EngineApi): Record<string, string> {
  if (!api.exposedColumns) return record
  return Object.fromEntries(visibleHeaders(table, api).map((key) => [key, record[key] ?? ""]))
}

function visibleTable(table: EngineTable, api: EngineApi): EngineTable {
  if (!api.exposedColumns) return table
  return {
    ...table,
    headers: visibleHeaders(table, api),
    rows: table.rows.map((row) => ({ ...row, record: visibleRecord(row.record, table, api) })),
  }
}

/* ---------------------------------------------------------------- 5. request bodies */

function bodyBytes(text: string | null): number | null {
  return text === null ? null : encoder.encode(text).length
}

/** §1.2's 413: the size is measured on the raw text, BEFORE parsing, so an oversized body never parses. */
function readBodyText(source: BodySource): string {
  const text = source.bodyText
  if (text === null || text.trim() === "") {
    reject(400, invalidJson("A JSON body is required for this operation."))
  }
  if (encoder.encode(text).length > MAX_BODY_BYTES) reject(413, bodyTooLarge())
  return text
}

function parseJsonBody(source: BodySource): unknown {
  const text = readBodyText(source)
  try {
    return JSON.parse(text)
  } catch {
    reject(400, invalidJson("The request body is not valid JSON."))
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** POST: one object, or an array of ≤500 objects; every other shape names `records`. */
function parseCreateBody(source: BodySource): Record<string, unknown>[] {
  const parsed = parseJsonBody(source)
  const records = Array.isArray(parsed) ? parsed : [parsed]

  if (Array.isArray(parsed) && records.length === 0) {
    reject(400, validationFailed("An empty array creates no records.", { records: "Send at least one record." }))
  }
  if (records.length > MAX_CREATE_RECORDS) {
    reject(
      400,
      validationFailed("The request body holds too many records.", {
        records: `A create request sends at most ${MAX_CREATE_RECORDS} records.`,
      })
    )
  }
  if (!records.every(isPlainObject)) {
    reject(
      400,
      validationFailed("The request body must be a JSON object or an array of JSON objects.", {
        records: "Every record must be a JSON object.",
      })
    )
  }
  if (records.some((record) => Object.keys(record).length === 0)) {
    reject(
      400,
      validationFailed("Every record must set at least one column.", {
        records: "An object with no keys writes no cells.",
      })
    )
  }

  // `isPlainObject` above rejected anything else, so the filter is a narrowing, not a second rule.
  return records.filter(isPlainObject)
}

/** PATCH/PUT: exactly one object. */
function parseWriteBody(source: BodySource): Record<string, unknown> {
  const parsed = parseJsonBody(source)
  if (!isPlainObject(parsed)) {
    reject(
      400,
      validationFailed("The request body must be a single JSON object.", {
        body:
          source.method === "PUT"
            ? "PUT replaces one record, given as a JSON object."
            : "PATCH updates one record, given as a JSON object.",
      })
    )
  }
  return parsed
}

/* ---------------------------------------------------------------- 6. write column checks */

function unknownColumns(headers: string[], record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => !headers.includes(key))
}

/**
 * Writes reject unknown keys with 422, naming the offenders SORTED and DE-DUPLICATED (an array body can
 * repeat a key across records) plus the header row's own column names. `column_N` placeholders are real
 * headers, so writing to an unnamed column is allowed — the header row is the contract.
 */
function requireKnownColumns(headers: string[], offenders: string[], method: SnippetMethod): void {
  if (headers.length === 0) {
    reject(422, headerMismatch("This API's header row has no named columns, so no record can be written.", [], []))
  }
  if (offenders.length === 0) return
  const sorted = [...new Set(offenders)].sort()
  reject(
    422,
    headerMismatch(
      `${method} sent ${sorted.length} unknown column(s): ${sorted.join(", ")}. This API's columns are: ${headers.join(", ")}.`,
      sorted,
      headers
    )
  )
}

/** POST scans EVERY record before anything is written, so one 422 names all offenders at once. */
function requireCreateColumns(headers: string[], records: Record<string, unknown>[], method: SnippetMethod): void {
  requireKnownColumns(
    headers,
    records.flatMap((record) => unknownColumns(headers, record)),
    method
  )
}

/* ---------------------------------------------------------------- 7. operations */

function listQueryFor(op: EngineOp, table: EngineTable): ListQuery {
  const query = parseListQuery(op.searchParams, table.headers)
  if ("error" in query) reject(400, query)
  return query
}

/** `GET /{api}` and `GET /{api}/search` differ only in whether `q` is mandatory (§1.3). */
function listRecords(op: EngineOp, table: EngineTable, isSearch: boolean): OpOutcome {
  const query = listQueryFor(op, table)
  if (isSearch && query.q === null) {
    reject(400, validationFailed("A search needs a term.", { q: "Send a non-empty q parameter." }))
  }

  const rows = applyListQuery(table, query)
  return {
    data: rows.map((row) => projectRecord(row.record, query.fields)),
    count: rows.length,
    limit: query.limit,
    offset: query.offset,
  }
}

/**
 * §1.3: `GET /{api}/{record}` answers the resolved record. The query parameters are still parsed, so a
 * bogus `fields` or an unknown filter names itself with a 400 instead of silently returning a whole
 * record, and `fields` is applied to the one record that comes back.
 */
function readRecord(op: EngineOp, table: EngineTable, row: EngineRow): OpOutcome {
  const query = listQueryFor(op, table)
  return { data: projectRecord(row.record, query.fields), count: 1, limit: null, offset: 0 }
}

/**
 * `GET /{api}/range/{A1}`, answered from the SAME whole-tab read as the list: a range is a window on
 * the table the engine already loaded, so it never costs a second Google call.
 *
 * A `Sheet!` prefix must equal the configured tab title, and the band must fit the tab's DECLARED size
 * (`SheetTab.rows`/`columns`) — the metadata read is what makes that check possible. An open-ended band
 * (`A1:C`, `B2:`, `5:8`) is allowed and filled to the tab's edge by `resolveBand`.
 */
function rangeRecords(op: EngineOp, grid: Grid, api: EngineApi): OpOutcome {
  const a1 = op.shape.kind === "range" ? op.shape.a1 : ""

  const band = parseBand(a1)
  if (band === null) reject(400, invalidRange(a1, "Use A1 notation, for example A1:D20 or A1:C."))
  if (band.sheet !== null && band.sheet !== api.tabTitle) {
    reject(
      400,
      invalidRange(a1, `That range names tab "${band.sheet}"; this API serves tab "${api.tabTitle}".`)
    )
  }

  const resolved = resolveBand(band, grid.tab, api.tabTitle)
  if (resolved === null) {
    reject(
      400,
      invalidRange(
        a1,
        `This tab is ${grid.tab.rows} rows by ${grid.tab.columns} columns, and the range falls outside it.`
      )
    )
  }

  return {
    data: {
      rows: bandCells(grid.values, resolved),
      headers: bandHeaders(grid.values, api.headerRow, resolved),
    },
    count: resolved.endRow - resolved.startRow + 1,
    limit: null,
    offset: 0,
  }
}

/**
 * PK resolution (§1.5): 0 matches is a 404 with the contract's exact message, more than 1 is a 409,
 * and the engine NEVER picks one — a concurrent insert that duplicated the key would otherwise turn
 * one update into a two-row write.
 *
 * Resolution happens on the read that precedes the verb, so a 404/409 is raised before any Google call
 * is spent. Sheets gives `values.update` no conditional write, so a row someone else duplicated in the
 * meantime is written anyway: the engine's answer is the row it resolved, and no stub can express that
 * race either — which is why nothing here pretends to re-check it after the fact.
 */
function requireSingleRow(table: EngineTable, op: EngineOp): RecordTarget {
  const pkColumn = op.pkColumn
  const value = op.shape.kind === "record" ? op.shape.record : ""
  const rows = findRowsByPrimaryKey(table, pkColumn, value)
  if (rows.length !== 1) {
    reject(rows.length === 0 ? 404 : 409, primaryKeyError(rows.length, pkColumn, value))
  }
  return { op, pkColumn, row: rows[0] }
}

async function createRecords(
  op: EngineOp,
  deps: EngineDeps,
  api: EngineApi,
  table: EngineTable
): Promise<OpOutcome> {
  const records = parseCreateBody(op)
  requireCreateColumns(visibleHeaders(table, api), records, op.method)

  const rows = records.map((record) => table.headers.map((key) => stringifyCell(record[key])))
  // Appending is anchored on the HEADER row: with `insertDataOption=INSERT_ROWS` that is what makes
  // real Sheets place the rows below the table instead of against the grid's bottom edge.
  const ref = rowSpanRef(api.tabTitle, api.headerRow, 1, Math.max(1, table.headers.length))
  await callGoogle(deps, api, (sheet) => sheet.appendValues(ref, rows))

  return {
    data: { created: records.length, records },
    count: records.length,
    limit: null,
    offset: 0,
    status: 201,
  }
}

/**
 * PATCH merges, PUT replaces — the two verbs differ in exactly one way, and it is the one a caller is
 * most likely to get wrong:
 *
 *   PATCH /{record}: only the columns in the body are written, adjacent columns coalesce into ONE
 *     `updateValues` call per contiguous span, and the primary key in the body is ignored — rewriting
 *     the id would move the record out from under the caller.
 *   PUT /{record}: a header-width row is written, and EVERY omitted column — including the primary key
 *     when the body leaves it out — is CLEARED to `""`. That is the documented divergence from PATCH
 *     (§1.3), not an oversight: omitting the id in a PUT blanks the id cell.
 */
async function patchRecord(
  target: RecordTarget,
  deps: EngineDeps,
  api: EngineApi,
  table: EngineTable
): Promise<OpOutcome> {
  const { op, pkColumn, row } = target
  const body = parseWriteBody(op)
  // Every unknown key in the body is named at once; the primary key is skipped, not rejected.
  const headers = visibleHeaders(table, api)
  const offenders = Object.keys(body).filter((key) => key !== pkColumn && !headers.includes(key))
  requireKnownColumns(headers, offenders, op.method)

  const record = { ...row.record }
  const columns: number[] = []
  for (const [key, raw] of Object.entries(body)) {
    if (key === pkColumn) continue
    if (!table.headers.includes(key)) continue
    const value = stringifyCell(raw)
    record[key] = value
    columns.push(table.headers.indexOf(key) + 1)
  }

  // No column to write (a body that carried only the primary key) is still a successful merge: the
  // record the caller asked for is the one that already exists, and no Google call is spent.
  for (const run of columnRuns(columns)) {
    const cells = table.headers.slice(run.startCol - 1, run.endCol).map((key) => record[key] ?? "")
    const ref = rowSpanRef(api.tabTitle, row.gridRow, run.startCol, run.endCol)
    await callGoogle(deps, api, (sheet) => sheet.updateValues(ref, [cells]))
  }

  return { data: { updated: 1, record: visibleRecord(record, table, api) }, count: 1, limit: null, offset: 0 }
}

async function putRecord(
  target: RecordTarget,
  deps: EngineDeps,
  api: EngineApi,
  table: EngineTable
): Promise<OpOutcome> {
  const { op, row } = target
  const body = parseWriteBody(op)
  const headers = visibleHeaders(table, api)
  requireKnownColumns(headers, unknownColumns(headers, body), op.method)

  // PUT clears what the caller can see. A column hidden from this API keeps its value.
  const cells = table.headers.map((key) => {
    if (!headers.includes(key)) return row.record[key] ?? ""
    return key in body ? stringifyCell(body[key]) : ""
  })
  const ref = rowSpanRef(api.tabTitle, row.gridRow, 1, Math.max(1, table.headers.length))
  await callGoogle(deps, api, (sheet) => sheet.updateValues(ref, [cells]))

  return {
    data: { updated: 1, record: visibleRecord(recordFromCells(table.headers, cells), table, api) },
    count: 1,
    limit: null,
    offset: 0,
  }
}

/**
 * DELETE removes the resolved row with `batchUpdate.deleteDimension`.
 *
 * DEVIATION (flagged in the Phase 4 report): the Phase 4 brief spelled this call
 * `deleteRow(api.googleSheetId, …)`, but `SheetsClient.deleteRow`'s first argument is Google's NUMERIC
 * grid id (`SheetTab.id`) — `src/server/google/sheets.ts` rejects anything else and
 * `tests/google-sheets.test.ts` pins that. A workbook id there would make every DELETE a 400 in
 * production, so the engine passes the gid it read from `spreadsheets.get`.
 *
 * The 0-based conversion happens in the call below and exists nowhere else: `gridRow` is internal (§1.5).
 */
async function deleteRecord(
  target: RecordTarget,
  deps: EngineDeps,
  api: EngineApi,
  table: EngineTable
): Promise<OpOutcome> {
  const { op, row } = target
  if (op.bodyText !== null && op.bodyText.trim() !== "") {
    reject(
      400,
      validationFailed("A DELETE request must not carry a body.", {
        body: "Delete one record by id: /api/v1/{api}/{record}, with no body.",
      })
    )
  }

  await callGoogle(deps, api, (sheet) => sheet.deleteRow(table.tab.id, api.tabTitle, row.gridRow - 1))
  return { data: { deleted: 1 }, count: 1, limit: null, offset: 0 }
}

/* ---------------------------------------------------------------- 8. the lifecycle */

/** §1.2's 403, from `authorizeKeyCall`'s code; `api_not_found` is the caller's 404 arm instead. */
function forbidden(code: string, method: SnippetMethod): ActionError {
  return { error: { code, message: restrictedMessage(code, method), category: "auth" } }
}

/** §4.4 keeps `google_not_connected` a code of its own, outside the `GoogleErrorKind` table. */
function notConnected(): ActionError {
  return {
    error: {
      code: "google_not_connected",
      message: "This API's owner has no connected Google account for Sheet Zaber to read the spreadsheet with.",
      category: "google",
    },
  }
}

/**
 * The §1.2 envelope and status for anything that escaped the guards. `EngineRejection` carries its own
 * status; a Google failure is answered from `GOOGLE_RULES`, which is THE engine's table and wins over
 * `src/server/google/errors.ts` (that mapping is the dashboard's, §4.4). An unclassifiable error is
 * `internal_error`, with the cause written to the server log and nowhere else.
 */
function failureResult(error: unknown, started: number, trace: EngineTrace): WireResult {
  if (error instanceof EngineRejection) {
    return errorResult(error.status, error.error, error.headers, started, trace)
  }

  if (error instanceof EngineNotConnected) {
    return errorResult(503, notConnected(), {}, started, trace)
  }

  const googleError = toGoogleError(error)
  const rule = GOOGLE_RULES[googleError.kind]
  const headers: Record<string, string> = {}

  if (rule.code === "internal_error") {
    // The ONLY place a cause is written: the client gets `internal_error` and nothing else (§1.2).
    console.error("[engine] unexpected failure", error)
    return errorResult(rule.status, internalError(), headers, started, trace)
  }

  if (rule.code === "google_quota_exceeded") {
    // §1.5's Retry-After passthrough: read off the RAW thrown value, before normalisation dropped it.
    const retryAfter = retryAfterFromError(error)
    if (retryAfter !== null) headers["Retry-After"] = String(retryAfter)
  }

  const envelope: ActionError = {
    error: { code: rule.code, message: rule.message, category: rule.category },
  }
  return errorResult(rule.status, envelope, headers, started, trace)
}

/**
 * §1.4's four windows, in one place.
 *
 * The hour limit comes from `api_configurations.rate_limit_per_hour`, which `ratelimit.ts` reads (the
 * deliberately-10-field `EngineApi` payload does not carry it); a row that cannot be read degrades to
 * the platform default there rather than refusing service here.
 *
 * The user window is the third dimension, and it is counted against `api.userId` — the user who OWNS
 * the API, across every one of their APIs and keys — because that is whose quota the owner allocates.
 * The `role = 'owner'` bypass lives in `ratelimit.ts#engineUserDayLimit`, not here and not in any
 * route or component, so it holds for every caller of this function.
 */
async function limitRate(apiId: string, keyId: string, userId: string, ip: string | null): Promise<RateVerdict> {
  return consumeEngineRate({ apiId, keyId, userId, ip, hourLimit: await engineHourLimit(apiId) })
}

/**
 * §1.4's canonical 429, worded for the window that actually tripped.
 *
 * `errors.ts#rateLimited` is the per-KEY wording; a support ticket must be able to tell "this user
 * used up the daily allowance the owner allocated them" from "this key hit its hour window", and the
 * two dimensions differ in whose quota moved. The code (`rate_limited`), the category
 * (`rate_limit`) and `fields.retry_after` are identical either way — only the message distinguishes
 * them, and `X-RateLimit-*` above already carries the binding window's numbers.
 */
function rateLimitError(verdict: RateVerdict): ActionError {
  if (verdict.dimension !== "user_day") return rateLimited(verdict.retryAfterSeconds)
  return fail(
    "rate_limited",
    `This user's daily API quota (${verdict.limit} requests per day) is exhausted; the limit is per user, across all of their APIs and keys. The owner can allocate more with PATCH /api/internal/admin/users/{id}.`,
    "rate_limit",
    { retry_after: String(verdict.retryAfterSeconds) }
  )
}

/**
 * Everything above this line is the contract; this function is the ORDER the contract is enforced in.
 * It returns a `WireResult` for successes and throws `EngineRejection` for failures, which
 * `handleEngineCall` catches once — so exactly one envelope and one log row per request.
 */
async function dispatch(
  call: EngineCall,
  deps: EngineDeps,
  trace: EngineTrace,
  started: number
): Promise<WireResult> {
  const key = await authenticate(call.auth, trace)

  const requestedApiId = call.pathSegments[0]
  if (requestedApiId === undefined || requestedApiId === "") reject(404, apiNotFound())

  const api = await resolveEngineApi(requestedApiId)
  if (api === null) reject(404, apiNotFound())
  trace.apiId = api.id
  // The API's owner is the log's owner: a key only ever acts on its own user's data here, and
  // `authorizeKeyCall` immediately below is what makes that statement true.
  trace.userId = api.userId

  const decision = authorizeKeyCall(
    key,
    { id: api.id, userId: api.userId, permissions: api.permissions, allowedOperations: api.allowedOperations },
    call.method
  )
  if (!decision.ok) {
    // A foreign API reads as "no such API" (`security.md` §3 item 4); every other denial is a 403.
    if (decision.code === "api_not_found") reject(404, apiNotFound())
    reject(403, forbidden(decision.code, call.method))
  }

  // A DISABLED OWNER stops serving immediately, with the same 404 bytes as an unknown id
  // (`security.md` §2 "disable takes effect immediately"; §1.1 grants nothing to a key whose user is
  // suspended). §1.2 gives this no code of its own, so it is answered as `api_not_found` rather than
  // inventing one — and it sits before the rate limiter, so a suspended account consumes no window.
  const owner = await findUserById(api.userId)
  if (owner === undefined || owner.status !== "active") reject(404, apiNotFound())

  const shape = shapeOf(call.pathSegments, call.method)
  if (shape === null) reject(404, apiNotFound())

  // No-PK verbs (§1.3): only the `{record}` slot asks for a primary key — a list+filter write needs
  // none. Both answers are 403s, so they sit BEFORE the rate limiter, which has consumed nothing yet.
  if (shape.kind === "record" && api.primaryKeyColumn === null) {
    reject(403, call.method === "GET" ? readRequiresPrimaryKey() : writeRequiresPrimaryKey())
  }

  // A range answers raw cells by position, which a column allowlist cannot describe.
  if (shape.kind === "range" && api.exposedColumns) {
    reject(403, {
      error: {
        code: "operation_not_allowed",
        message: "Range reads are off for this API because it exposes only selected columns. Use the list route with fields.",
        category: "auth",
      },
    })
  }

  // §1.4: rate limiting starts only once the key is known good. A 401 or a 403 consumed nothing.
  const verdict = await limitRate(api.id, key.id, api.userId, call.ip)
  trace.authorized = true
  const rateHeaders = rateLimitHeaders(verdict)
  if (!verdict.allowed) reject(429, rateLimitError(verdict), rateHeaders)

  // The operation is fully resolved here, before a single Google call: the grammar, the PK gate and
  // the column this call addresses. `pkColumn === ""` can only mean "not a record call", because the
  // gate above already rejected a record call against a keyless API; the belt below is a type
  // narrowing, not a second rule.
  const op: EngineOp = {
    method: call.method,
    pathSegments: call.pathSegments,
    searchParams: call.searchParams,
    bodyText: call.bodyText,
    shape,
    pkColumn: shape.kind === "record" ? (api.primaryKeyColumn ?? "") : "",
  }

  let outcome: OpOutcome

  if (shape.kind === "range") {
    const grid = await readGrid(deps, api)
    outcome = rangeRecords(op, grid, api)
  } else if (shape.kind === "list" || shape.kind === "search") {
    const grid = await readGrid(deps, api)
    outcome = listRecords(op, visibleTable(tableOf(grid, api), api), shape.kind === "search")
  } else if (shape.kind === "create") {
    const grid = await readGrid(deps, api)
    outcome = await createRecords(op, deps, api, tableOf(grid, api))
  } else {
    if (op.pkColumn === "") reject(403, writeRequiresPrimaryKey())
    const grid = await readGrid(deps, api)
    const table = tableOf(grid, api)
    const target = requireSingleRow(table, op)
    if (call.method === "GET") {
      const row = { ...target.row, record: visibleRecord(target.row.record, table, api) }
      outcome = readRecord(op, visibleTable(table, api), row)
    } else if (call.method === "PATCH") {
      outcome = await patchRecord(target, deps, api, table)
    } else if (call.method === "PUT") {
      outcome = await putRecord(target, deps, api, table)
    } else {
      outcome = await deleteRecord(target, deps, api, table)
    }
  }

  return successResult(api, outcome, started, trace, rateHeaders)
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

function successResult(
  api: EngineApi,
  outcome: OpOutcome,
  started: number,
  trace: EngineTrace,
  rateHeaders: Record<string, string>
): WireResult {
  const durationMs = elapsed(started)
  trace.durationMs = durationMs
  const meta: EngineMeta = {
    api_id: api.id,
    count: outcome.count,
    limit: outcome.limit,
    offset: outcome.offset,
    duration_ms: durationMs,
  }
  return {
    status: outcome.status ?? 200,
    // `gridRow` cannot appear here: `data` is built from `EngineRecord`s only (§1.5).
    envelope: { data: outcome.data, meta },
    headers: { ...rateHeaders },
  }
}

function errorResult(
  status: number,
  error: ActionError,
  headers: Record<string, string>,
  started: number,
  trace: EngineTrace
): WireResult {
  trace.durationMs = elapsed(started)
  trace.errorCategory = error.error.category
  return { status, envelope: error, headers: { ...headers } }
}

/**
 * The one public function: the whole `/api/v1` lifecycle, in process. It never throws (§1.2's 500 is
 * the backstop for anything that escaped the guards above), it always logs exactly one request row —
 * including for 401/403/404 (§1.5) — and it serialises the envelope itself, so every caller forwards
 * identical bytes (§4.8).
 */
export async function handleEngineCall(
  call: EngineCall,
  deps: EngineDeps = { sheetsFor: defaultSheetsFor }
): Promise<EngineOutcome> {
  const started = performance.now()
  const trace: EngineTrace = {
    keyId: null,
    userId: null,
    apiId: null,
    authorized: false,
    errorCategory: null,
    durationMs: 0,
  }

  let result: WireResult
  try {
    result = await dispatch(call, deps, trace, started)
  } catch (error) {
    result = failureResult(error, started, trace)
  }

  // §1.5: every request is logged, and a log that cannot be written must not change the answer.
  try {
    await insertRequestLog({
      apiId: trace.apiId,
      userId: trace.userId,
      apiKeyId: trace.keyId,
      method: call.method,
      path: loggedPath(call),
      statusCode: result.status,
      durationMs: trace.durationMs,
      requestBytes: bodyBytes(call.bodyText),
      errorCategory: result.status >= 400 ? trace.errorCategory : null,
      // `origin` is the Origin/Referer host, which `EngineCall` does not carry; `ip` is a bucket
      // dimension only and is never stored (`security.md` §2).
      origin: null,
    })
  } catch (error) {
    console.error("[engine] request log failed", error)
  }

  if (trace.authorized && trace.keyId !== null) {
    try {
      await markKeyUsed(trace.keyId)
    } catch (error) {
      console.error("[engine] key usage update failed", error)
    }
  }

  return {
    status: result.status,
    body: JSON.stringify(result.envelope),
    // §4.8 names `content-type` as a header the ENGINE publishes — the playground removes it and sets
    // its own, `/api/v1` forwards it verbatim — so both surfaces advertise the same JSON body.
    headers: { "content-type": JSON_CONTENT_TYPE, ...result.headers },
  }
}

/**
 * The logged path: `/api/v1` plus the segments as the caller spelled them, with NO query string (a
 * filter value is data), control characters flattened, and the `{record}` slot MASKED.
 *
 * `security.md` §4 and `database-schema.md` ("Never stored: … cell contents") outrank §1.3's habit of
 * putting the primary-key VALUE in the path: a primary-key value IS a cell, so the log records the
 * slot's name instead. `search`/`range` are grammar, not data, and a band like `A1:D20` names no cell,
 * so both stay readable for support.
 */
function loggedPath(call: EngineCall): string {
  const segments = call.pathSegments.map((segment) => segment.replace(/[\s\u0000-\u001f\u007f]+/g, "_"))
  if (segments.length === 0) return "/api/v1"
  const reserved = segments[1] === "search" || segments[1] === "range"
  if (segments.length === 2 && !reserved) return `/api/v1/${segments[0]}/{record}`
  return `/api/v1/${segments.join("/")}`
}
