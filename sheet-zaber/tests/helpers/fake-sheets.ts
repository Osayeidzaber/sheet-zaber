/*
 * In-memory stand-in for the Google Sheets v4 surface the engine uses
 * (google-integration.md §4). No `googleapis` import: the dependency is deliberately
 * absent until Phase 4, and Phase 4 re-implements this exact interface over the real
 * client — so engine tests must not be able to tell the difference.
 *
 * Ranges are 1-based A1 notation as Google reads them: `Tab!A1:C3`,
 * `'My Tab'!A1` (quotes escaped by doubling), `Tab` (whole sheet), `A1:C` (open-ended),
 * `2:4` (row band). Reads trim trailing empty rows/columns, `appendValues` lands below
 * the last row holding data in the append columns, and `deleteRow` takes the 0-based
 * index that `batchUpdate.deleteDimension` uses.
 */

export type SheetTab = { id: string; title: string; rows: number; columns: number }

export type GoogleErrorStatus = "401" | "403" | "404" | "429"

export type SpreadsheetMeta = { spreadsheetId: string; title: string; tabs: SheetTab[] }
export type ValuesResult = { range: string; values: string[][] }
export type WriteResult = { updatedRange: string; updatedRows: number }

export type SheetsStub = {
  getSpreadsheetMeta(spreadsheetId: string): Promise<SpreadsheetMeta>
  getValues(ref: string): Promise<ValuesResult>
  appendValues(ref: string, rows: string[][]): Promise<WriteResult>
  updateValues(ref: string, values: string[][]): Promise<WriteResult>
  deleteRow(sheetId: string, tabTitle: string, rowIndex: number): Promise<void>
  /** Arms a one-shot Google error, thrown by the next call before it touches state. */
  failNextWith(status: GoogleErrorStatus): void
  /** Local state for assertions; a deep copy, so tests cannot corrupt the fixture. */
  dump(tabTitle?: string): string[][]
}

export type SheetsStubOptions = {
  spreadsheetId?: string
  title?: string
  tabs?: SheetTab[]
  /** Grid for the first tab. */
  values?: string[][]
  /** Grids for any tab, keyed by title; the tab is auto-declared when missing. */
  grids?: Record<string, string[][]>
  failNextWith?: GoogleErrorStatus
}

const DEFAULT_TAB_TITLE = "Sheet1"
const DEFAULT_TAB: SheetTab = { id: "0", title: DEFAULT_TAB_TITLE, rows: 100, columns: 26 }
const DEFAULT_VALUES = [
  ["id", "name", "email"],
  ["1", "Ada", "ada@example.com"],
  ["2", "Grace", "grace@example.com"],
]

const GOOGLE_ERROR_MESSAGES: Record<GoogleErrorStatus, string> = {
  "401": "Invalid Credentials",
  "403": "The caller does not have permission",
  "404": "Requested entity was not found.",
  "429": "Quota exceeded for quota metric 'Requests'.",
}

export class SheetsStubError extends Error {
  readonly status: GoogleErrorStatus
  /** Mirrors `googleapis`' `GoogleError.code` (HTTP status) so the engine can branch on it. */
  readonly code: number

  constructor(status: GoogleErrorStatus, detail: string) {
    super(`${GOOGLE_ERROR_MESSAGES[status]} [${status}] ${detail}`)
    this.name = "SheetsStubError"
    this.status = status
    this.code = Number(status)
  }
}

/**
 * google-integration.md §4: the header row supplies object keys and an empty header
 * cell becomes `column_N`, N being the 1-based column position.
 */
export function headerKeys(header: string[]): string[] {
  return header.map((cell, index) => (cell.trim() === "" ? `column_${index + 1}` : cell))
}

function columnIndex(letters: string): number {
  let index = 0
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64)
  return index
}

function columnName(index: number): string {
  let name = ""
  let rest = index
  while (rest > 0) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
    rest = Math.floor((rest - 1) / 26)
  }
  return name
}

type Corner = { row?: number; col?: number }

function parseCorner(token: string): Corner {
  const match = /^\$?(?:([A-Za-z]{1,3})\$?)?(\d+)?$/.exec(token.trim())
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new Error(`Unparsable A1 cell: "${token}"`)
  }
  return {
    col: match[1] === undefined ? undefined : columnIndex(match[1]),
    row: match[2] === undefined ? undefined : Number(match[2]),
  }
}

/** `Tab1` is both a legal cell and a legal sheet title, so known titles win. */
function splitRef(ref: string, isTabTitle: (name: string) => boolean): { tabTitle?: string; a1?: string } {
  const trimmed = ref.trim()
  const quoted = /^'((?:[^']|'')*)'!(.+)$/.exec(trimmed)
  if (quoted) return { tabTitle: quoted[1].replace(/''/g, "'"), a1: quoted[2] }

  const bang = trimmed.indexOf("!")
  if (bang >= 0) return { tabTitle: trimmed.slice(0, bang).replace(/^'|'$/g, ""), a1: trimmed.slice(bang + 1) }
  if (isTabTitle(trimmed)) return { tabTitle: trimmed }
  return { a1: trimmed }
}

function parseA1(a1: string): { start: Corner; end: Corner } {
  const parts = a1.split(":")
  if (parts.length > 2) throw new Error(`Unparsable A1 range: "${a1}"`)
  const start = parseCorner(parts[0])
  // `A1` alone is one cell; `A` alone is a whole column, so its row stays open.
  return { start, end: parts.length === 2 ? parseCorner(parts[1]) : start }
}

function windowOf(row: string[] | undefined, startCol: number, endCol: number): string[] {
  return Array.from({ length: endCol - startCol + 1 }, (_, i) => row?.[startCol - 1 + i] ?? "")
}

function isBlank(row: string[]): boolean {
  return row.every((cell) => cell === "")
}

function lastContentRow(grid: string[][], startCol: number, endCol: number): number {
  return grid.reduce((max, row, i) => (isBlank(windowOf(row, startCol, endCol)) ? max : i + 1), 0)
}

/** Drops trailing empty rows and the trailing empty columns the way `values.get` does. */
function trim(rows: string[][]): string[][] {
  const used = [...rows]
  while (used.length > 0 && isBlank(used[used.length - 1])) used.pop()
  if (used.length === 0) return []
  const width = used.reduce((max, row) => {
    let last = row.length
    while (last > 0 && row[last - 1] === "") last--
    return Math.max(max, last)
  }, 0)
  return used.map((row) => windowOf(row, 1, width))
}

function padTo(row: string[] | undefined, width: number): string[] {
  return windowOf(row, 1, width)
}

export function fakeSheets(opts: SheetsStubOptions = {}): SheetsStub {
  const title = opts.title ?? "Smoke Sheet"
  const fixedSpreadsheetId = opts.spreadsheetId
  // `grids` describes the whole workbook: an undeclared default tab would show up in
  // `getSpreadsheetMeta().tabs` as a sheet the caller never asked for.
  const explicitGrids = opts.grids !== undefined && Object.keys(opts.grids).length > 0
  const tabs: SheetTab[] = (opts.tabs ?? (explicitGrids ? [] : [DEFAULT_TAB])).map((tab) => ({ ...tab }))
  const grids = new Map<string, string[][]>(tabs.map((tab) => [tab.title, []]))

  function declare(name: string, rows: string[][]) {
    grids.set(name, rows.map((row) => [...row]))
    if (!tabs.some((tab) => tab.title === name)) {
      const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
      tabs.push({
        id: String(tabs.length),
        title: name,
        rows: Math.max(rows.length, 1),
        columns: Math.max(width, 1),
      })
    }
  }

  for (const [name, rows] of Object.entries(opts.grids ?? {})) declare(name, rows)
  if (opts.values) declare(tabs[0].title, opts.values)
  if (!explicitGrids && opts.values === undefined && opts.tabs === undefined) {
    declare(tabs[0].title, DEFAULT_VALUES)
  }

  let armed: GoogleErrorStatus | undefined = opts.failNextWith

  function throwIfArmed(method: string, target: string) {
    if (!armed) return
    const status = armed
    armed = undefined
    throw new SheetsStubError(status, `${method} ${target}`)
  }

  function checkSpreadsheet(spreadsheetId: string, method: string) {
    if (fixedSpreadsheetId !== undefined && spreadsheetId !== fixedSpreadsheetId) {
      throw new SheetsStubError("404", `${method} spreadsheet ${spreadsheetId} is not this sheet`)
    }
  }

  function tabFor(tabTitle: string): SheetTab {
    const tab = tabs.find((candidate) => candidate.title === tabTitle)
    if (!tab) throw new SheetsStubError("404", `tab ${tabTitle} does not exist`)
    return tab
  }

  function gridFor(tabTitle: string): string[][] {
    const grid = grids.get(tabTitle)
    if (!grid) throw new SheetsStubError("404", `tab ${tabTitle} does not exist`)
    return grid
  }

  function resolve(ref: string) {
    const { tabTitle, a1 } = splitRef(ref, (name) => grids.has(name))
    const name = tabTitle ?? tabs[0].title
    const tab = tabFor(name)
    const grid = gridFor(name)
    const parsed = a1 === undefined ? { start: {}, end: {} } : parseA1(a1)
    const contentRows = Math.max(grid.length, lastContentRow(grid, 1, tab.columns))

    return {
      a1,
      grid,
      name,
      tab,
      startRow: parsed.start.row ?? 1,
      startCol: parsed.start.col ?? 1,
      endRow: parsed.end.row ?? contentRows,
      endCol: parsed.end.col ?? Math.max(tab.columns, 1),
    }
  }

  function quotedName(tabTitle: string): string {
    return /[^A-Za-z0-9_]/.test(tabTitle) ? `'${tabTitle.replace(/'/g, "''")}'` : tabTitle
  }

  function rangeName(tabTitle: string, startRow: number, startCol: number, endRow: number, endCol: number): string {
    return `${quotedName(tabTitle)}!${columnName(startCol)}${startRow}:${columnName(endCol)}${endRow}`
  }

  return {
    async getSpreadsheetMeta(spreadsheetId) {
      throwIfArmed("getSpreadsheetMeta", spreadsheetId)
      checkSpreadsheet(spreadsheetId, "getSpreadsheetMeta")
      return {
        spreadsheetId: fixedSpreadsheetId ?? spreadsheetId,
        title,
        tabs: tabs.map((tab) => ({ ...tab })),
      }
    },

    async getValues(ref) {
      throwIfArmed("getValues", ref)
      const r = resolve(ref)
      const served = trim(r.grid.slice(r.startRow - 1, r.endRow).map((row) => windowOf(row, r.startCol, r.endCol)))
      return {
        range:
          served.length === 0
            ? rangeName(r.name, r.startRow, r.startCol, r.endRow, r.endCol)
            : rangeName(r.name, r.startRow, r.startCol, r.startRow + served.length - 1, r.startCol + served[0].length - 1),
        values: served,
      }
    },

    async appendValues(ref, rows) {
      throwIfArmed("appendValues", ref)
      if (rows.length === 0) throw new Error("appendValues needs at least one row")
      const r = resolve(ref)
      const startCol = r.startCol
      const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
      const endCol = startCol + width - 1
      const firstRow = Math.max(lastContentRow(r.grid, startCol, endCol), r.a1 === undefined ? 0 : r.startRow - 1)

      rows.forEach((row, index) => {
        const target = r.grid[firstRow + index] ?? []
        row.forEach((cell, offset) => {
          target[startCol - 1 + offset] = cell
        })
        r.grid[firstRow + index] = padTo(target, Math.max(target.length, endCol))
      })
      r.tab.rows = Math.max(r.tab.rows, r.grid.length)
      r.tab.columns = Math.max(r.tab.columns, endCol)

      return { updatedRange: rangeName(r.name, firstRow + 1, startCol, firstRow + rows.length, endCol), updatedRows: rows.length }
    },

    async updateValues(ref, values) {
      throwIfArmed("updateValues", ref)
      const r = resolve(ref)
      const range = r.a1 === undefined ? undefined : parseA1(r.a1)
      if (range === undefined || range.start.row === undefined) {
        throw new Error(`updateValues needs a start row in the range, got "${ref}"`)
      }
      const startRow = range.start.row
      const startCol = range.start.col ?? 1
      const width = values.reduce((max, row) => Math.max(max, row.length), 0)
      if (range.end.col !== undefined && range.end.col - startCol + 1 < width) {
        throw new Error(`values are wider than the range "${ref}"`)
      }
      const endCol = startCol + width - 1

      values.forEach((row, index) => {
        const target = r.grid[startRow - 1 + index] ?? []
        row.forEach((cell, offset) => {
          target[startCol - 1 + offset] = cell
        })
        r.grid[startRow - 1 + index] = padTo(target, Math.max(target.length, endCol))
      })
      r.tab.rows = Math.max(r.tab.rows, startRow - 1 + values.length)
      r.tab.columns = Math.max(r.tab.columns, endCol)

      // Google echoes the requested notation: a single-cell `Sheet1!B4` stays a
      // single-cell `updatedRange`, it is not widened to `Sheet1!B4:B4`.
      const singleCell = r.a1 !== undefined && !r.a1.includes(":") && values.length === 1 && width === 1
      return {
        updatedRange: singleCell
          ? `${quotedName(r.name)}!${columnName(startCol)}${startRow}`
          : rangeName(r.name, startRow, startCol, startRow + values.length - 1, endCol),
        updatedRows: values.length,
      }
    },

    async deleteRow(sheetId, tabTitle, rowIndex) {
      throwIfArmed("deleteRow", `${tabTitle}!${rowIndex}`)
      checkSpreadsheet(sheetId, "deleteRow")
      const tab = tabFor(tabTitle)
      const grid = gridFor(tabTitle)
      if (rowIndex < 0 || rowIndex >= grid.length) {
        throw new SheetsStubError("404", `deleteRow row index ${rowIndex} is out of range`)
      }
      grid.splice(rowIndex, 1)
      tab.rows = Math.max(grid.length, tab.rows - 1)
    },

    failNextWith(status) {
      armed = status
    },

    dump(tabTitle) {
      return gridFor(tabTitle ?? tabs[0].title).map((row) => [...row])
    },
  }
}
