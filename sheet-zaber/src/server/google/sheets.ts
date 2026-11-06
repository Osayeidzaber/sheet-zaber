/*
 * The ONLY module in Sheet Zaber that imports `googleapis` (`architecture.md` §5,
 * `google-integration.md` §"Hard boundary"). Everything above this file — the engine, the
 * spreadsheets service, routes and server actions — depends on the `SheetsClient` interface
 * exported here (type-only import), never on the SDK.
 *
 * The interface is deliberately the same shape as `tests/helpers/fake-sheets.ts`, the in-memory
 * stub the engine tests run against, minus the stub-only `failNextWith`/`dump` helpers:
 * `tests/google-sheets.test.ts` pins the two together with a contract-parity table, so engine
 * tests cannot tell stub from real and the two cannot drift.
 *
 * Two consequences of the stub's `ref`-only grammar worth stating:
 * - a `ref` carries a TAB (`'My Tab'!A1:C3`), never a workbook, so a client is bound to ONE
 *   spreadsheet id at creation; asking it for another workbook is a 404-class failure, exactly
 *   like the stub's `checkSpreadsheet`.
 * - `deleteRow(sheetId, …)`'s first argument is a `SheetTab.id` (Google's numeric grid id),
 *   because `batchUpdate.deleteDimension` addresses sheets by gid, not by title.
 *
 * Access tokens are handed to the SDK and nowhere else: not stored on the returned client, not
 * embedded in an error message, not logged.
 */

import { google } from "googleapis"

import { fromGoogleError, GoogleApiError } from "./errors"

/* ---------------------------------------------------------------- interface (stub parity) */

/** `{ id: gid, title, rows, columns }` — identical to the stub's `SheetTab`. */
export type SheetTab = { id: string; title: string; rows: number; columns: number }
export type SpreadsheetMeta = { spreadsheetId: string; title: string; tabs: SheetTab[] }
export type ValuesResult = { range: string; values: string[][] }
export type WriteResult = { updatedRange: string; updatedRows: number }

export type SheetsClient = {
  getSpreadsheetMeta(spreadsheetId: string): Promise<SpreadsheetMeta>
  getValues(ref: string): Promise<ValuesResult>
  appendValues(ref: string, rows: string[][]): Promise<WriteResult>
  updateValues(ref: string, values: string[][]): Promise<WriteResult>
  deleteRow(sheetId: string, tabTitle: string, rowIndex: number): Promise<void>
}

/* ---------------------------------------------------------------- SDK surface we use */

/** `spreadsheets.get` response, narrowed to the fields the tab snapshot needs. */
export type SheetResponse = {
  properties?: {
    sheetId?: number | null
    title?: string | null
    gridProperties?: { rowCount?: number | null; columnCount?: number | null } | null
  } | null
}
export type SpreadsheetResponse = {
  spreadsheetId?: string | null
  properties?: { title?: string | null } | null
  sheets?: SheetResponse[] | null
}
export type ValueRangeResponse = { range?: string | null; values?: unknown[][] | null }
export type WriteUpdates = { updatedRange?: string | null; updatedRows?: number | null }
/** `values.append` nests its result under `updates`; `values.update` returns it at the top level. */
export type AppendResponse = { updates?: WriteUpdates | null }
export type UpdateResponse = WriteUpdates

/** One `batchUpdate` request; only `deleteDimension` is in scope (`google-integration.md` §4). */
export type SheetsBatchRequest = {
  deleteDimension?: {
    range?: { sheetId?: number; dimension?: string; startIndex?: number; endIndex?: number }
  }
}

/**
 * The slice of `sheets v4` this module touches. Declared structurally so tests can inject a
 * recorder-shaped fake without the SDK (and without network) — see `SheetsApiFactory`.
 */
export type SheetsApi = {
  spreadsheets: {
    get(params: { spreadsheetId: string; fields?: string }): Promise<{ data?: SpreadsheetResponse | null }>
    batchUpdate(params: {
      spreadsheetId: string
      requestBody: { requests: SheetsBatchRequest[] }
    }): Promise<{ data?: unknown }>
    values: {
      get(params: { spreadsheetId: string; range: string }): Promise<{ data?: ValueRangeResponse | null }>
      append(params: {
        spreadsheetId: string
        range: string
        valueInputOption: "RAW"
        insertDataOption: "INSERT_ROWS"
        requestBody: { values: string[][] }
      }): Promise<{ data?: AppendResponse | null }>
      update(params: {
        spreadsheetId: string
        range: string
        valueInputOption: "RAW"
        requestBody: { values: string[][] }
      }): Promise<{ data?: UpdateResponse | null }>
    }
  }
}

/** How a `SheetsApi` is produced for an access token — the injection point for tests. */
export type SheetsApiFactory = (accessToken: string) => SheetsApi

/**
 * `properties,sheets.properties` is §3 step 3's mask. `spreadsheetId` is added so the response can
 * be scope-checked, and tab titles/dimensions come from `sheets.properties.title` +
 * `…gridProperties.rowCount/columnCount` (the v4 schema has no `properties.sheetTitles` field).
 */
const META_FIELDS = "spreadsheetId,properties,sheets.properties"

const defaultSheetsApiFactory: SheetsApiFactory = (accessToken) => {
  // A pre-minted access token (`tokens.ts` owns minting/refresh) handed to a stateless OAuth2
  // client: `googleapis` treats a *string* auth as an API key, so the token must travel as
  // credentials. With `access_token` set and no `expiry_date`, google-auth-library attaches the
  // Bearer header and never attempts a refresh — refreshing stays above this module (§2).
  const auth = new google.auth.OAuth2()
  auth.setCredentials({ access_token: accessToken })
  return google.sheets({ version: "v4", auth })
}

/* ---------------------------------------------------------------- response narrowing */

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  // FORMATTED_VALUE already renders booleans/dates as strings; these branches are defensive so
  // a `true` never reaches the engine as "true".
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  return String(value)
}

function toCells(rows: unknown[][] | null | undefined): string[][] {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => (Array.isArray(row) ? row.map(cellText) : []))
}

/**
 * `rowCount`/`columnCount` are absent for non-grid sheets (charts, images); 0 keeps the snapshot
 * honest — the engine refuses a tab with no grid rather than inventing dimensions.
 */
function positiveInt(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function tabsFrom(meta: SpreadsheetResponse): SheetTab[] {
  const sheets = Array.isArray(meta.sheets) ? meta.sheets : []
  return sheets.flatMap((sheet): SheetTab[] => {
    const properties = sheet?.properties
    if (properties === null || properties === undefined) return []
    const { sheetId, title } = properties
    if (typeof sheetId !== "number" || !Number.isInteger(sheetId) || sheetId < 0) return []
    if (typeof title !== "string") return []
    const grid = properties.gridProperties ?? {}
    return [
      {
        id: String(sheetId),
        title,
        rows: positiveInt(grid.rowCount),
        columns: positiveInt(grid.columnCount),
      },
    ]
  })
}

/* ---------------------------------------------------------------- client */

/**
 * A Sheets client for one (token, spreadsheet) pair.
 *
 * `spreadsheetId` binds the workbook because the stub's `ref` argument names only a tab; a call
 * that asks for a different workbook fails closed as `inaccessible` instead of silently reading
 * someone else's sheet. `factory` exists so tests can assert the exact wire payloads without
 * touching the network.
 */
export function createSheetsClient(
  accessToken: string,
  spreadsheetId: string,
  factory: SheetsApiFactory = defaultSheetsApiFactory
): SheetsClient {
  const api = factory(accessToken)

  /** The §3/§4 guard: this client only ever speaks for the workbook it was bound to. */
  function requireScope(requestedId: string): void {
    if (requestedId !== spreadsheetId) {
      throw new GoogleApiError(
        404,
        "inaccessible",
        `spreadsheet ${requestedId} is not the spreadsheet this client is bound to`,
        "spreadsheetIdMismatch"
      )
    }
  }

  /** Every A1 ref is trimmed and forwarded verbatim: this module does not parse A1. */
  function rangeOf(ref: string): string {
    const range = ref.trim()
    if (range === "") {
      throw new GoogleApiError(400, "invalid_request", "A1 range is empty", "invalidRange")
    }
    return range
  }

  return {
    async getSpreadsheetMeta(requestedId) {
      requireScope(requestedId)
      try {
        const res = await api.spreadsheets.get({ spreadsheetId: spreadsheetId, fields: META_FIELDS })
        const data = res?.data ?? {}
        return {
          spreadsheetId: typeof data.spreadsheetId === "string" && data.spreadsheetId !== ""
            ? data.spreadsheetId
            : spreadsheetId,
          title: typeof data.properties?.title === "string" ? data.properties.title : "",
          tabs: tabsFrom(data),
        }
      } catch (error) {
        throw fromGoogleError(error)
      }
    },

    async getValues(ref) {
      const range = rangeOf(ref)
      try {
        const res = await api.spreadsheets.values.get({ spreadsheetId, range })
        const data = res?.data ?? {}
        return {
          // Google echoes the *requested* range here (its `values` are already trimmed of
          // trailing empty rows/columns), so `range` is informational — read `values`.
          range: typeof data.range === "string" && data.range !== "" ? data.range : range,
          values: toCells(data.values),
        }
      } catch (error) {
        throw fromGoogleError(error)
      }
    },

    async appendValues(ref, rows) {
      const range = rangeOf(ref)
      if (rows.length === 0) {
        throw new GoogleApiError(400, "invalid_request", "appendValues needs at least one row", "emptyValues")
      }
      try {
        const res = await api.spreadsheets.values.append({
          spreadsheetId,
          range,
          // RAW + INSERT_ROWS: §4 — user input that looks like `=` or `@` must never be a formula.
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: rows },
        })
        const updates = res?.data?.updates ?? {}
        return {
          updatedRange: typeof updates.updatedRange === "string" && updates.updatedRange !== ""
            ? updates.updatedRange
            : range,
          updatedRows: positiveInt(updates.updatedRows) || rows.length,
        }
      } catch (error) {
        throw fromGoogleError(error)
      }
    },

    async updateValues(ref, values) {
      const range = rangeOf(ref)
      if (values.length === 0) {
        throw new GoogleApiError(400, "invalid_request", "updateValues needs at least one row", "emptyValues")
      }
      try {
        const res = await api.spreadsheets.values.update({
          spreadsheetId,
          range,
          valueInputOption: "RAW",
          requestBody: { values },
        })
        const updates = res?.data ?? {}
        return {
          updatedRange: typeof updates.updatedRange === "string" && updates.updatedRange !== ""
            ? updates.updatedRange
            : range,
          updatedRows: positiveInt(updates.updatedRows) || values.length,
        }
      } catch (error) {
        throw fromGoogleError(error)
      }
    },

    async deleteRow(sheetId, tabTitle, rowIndex) {
      // `deleteDimension` needs the numeric gid; a non-numeric `SheetTab.id` would send `NaN`.
      if (!/^\d+$/.test(sheetId)) {
        throw new GoogleApiError(
          400,
          "invalid_request",
          `deleteRow ${tabTitle}: "${sheetId}" is not a Google sheet id`,
          "invalidSheetId"
        )
      }
      if (!Number.isInteger(rowIndex) || rowIndex < 0) {
        throw new GoogleApiError(
          400,
          "invalid_request",
          `deleteRow ${tabTitle}: row index ${rowIndex} must be a 0-based integer`,
          "invalidRowIndex"
        )
      }
      try {
        await api.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                deleteDimension: {
                  range: {
                    sheetId: Number(sheetId),
                    dimension: "ROWS",
                    startIndex: rowIndex,
                    endIndex: rowIndex + 1,
                  },
                },
              },
            ],
          },
        })
      } catch (error) {
        throw fromGoogleError(error)
      }
    },
  }
}
