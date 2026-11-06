import { describe, expect, it } from "vitest"

import {
  fromGoogleError,
  googleActionError,
  GoogleApiError,
  isInaccessible,
  isReauthRequired,
  type GoogleErrorKind,
} from "@/server/google/errors"
import {
  createSheetsClient,
  type AppendResponse,
  type SheetsApi,
  type SheetsClient,
  type SpreadsheetResponse,
  type UpdateResponse,
  type ValueRangeResponse,
} from "@/server/google/sheets"
import type { ErrorCategory } from "@/lib/action-result"

import { fakeSheets, type GoogleErrorStatus, type SheetTab, type SheetsStubError } from "./helpers/fake-sheets"

/*
 * Phase 4.1 — the `googleapis` boundary.
 *
 * Two jobs:
 * 1. Pin the WIRE payloads. `createSheetsClient` gets an injected `SheetsApiFactory`, so these
 *    tests assert exactly what the client sends Google (the `spreadsheets.get` field mask, RAW +
 *    INSERT_ROWS on append, the `batchUpdate`/`deleteDimension` shape) with no network.
 * 2. Pin PARITY with `tests/helpers/fake-sheets.ts`. The stub is the engine tests' Sheets, and its
 *    header promises Phase 4 re-implements the same interface. `googleLikeApi()` below is an
 *    independent implementation of Google's documented behaviour over an in-memory grid; the parity
 *    table then runs the identical call sequence through the stub and through the real client and
 *    requires the same answers. If either drifts, the engine's view of "a Sheets API" changes and
 *    this test says so.
 */

const TOKEN = "ya29.test-only-access-token"
const SHEET_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
const META_FIELDS = "spreadsheetId,properties,sheets.properties"

/* ---------------------------------------------------------------- fake SDK recorder */

type FakeMethod = "spreadsheets.get" | "values.get" | "values.append" | "values.update" | "batchUpdate"

type RecordedCall = { method: FakeMethod; params: Record<string, unknown> }

/** Mirrors the `spreadsheets: { get, batchUpdate, values }` slice the client is allowed to touch. */
function fakeApi(input: {
  meta?: SpreadsheetResponse
  values?: ValueRangeResponse
  append?: AppendResponse
  update?: UpdateResponse
  throwOn?: Partial<Record<FakeMethod, unknown>>
} = {}): { api: SheetsApi; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []

  async function invoke<T>(method: FakeMethod, params: Record<string, unknown>, data: T) {
    calls.push({ method, params })
    const armed = input.throwOn?.[method]
    if (armed !== undefined) throw armed
    return { data }
  }

  const api: SheetsApi = {
    spreadsheets: {
      get: (params) => invoke("spreadsheets.get", { ...params }, input.meta ?? {}),
      batchUpdate: (params) =>
        invoke("batchUpdate", { spreadsheetId: params.spreadsheetId, requestBody: params.requestBody }, null),
      values: {
        get: (params) => invoke("values.get", { ...params }, input.values ?? {}),
        append: (params) => invoke("values.append", { ...params }, input.append ?? {}),
        update: (params) => invoke("values.update", { ...params }, input.update ?? {}),
      },
    },
  }
  return { api, calls }
}

function clientFor(api: SheetsApi, spreadsheetId = SHEET_ID) {
  return createSheetsClient(TOKEN, spreadsheetId, () => api)
}

/** Capture a rejection as a value so the taxonomy can be asserted uniformly. */
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error("expected the call to reject")
    },
    (error: unknown) => error
  )
}

/** A `GaxiosError`-shaped failure: `.status`, numeric `.code`, and the AIP-193 body. */
function googleLikeError(status: number, message: string, reason?: string): unknown {
  const error = new Error(message) as Error & {
    status?: number
    code?: number | string
    response?: { status: number; data: Record<string, unknown> }
  }
  error.name = "GaxiosError"
  error.status = status
  error.code = status
  error.response = {
    status,
    data: {
      error: {
        code: status,
        message,
        errors: [{ domain: "global", reason: reason ?? "unknown", message }],
      },
    },
  }
  return error
}

/* ---------------------------------------------------------------- 1. wire payloads */

describe("Sheets client request payloads", () => {
  it("sends the §3 field mask and narrows sheets.properties to a tab snapshot", async () => {
    const { api, calls } = fakeApi({
      meta: {
        spreadsheetId: SHEET_ID,
        properties: { title: "Roster" },
        sheets: [
          { properties: { sheetId: 0, title: "Data", gridProperties: { rowCount: 100, columnCount: 26 } } },
          { properties: { sheetId: 7, title: "My Tab", gridProperties: { rowCount: 50, columnCount: 8 } } },
        ],
      },
    })

    await expect(clientFor(api).getSpreadsheetMeta(SHEET_ID)).resolves.toEqual({
      spreadsheetId: SHEET_ID,
      title: "Roster",
      tabs: [
        { id: "0", title: "Data", rows: 100, columns: 26 },
        { id: "7", title: "My Tab", rows: 50, columns: 8 },
      ],
    })
    expect(calls).toEqual([
      { method: "spreadsheets.get", params: { spreadsheetId: SHEET_ID, fields: META_FIELDS } },
    ])
  })

  it("defaults a sheet with no grid to 0 rows / 0 columns and skips sheets without properties", async () => {
    const { api } = fakeApi({
      meta: {
        spreadsheetId: SHEET_ID,
        properties: {},
        sheets: [
          { properties: { sheetId: 3, title: "Blank" } },
          { properties: null },
          {},
          { properties: { sheetId: null, title: "No gid" } },
          { properties: { sheetId: 4, title: null } },
          { properties: { sheetId: 5.5, title: "Fractional gid" } },
        ],
      },
    })

    const meta = await clientFor(api).getSpreadsheetMeta(SHEET_ID)
    expect(meta.title).toBe("")
    // Only the well-formed grid sheet survives the narrowing.
    expect(meta.tabs).toEqual([{ id: "3", title: "Blank", rows: 0, columns: 0 }])
  })

  it("falls back to the bound id and an empty tab list on an empty response", async () => {
    const { api } = fakeApi()
    await expect(clientFor(api).getSpreadsheetMeta(SHEET_ID)).resolves.toEqual({
      spreadsheetId: SHEET_ID,
      title: "",
      tabs: [],
    })
  })

  it("refuses to read a workbook it was not bound to, without sending a request", async () => {
    const { api, calls } = fakeApi()
    const error = await rejection(() => clientFor(api).getSpreadsheetMeta("someone-elses-sheet-id"))

    expect(error).toBeInstanceOf(GoogleApiError)
    expect((error as GoogleApiError).status).toBe(404)
    expect(isInaccessible(error)).toBe(true)
    expect(calls).toEqual([])
  })

  it("forwards the A1 ref verbatim as `range`, trimmed, and stringifies every cell", async () => {
    const { api, calls } = fakeApi({
      values: { range: "'My Tab'!A1:C2", values: [["id", 1, null], [true, undefined, "x"]] },
    })

    await expect(clientFor(api).getValues("   'My Tab'!A1:C2  ")).resolves.toEqual({
      range: "'My Tab'!A1:C2",
      values: [
        ["id", "1", ""],
        ["TRUE", "", "x"],
      ],
    })
    expect(calls).toEqual([{ method: "values.get", params: { spreadsheetId: SHEET_ID, range: "'My Tab'!A1:C2" } }])
  })

  it("reads a whole tab and a row band without rewriting the caller's notation", async () => {
    const { api, calls } = fakeApi({ values: { range: "Data!2:4", values: [["2", "Grace"]] } })

    await clientFor(api).getValues("Data!2:4")
    await clientFor(api).getValues("Data")
    expect(calls.map((call) => (call.params as { range: string }).range)).toEqual(["Data!2:4", "Data"])
  })

  it("answers a missing `values` array with an empty grid, not undefined", async () => {
    const { api } = fakeApi({ values: {} })
    await expect(clientFor(api).getValues("Data!A1:C3")).resolves.toEqual({ range: "Data!A1:C3", values: [] })
  })

  it("appends with RAW + INSERT_ROWS and returns Google's resolved range", async () => {
    const { api, calls } = fakeApi({
      append: { updates: { updatedRange: "Data!A5:C5", updatedRows: 1 } },
    })

    await expect(clientFor(api).appendValues("Data!A1", [["4", "Newton", "n@example.com"]])).resolves.toEqual({
      updatedRange: "Data!A5:C5",
      updatedRows: 1,
    })
    expect(calls).toEqual([
      {
        method: "values.append",
        params: {
          spreadsheetId: SHEET_ID,
          range: "Data!A1",
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: [["4", "Newton", "n@example.com"]] },
        },
      },
    ])
  })

  it("echoes the requested ref when Google omits `updates`, and refuses an empty append", async () => {
    const echoed = fakeApi({ append: {} })
    await expect(clientFor(echoed.api).appendValues("Data!A1", [["x"]])).resolves.toEqual({
      updatedRange: "Data!A1",
      updatedRows: 1,
    })

    const empty = fakeApi()
    const error = await rejection(() => clientFor(empty.api).appendValues("Data!A1", []))
    expect(error).toBeInstanceOf(GoogleApiError)
    expect((error as GoogleApiError).kind).toBe("invalid_request")
    expect(empty.calls).toEqual([])
  })

  it("updates with RAW only (no insert option) and echoes a single-cell range", async () => {
    const { api, calls } = fakeApi({ update: { updatedRange: "Data!B4", updatedRows: 1 } })

    await expect(clientFor(api).updateValues("Data!B4", [["Ada L."]])).resolves.toEqual({
      updatedRange: "Data!B4",
      updatedRows: 1,
    })
    expect(calls).toEqual([
      {
        method: "values.update",
        params: {
          spreadsheetId: SHEET_ID,
          range: "Data!B4",
          valueInputOption: "RAW",
          requestBody: { values: [["Ada L."]] },
        },
      },
    ])
  })

  it("maps deleteRow to a 0-based deleteDimension carrying the sheet's grid id", async () => {
    const { api, calls } = fakeApi()

    await expect(clientFor(api).deleteRow("12", "Data", 4)).resolves.toBeUndefined()
    expect(calls).toEqual([
      {
        method: "batchUpdate",
        params: {
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: [
              { deleteDimension: { range: { sheetId: 12, dimension: "ROWS", startIndex: 4, endIndex: 5 } } },
            ],
          },
        },
      },
    ])
  })

  it("refuses a non-numeric grid id or a non-0-based row index before sending batchUpdate", async () => {
    const { api, calls } = fakeApi()
    const client = clientFor(api)

    for (const run of [
      () => client.deleteRow("Sheet1", "Data", 0),
      () => client.deleteRow("12", "Data", -1),
      () => client.deleteRow("12", "Data", 1.5),
    ]) {
      const error = await rejection(run)
      expect(error).toBeInstanceOf(GoogleApiError)
      expect((error as GoogleApiError).kind).toBe("invalid_request")
    }
    expect(calls).toEqual([])
  })

  it("never puts the access token in a request payload or an error message", async () => {
    const { api, calls } = fakeApi({ throwOn: { "values.get": googleLikeError(401, "Invalid Credentials", "authExpired") } })

    const error = await rejection(() => clientFor(api).getValues("Data!A1:C3"))
    expect(JSON.stringify(calls)).not.toContain(TOKEN)
    expect((error as GoogleApiError).message).not.toContain(TOKEN)
    expect(googleActionError(error).error.message).not.toContain(TOKEN)
  })
})

/* ---------------------------------------------------------------- 2. error taxonomy */

type TaxonomyRow = {
  status: number
  kind: GoogleErrorKind
  code: string
  category: ErrorCategory
  reauth: boolean
  inaccessible: boolean
}

const TAXONOMY: TaxonomyRow[] = [
  { status: 401, kind: "reauth", code: "google_reauth_required", category: "google", reauth: true, inaccessible: false },
  { status: 403, kind: "inaccessible", code: "google_sheet_inaccessible", category: "google", reauth: false, inaccessible: true },
  { status: 404, kind: "inaccessible", code: "google_sheet_inaccessible", category: "google", reauth: false, inaccessible: true },
  { status: 429, kind: "rate_limited", code: "rate_limited", category: "rate_limit", reauth: false, inaccessible: false },
  { status: 400, kind: "invalid_request", code: "invalid_range", category: "validation", reauth: false, inaccessible: false },
  { status: 500, kind: "upstream", code: "google_unavailable", category: "google", reauth: false, inaccessible: false },
  { status: 503, kind: "upstream", code: "google_unavailable", category: "google", reauth: false, inaccessible: false },
  // Anything outside the recognised set is a typed 500-class error, never `undefined`.
  { status: 418, kind: "internal", code: "internal_error", category: "internal", reauth: false, inaccessible: false },
]

describe("Google error taxonomy", () => {
  it.each(TAXONOMY)("maps HTTP $status → $kind → $code ($category)", async ({ status, kind, code, category, reauth, inaccessible }) => {
    const { api } = fakeApi({ throwOn: { "values.get": googleLikeError(status, "upstream detail") } })
    const error = await rejection(() => clientFor(api).getValues("Data!A1:C3"))

    expect(error).toBeInstanceOf(GoogleApiError)
    const apiError = error as GoogleApiError
    expect(apiError.status).toBe(status)
    expect(apiError.kind).toBe(kind)
    expect(isReauthRequired(apiError)).toBe(reauth)
    expect(isInaccessible(apiError)).toBe(inaccessible)
    expect(apiError.reason).toBe("unknown")

    const result = googleActionError(apiError)
    expect(result.error.code).toBe(code)
    expect(result.error.category).toBe(category)
  })

  it("carries Google's machine reason when the body has one", async () => {
    const { api } = fakeApi({
      throwOn: { "values.get": googleLikeError(403, "The caller does not have permission", "permissionDenied") },
    })
    const error = (await rejection(() => clientFor(api).getValues("Data!A1:C3"))) as GoogleApiError
    expect(error.reason).toBe("permissionDenied")
  })

  it("reads the status out of every shape googleapis and the stub throw", () => {
    // GaxiosError with only a response.
    const responseOnly = { response: { status: 429, data: {} } }
    // Legacy `GoogleError`: a bare numeric `code`.
    const legacyCode = { code: 403, message: "The caller does not have permission" }
    // AIP-193 cause with a string `status`, no numeric code.
    const causeOnly = new Error("request failed", { cause: { code: 401, status: "UNAUTHENTICATED" } })
    // The Sheets stub: `status: "401"` (string) plus a numeric `code`.
    const stub = Object.assign(new Error("Invalid Credentials [401] getValues x"), {
      name: "SheetsStubError",
      status: "401",
      code: 401,
    }) as unknown as SheetsStubError

    expect(fromGoogleError(responseOnly).kind).toBe("rate_limited")
    expect(fromGoogleError(legacyCode).kind).toBe("inaccessible")
    expect(fromGoogleError(causeOnly).kind).toBe("reauth")
    expect(fromGoogleError(stub).kind).toBe("reauth")
    expect(fromGoogleError(stub).status).toBe(401)
  })

  it("turns an unclassifiable throw into a typed internal error that leaks nothing", () => {
    const plain = fromGoogleError(new Error("socket hang up"))
    expect(plain.status).toBe(500)
    expect(plain.kind).toBe("internal")
    expect(googleActionError(plain)).toEqual({
      error: { code: "internal_error", message: "The request could not be completed.", category: "internal" },
    })

    const thrownString = fromGoogleError("boom")
    expect(thrownString.kind).toBe("internal")
    expect(thrownString.status).toBe(500)
  })

  it("passes an already-typed GoogleApiError through unchanged", () => {
    const original = new GoogleApiError(403, "inaccessible", "nope", "permissionDenied")
    expect(fromGoogleError(original)).toBe(original)
  })
})

/* ---------------------------------------------------------------- 3. contract parity */

/**
 * An independent implementation of Google's DOCUMENTED behaviour over an in-memory grid
 * (`values.get` excludes trailing empty rows/columns, `values.append` lands after the last row
 * holding data in the appended columns, `deleteDimension` takes 0-based indices and a gid).
 * Written from the v4 semantics, not from the stub, so the parity table below compares two
 * implementations of the same contract instead of one implementation twice.
 */
function googleLikeApi(input: {
  spreadsheetId: string
  title: string
  tabs: { id: string; title: string; rows: number; columns: number; grid: string[][] }[]
}): { api: SheetsApi; arm(status: number): void; grid(title?: string): string[][] } {
  const tabs = input.tabs.map((tab) => ({ gid: Number(tab.id), title: tab.title, rows: tab.rows, columns: tab.columns, grid: tab.grid.map((row) => [...row]) }))
  let armed: number | undefined

  function guard(): void {
    if (armed === undefined) return
    const status = armed
    armed = undefined
    throw googleLikeError(status, `Simulated Google failure [${status}]`)
  }

  function tabByTitle(title: string) {
    const tab = tabs.find((candidate) => candidate.title === title)
    if (tab === undefined) throw googleLikeError(400, `Request contains an invalid argument: no sheet "${title}"`)
    return tab
  }

  function split(range: string): { tab: (typeof tabs)[number]; spec: string } {
    const trimmed = range.trim()
    const quoted = /^'((?:[^']|'')*)'!(.+)$/.exec(trimmed)
    if (quoted !== null) return { tab: tabByTitle(quoted[1].replace(/''/g, "'")), spec: quoted[2] }
    const bang = trimmed.indexOf("!")
    if (bang >= 0) return { tab: tabByTitle(trimmed.slice(0, bang)), spec: trimmed.slice(bang + 1) }
    // A range with no sheet name addresses the FIRST sheet — the same rule the stub documents.
    const first = tabs[0]
    if (first === undefined) throw googleLikeError(400, "spreadsheet has no sheets")
    return { tab: first, spec: trimmed }
  }

  function boxOf(spec: string, tab: { columns: number }): { fromRow: number; toRow: number; fromCol: number; toCol: number } {
    const rowBand = /^(\d+):(\d+)$/.exec(spec)
    if (rowBand !== null) {
      const [, start, end] = rowBand
      return { fromRow: Number(start), toRow: Number(end), fromCol: 1, toCol: tab.columns }
    }
    const cell = /^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?$/.exec(spec.toUpperCase())
    if (cell === null) throw googleLikeError(400, `Request contains an invalid argument: range "${spec}"`)
    const [, startCol, startRow, endCol, endRow] = cell
    if (startCol === undefined || startRow === undefined) {
      throw googleLikeError(400, `Request contains an invalid argument: range "${spec}"`)
    }
    return {
      fromRow: Number(startRow),
      toRow: endRow === undefined ? Number(startRow) : Number(endRow),
      fromCol: lettersToColumn(startCol),
      toCol: endCol === undefined ? lettersToColumn(startCol) : lettersToColumn(endCol),
    }
  }

  function resolve(range: string) {
    const { tab, spec } = split(range)
    return { tab, spec, ...boxOf(spec, tab) }
  }

  function windowOf(tab: { grid: string[][] }, row: number | undefined, fromCol: number, toCol: number): string[] {
    const cells = tab.grid[row === undefined ? -1 : row - 1]
    return Array.from({ length: toCol - fromCol + 1 }, (_, index) => cells?.[fromCol - 1 + index] ?? "")
  }

  /** Google's output rule: trailing empty rows excluded, then trailing empty columns excluded. */
  function trim(rows: string[][]): string[][] {
    const used = [...rows]
    while (used.length > 0 && used[used.length - 1] !== undefined && used[used.length - 1].every((cell) => cell === "")) {
      used.pop()
    }
    if (used.length === 0) return []
    let width = 0
    for (const row of used) {
      let last = row.length
      while (last > 0 && row[last - 1] === "") last -= 1
      width = Math.max(width, last)
    }
    return used.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""))
  }

  function lastContentRow(tab: { grid: string[][] }, fromCol: number, toCol: number): number {
    let last = 0
    tab.grid.forEach((row, index) => {
      if (!windowOf(tab, index + 1, fromCol, toCol).every((cell) => cell === "")) last = index + 1
    })
    return last
  }

  function rangeName(tab: { title: string }, fromRow: number, fromCol: number, toRow: number, toCol: number): string {
    return `${quoted(tab.title)}!${columnToLetters(fromCol)}${fromRow}:${columnToLetters(toCol)}${toRow}`
  }

  function quoted(title: string): string {
    return /[^A-Za-z0-9_]/.test(title) ? `'${title.replace(/'/g, "''")}'` : title
  }

  const api: SheetsApi = {
    spreadsheets: {
      async get(params) {
        guard()
        if (params.spreadsheetId !== input.spreadsheetId) {
          throw googleLikeError(404, "Requested entity was not found.")
        }
        return {
          data: {
            spreadsheetId: input.spreadsheetId,
            properties: { title: input.title },
            sheets: tabs.map((tab) => ({
              properties: {
                sheetId: tab.gid,
                title: tab.title,
                gridProperties: { rowCount: tab.rows, columnCount: tab.columns },
              },
            })),
          },
        }
      },

      async batchUpdate(params) {
        guard()
        if (params.spreadsheetId !== input.spreadsheetId) throw googleLikeError(404, "Requested entity was not found.")
        for (const request of params.requestBody.requests) {
          const range = request.deleteDimension?.range
          if (range === undefined) throw googleLikeError(400, "batchUpdate contains an unsupported request")
          const tab = tabs.find((candidate) => candidate.gid === range.sheetId)
          if (tab === undefined) throw googleLikeError(400, `Request contains an invalid argument: no sheet ${range.sheetId}`)
          if (range.dimension !== "ROWS") throw googleLikeError(400, "only ROWS deletion is supported")
          const start = range.startIndex ?? 0
          const end = range.endIndex ?? start
          tab.grid.splice(start, Math.max(0, end - start))
          tab.rows = Math.max(tab.grid.length, tab.rows - (end - start))
        }
        return { data: {} }
      },

      values: {
        async get(params) {
          guard()
          const target = resolve(params.range)
          const rows: string[][] = []
          for (let row = target.fromRow; row <= target.toRow; row += 1) {
            rows.push(windowOf(target.tab, row, target.fromCol, target.toCol))
          }
          return { data: { range: params.range, values: trim(rows) } }
        },

        async append(params) {
          guard()
          if (params.requestBody.values.length === 0) throw googleLikeError(400, "values must not be empty")
          const target = resolve(params.range)
          const { tab, fromCol } = target
          const width = params.requestBody.values.reduce((max, row) => Math.max(max, row.length), 0)
          const toCol = fromCol + width - 1
          const firstRow = Math.max(lastContentRow(tab, fromCol, toCol), target.fromRow - 1)

          params.requestBody.values.forEach((row, index) => {
            const cells = tab.grid[firstRow + index] ?? []
            row.forEach((cell, offset) => {
              cells[fromCol - 1 + offset] = cell
            })
            tab.grid[firstRow + index] = Array.from({ length: Math.max(cells.length, toCol) }, (_, i) => cells[i] ?? "")
          })
          tab.rows = Math.max(tab.rows, tab.grid.length)
          tab.columns = Math.max(tab.columns, toCol)

          return {
            data: {
              updates: {
                updatedRange: rangeName(tab, firstRow + 1, fromCol, firstRow + params.requestBody.values.length, toCol),
                updatedRows: params.requestBody.values.length,
              },
            },
          }
        },

        async update(params) {
          guard()
          const target = resolve(params.range)
          const { tab, fromRow, fromCol } = target
          const width = params.requestBody.values.reduce((max, row) => Math.max(max, row.length), 0)
          const toCol = fromCol + width - 1

          params.requestBody.values.forEach((row, index) => {
            const cells = tab.grid[fromRow - 1 + index] ?? []
            row.forEach((cell, offset) => {
              cells[fromCol - 1 + offset] = cell
            })
            tab.grid[fromRow - 1 + index] = Array.from({ length: Math.max(cells.length, toCol) }, (_, i) => cells[i] ?? "")
          })
          tab.rows = Math.max(tab.rows, fromRow - 1 + params.requestBody.values.length)
          tab.columns = Math.max(tab.columns, toCol)

          // Google echoes the requested notation: a single-cell `Data!B4` is not widened.
          const single = !target.spec.includes(":") && params.requestBody.values.length === 1 && width === 1
          return {
            data: {
              updatedRange: single
                ? `${quoted(tab.title)}!${columnToLetters(fromCol)}${fromRow}`
                : rangeName(tab, fromRow, fromCol, fromRow + params.requestBody.values.length - 1, toCol),
              updatedRows: params.requestBody.values.length,
            },
          }
        },
      },
    },
  }

  return {
    api,
    arm: (status: number) => {
      armed = status
    },
    grid: (title?: string) => (title === undefined ? tabs[0]?.grid ?? [] : tabByTitle(title).grid.map((row) => [...row])),
  }
}

function lettersToColumn(letters: string): number {
  let index = 0
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64)
  return index
}

function columnToLetters(index: number): string {
  let name = ""
  let rest = index
  while (rest > 0) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
    rest = Math.floor((rest - 1) / 26)
  }
  return name
}

/** One workbook description, fed to BOTH the stub and the Google-shaped sim. */
const FIXTURE_TABS: SheetTab[] = [
  { id: "0", title: "Data", rows: 100, columns: 3 },
  { id: "7", title: "My Tab", rows: 50, columns: 2 },
]
const FIXTURE_GRIDS: Record<string, string[][]> = {
  Data: [
    ["id", "name", "email"],
    ["1", "Ada", "ada@example.com"],
    ["2", "Grace", "grace@example.com"],
    ["3", "Alan", "alan@example.com"],
  ],
  "My Tab": [
    ["a", "b"],
    ["x", "y"],
  ],
}

function stubClient() {
  // `spreadsheetId` is deliberately NOT pinned: the stub reads it for the bound workbook but also
  // feeds `deleteRow`'s first argument (a gid, per `SheetsClient`) into the same check. The real
  // client keeps the workbook in its binding and the gid in that argument.
  return fakeSheets({ title: "Roster", tabs: FIXTURE_TABS, grids: FIXTURE_GRIDS })
}

function realClient() {
  const sim = googleLikeApi({
    spreadsheetId: SHEET_ID,
    title: "Roster",
    tabs: FIXTURE_TABS.map((tab) => ({ ...tab, grid: FIXTURE_GRIDS[tab.title]?.map((row) => [...row]) ?? [] })),
  })
  return { client: createSheetsClient(TOKEN, SHEET_ID, () => sim.api), sim }
}

/**
 * Reads are projected to `.values` only: the stub resolves `range` to the trimmed window while
 * Google echoes the requested range, and the engine must not depend on that string. Writes are
 * compared whole, `updatedRange` included, on quote-free tab names where both renderings agree.
 *
 * One documented non-parity: the stub also accepts a BARE TAB TITLE (`My Tab`) as a whole-sheet
 * read. That is a fixture convenience — Google requires `Tab!`, and this client never resolves tab
 * titles (no A1 parsing outside the SDK boundary). Both sides DO agree on a range with no sheet
 * name, which addresses the first sheet, so that is what the table asserts.
 */
const PARITY_STEPS: { label: string; run(client: SheetsClient): Promise<unknown> }[] = [
  {
    label: "spreadsheets.get tab snapshot",
    run: async (client) => {
      const meta = await client.getSpreadsheetMeta(SHEET_ID)
      return { title: meta.title, tabs: meta.tabs }
    },
  },
  { label: "cell box read", run: async (client) => (await client.getValues("Data!A1:C3")).values },
  { label: "quoted tab + row band read", run: async (client) => (await client.getValues("'My Tab'!2:2")).values },
  {
    label: "range with no sheet name addresses the first sheet",
    run: async (client) => (await client.getValues("A1:C3")).values,
  },
  { label: "read past the last row", run: async (client) => (await client.getValues("Data!A1:C10")).values },
  {
    label: "append lands below the table",
    run: async (client) => (await client.appendValues("Data!A1", [["4", "Newton", "n@example.com"]])).updatedRange,
  },
  { label: "grid after the append", run: async (client) => (await client.getValues("Data!A1:C10")).values },
  {
    label: "single-cell update keeps its notation",
    run: async (client) => (await client.updateValues("Data!B4", [["Alan T."]])).updatedRange,
  },
  {
    label: "multi-row update range",
    run: async (client) =>
      (await client.updateValues("Data!A6:C7", [
        ["7", "seven", "7@example.com"],
        ["8", "eight", "8@example.com"],
      ])).updatedRange,
  },
  { label: "grid after the updates", run: async (client) => (await client.getValues("Data!A1:C10")).values },
  { label: "deleteRow by gid", run: async (client) => client.deleteRow("0", "Data", 1) },
  { label: "grid after the delete", run: async (client) => (await client.getValues("Data!A1:C10")).values },
  { label: "delete a row of the second tab", run: async (client) => client.deleteRow("7", "My Tab", 0) },
  { label: "second tab after the delete", run: async (client) => (await client.getValues("'My Tab'!A1:B5")).values },
]

describe("stub ↔ real Sheets client contract parity", () => {
  it("the in-memory stub satisfies the SheetsClient interface unchanged", () => {
    // The assignment IS the proof: any field or arity drift in `SheetsClient` breaks this line.
    const stub: SheetsClient = stubClient()
    expect(typeof stub.getSpreadsheetMeta).toBe("function")
    expect(typeof stub.deleteRow).toBe("function")
  })

  it("answers the same call sequence with the same results", async () => {
    const stub = stubClient()
    const { client } = realClient()

    for (const step of PARITY_STEPS) {
      const stubResult = await step.run(stub)
      const realResult = await step.run(client)
      expect(realResult, `parity broke at: ${step.label}`).toEqual(stubResult)
    }
  })

  it("leaves both workbooks holding the same cells", async () => {
    const stub = stubClient()
    const { client, sim } = realClient()
    for (const step of PARITY_STEPS) {
      await step.run(stub)
      await step.run(client)
    }
    expect(sim.grid("Data")).toEqual(stub.dump("Data"))
    expect(sim.grid("My Tab")).toEqual(stub.dump("My Tab"))
  })

  it("collapses the stub's and Google's failures onto the same taxonomy row", async () => {
    const cases: { status: GoogleErrorStatus; kind: GoogleErrorKind; code: string }[] = [
      { status: "401", kind: "reauth", code: "google_reauth_required" },
      { status: "403", kind: "inaccessible", code: "google_sheet_inaccessible" },
      { status: "404", kind: "inaccessible", code: "google_sheet_inaccessible" },
      { status: "429", kind: "rate_limited", code: "rate_limited" },
    ]

    for (const { status, kind, code } of cases) {
      const numeric = Number(status)
      const stub = stubClient()
      stub.failNextWith(status)
      const { client, sim } = realClient()
      sim.arm(numeric)

      const stubError = await rejection(() => stub.getValues("Data!A1:C3"))
      const realError = await rejection(() => client.getValues("Data!A1:C3"))

      const classifiedStub = fromGoogleError(stubError)
      const classifiedReal = fromGoogleError(realError)
      expect(classifiedStub.kind, `kind for ${status}`).toBe(kind)
      expect(classifiedReal.kind, `kind for ${status}`).toBe(kind)
      expect(classifiedReal.status).toBe(classifiedStub.status)
      expect(classifiedReal.status).toBe(numeric)
      // The envelope callers hand back must be byte-identical, not merely equivalent.
      expect(googleActionError(realError)).toEqual(googleActionError(stubError))
      expect(googleActionError(realError).error.code).toBe(code)
    }
  })
})
