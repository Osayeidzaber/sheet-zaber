import "server-only"

import type { SheetTab } from "@/server/google/sheets"

import type { EngineRecord, EngineRow, EngineTable } from "./types"

/*
 * Grid → record projection (`backend-api-contract.md` §1.3, §1.5; `architecture.md` §3).
 *
 * Everything in this file is pure: a `string[][]` of cell text in, a table/record/A1 band out.
 * No DB, no Google, no envelope — which is what lets `tests/engine-core.test.ts` pin the semantics
 * that §1.5 promises without a spreadsheet in sight.
 *
 * Two invariants hold the whole engine together:
 *   - `gridRow` is the ONLY way a row is addressed internally, and it never leaves this module
 *     toward a response body (§1.5: "Row numbers are never exposed");
 *   - the header row supplies the object keys, so an empty header cell becomes `column_N`
 *     (N = 1-based column position). `headerKeys` is reimplemented here on purpose — the test
 *     helper has the same rule, and production must not import from `tests/`.
 */

/* ---------------------------------------------------------------- grid → table */

/** §1.5 / architecture.md §3: an empty (or whitespace-only) header cell is still a column. */
export function headerKeys(header: string[]): string[] {
  return header.map((cell, index) => (cell.trim() === "" ? `column_${index + 1}` : cell))
}

export function isBlankRow(row: string[] | undefined): boolean {
  return row === undefined || row.every((cell) => cell.trim() === "")
}

/**
 * Whole-tab grid → `EngineTable`.
 *
 * - `headers` are the cells of grid row `headerRow`, keyed through `headerKeys`;
 * - `rows` are every grid row STRICTLY BELOW the header that is not entirely blank, each keeping
 *   its true 1-based `gridRow` (the whole-tab read starts at row 1, so array index + 1 is the
 *   grid row — a blank row in the middle still occupies its own row number);
 * - rows ABOVE the header are ignored, because a sheet may open with title rows;
 * - cells are padded with `""` to the header width and truncated past it, so a record always has
 *   exactly one value per header key.
 */
export function buildTable(values: string[][], headerRow: number, tab: SheetTab): EngineTable {
  const headerCells = values[headerRow - 1] ?? []
  const headers = headerKeys(headerCells)
  const rows: EngineRow[] = []

  for (let index = headerRow; index < values.length; index += 1) {
    const cells = values[index]
    if (isBlankRow(cells)) continue
    rows.push({ gridRow: index + 1, record: recordFromCells(headers, cells ?? []) })
  }

  return { headers, rows, tab }
}

/** Header keys are the record's keys, in header order; a missing cell is `""`. */
export function recordFromCells(headers: string[], cells: string[]): EngineRecord {
  const record: EngineRecord = {}
  headers.forEach((key, index) => {
    record[key] = cells[index] ?? ""
  })
  return record
}

/** The inverse: a record → header-width cells, in header order. */
export function cellsFromRecord(headers: string[], record: EngineRecord): string[] {
  return headers.map((key) => record[key] ?? "")
}

export function columnIndexOf(headers: string[], key: string): number {
  return headers.indexOf(key)
}

/**
 * Row lookup by primary-key VALUE (§1.5: `{record}` is always the PK value, never a row number).
 * `String(cell)` is the comparison the contract describes, so a numeric-looking cell matches the
 * textual segment the client sent.
 */
export function findRowsByPrimaryKey(table: EngineTable, column: string, value: string): EngineRow[] {
  return table.rows.filter((row) => String(row.record[column] ?? "") === value)
}

/* ---------------------------------------------------------------- value stringification */

/**
 * Cell text for a JSON value (§1.3 Create). `null`/`undefined` are empty cells and a nested
 * object/array is stored as its JSON text.
 *
 * A boolean becomes `"true"`/`"false"` on the way in; because the append uses
 * `valueInputOption: "RAW"`, Google re-reads those two strings as a real boolean cell and the
 * next read renders them back as `"TRUE"`/`"FALSE"` (`sheets.ts:cellText`). That round-trip
 * asymmetry is Google's, not ours: the engine never invents the uppercase form on a write.
 */
export function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  return JSON.stringify(value) ?? ""
}

/* ---------------------------------------------------------------- A1 grammar */

/**
 * An A1 band as the CLIENT spelled it: absent `start*` is row/column 1, absent `end*` is
 * open-ended and takes the tab's own extent. `sheet` is the `Sheet!` prefix when spelled.
 */
export type A1Band = {
  sheet: string | null
  startCol: number
  startRow: number
  endCol: number | undefined
  endRow: number | undefined
}

/** A band after `resolveBand`: every edge is a concrete in-bounds number. */
export type ResolvedBand = {
  sheet: string | null
  startCol: number
  startRow: number
  endCol: number
  endRow: number
}

const COLUMN_TOKEN = /^([A-Za-z]{1,3})$/
const ROW_TOKEN = /^([1-9][0-9]*)$/

/** `A1`, `$A$1`, `AB12`; `server-only` keeps this module off the client bundle. */
const CELL_TOKEN = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)$/

/**
 * One corner of a band. A spelled-out half-corner (`A`, a whole column, or `3`, a whole row) is
 * the form Google accepts in a range, so it is accepted here; anything else (a stray `$`, `0`,
 * a 4-letter column, junk) is not a corner at all.
 */
function parseCorner(token: string): { col?: number; row?: number } | null {
  const text = token.trim()
  if (text === "") return {}
  const cell = CELL_TOKEN.exec(text)
  if (cell !== null) return { col: columnIndex(cell[1]), row: Number(cell[2]) }
  if (/\$$/.test(text)) return null
  const column = COLUMN_TOKEN.exec(text)
  if (column !== null) return { col: columnIndex(column[1]) }
  const row = ROW_TOKEN.exec(text)
  if (row !== null) return { row: Number(row[1]) }
  return null
}

function unquoteSheetPart(part: string): string {
  const text = part.trim()
  if (text.startsWith("'") && text.endsWith("'") && text.length > 1) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/**
 * Validate the A1 text for `GET /{api}/range/{A1}` (§1.3).
 *
 * This is the engine's OWN grammar, deliberately stricter than the stub's forgiving parser: an
 * explicitly spelled open corner (`A1:D`, `2:4`, `A`) is allowed, a corner that only *looks*
 * spelled (`:`, `A1:`, `$`, `1A`) is refused, because Google refuses it too. Bounds are NOT
 * checked here — `resolveBand` does that against the tab.
 */
export function parseBand(a1: string): A1Band | null {
  const text = a1.trim()
  if (text === "") return null

  const bang = text.indexOf("!")
  const sheet = bang >= 0 ? unquoteSheetPart(text.slice(0, bang)) : null
  const body = bang >= 0 ? text.slice(bang + 1) : text
  if (bang >= 0 && (sheet === null || sheet === "")) return null

  const parts = body.split(":")
  if (parts.length > 2) return null
  // An empty side of an explicit `:` (`:B2`, `A1:`) is a range Google refuses to parse, so refuse it.
  if (parts.length === 2 && (parts[0].trim() === "" || parts[1].trim() === "")) return null

  const start = parseCorner(parts[0])
  const second = parts.length === 2 ? parseCorner(parts[1]) : start
  if (start === null || second === null) return null
  // `:` between two nothing-corners cannot happen above, but a spelled end with neither column nor
  // row would silently mean "whole tab", so it stays a rejection.
  if (second.col === undefined && second.row === undefined) return null

  return {
    sheet,
    startCol: start.col ?? 1,
    startRow: start.row ?? 1,
    endCol: second.col,
    endRow: second.row,
  }
}

/**
 * Clamp a parsed band to the tab and check it fits (§1.3 "bounds check against tab size").
 * `null` means "outside the grid", which the engine reports as `400 invalid_range`.
 * `sheetPart`, when spelled, must equal the configured tab title exactly.
 */
export function resolveBand(band: A1Band, tab: SheetTab, tabTitle: string): ResolvedBand | null {
  if (band.sheet !== null && band.sheet !== tabTitle) return null
  if (band.startCol < 1 || band.startRow < 1) return null
  if (tab.rows < 1 || tab.columns < 1) return null

  const endCol = band.endCol ?? tab.columns
  const endRow = band.endRow ?? tab.rows
  if (endCol > tab.columns || endRow > tab.rows) return null
  if (band.startCol > endCol || band.startRow > endRow) return null

  return { sheet: band.sheet, startCol: band.startCol, startRow: band.startRow, endCol, endRow }
}

/**
 * The band's cells out of the raw grid, as a rectangle (`""` where the grid has no cell).
 *
 * The real `values.get` trims trailing EMPTY rows from its answer; the engine answers a range
 * with the requested rectangle instead, so `data.rows.length` is always the band's height. That
 * is a documented difference from a raw Google read — the client asked for a shape and gets it.
 */
export function bandCells(values: string[][], band: ResolvedBand): string[][] {
  const rows: string[][] = []
  for (let row = band.startRow; row <= band.endRow; row += 1) {
    const cells: string[] = []
    for (let col = band.startCol; col <= band.endCol; col += 1) {
      cells.push(values[row - 1]?.[col - 1] ?? "")
    }
    rows.push(cells)
  }
  return rows
}

/** The band's own header keys: the configured header row, restricted to (and padded across) the band. */
export function bandHeaders(values: string[][], headerRow: number, band: ResolvedBand): string[] {
  const cells: string[] = []
  for (let col = band.startCol; col <= band.endCol; col += 1) {
    cells.push(values[headerRow - 1]?.[col - 1] ?? "")
  }
  return headerKeys(cells)
}

/* ---------------------------------------------------------------- column maths + refs */

/** 1-based column index → letters (26 → `Z`, 27 → `AA`). */
export function columnName(index: number): string {
  let name = ""
  let rest = index
  while (rest > 0) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
    rest = Math.floor((rest - 1) / 26)
  }
  return name
}

/** Letters → 1-based column index; anything unparseable is column 0, which no range can use. */
export function columnIndex(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return 0
  let index = 0
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64)
  return index
}

/** A1 quoting: anything outside `[A-Za-z0-9_]` needs single quotes, and `'` doubles. */
export function quotedTabName(tabTitle: string): string {
  return /[^A-Za-z0-9_]/.test(tabTitle) ? `'${tabTitle.replace(/'/g, "''")}'` : tabTitle
}

/** `'My Tab'!B4:D4` — a horizontal span on one grid row, which is what every write aims at. */
export function rowSpanRef(tabTitle: string, gridRow: number, startCol: number, endCol: number): string {
  return `${quotedTabName(tabTitle)}!${columnName(startCol)}${gridRow}:${columnName(endCol)}${gridRow}`
}

/** The whole-tab read ref (§1.3 "One `getValues("<Tab>")` whole-tab read"). */
export function tabRef(tabTitle: string): string {
  return quotedTabName(tabTitle)
}

/**
 * Contiguous ascending runs of 1-based column indices, in ascending order (§1.3 Update:
 * "`values.update` per contiguous span"). `[1,2,3,5]` → `[[1,3],[5,5]]` → two update calls.
 */
export function columnRuns(indices: number[]): Array<{ startCol: number; endCol: number }> {
  const sorted = [...new Set(indices)].sort((a, b) => a - b)
  const runs: Array<{ startCol: number; endCol: number }> = []
  for (const index of sorted) {
    const last = runs[runs.length - 1]
    if (last !== undefined && index === last.endCol + 1) {
      last.endCol = index
    } else {
      runs.push({ startCol: index, endCol: index })
    }
  }
  return runs
}
