import "server-only"

import { fail, type ActionError } from "@/lib/action-result"

import type { EngineRecord, EngineRow, EngineTable } from "./types"

/*
 * List/search query semantics (`backend-api-contract.md` §1.3), pure and total:
 * `parseListQuery` turns a `URLSearchParams` into a plan or a §1.2 `validation_failed` envelope,
 * `applyListQuery` runs the plan. Pipeline order is the contract:
 *
 *     filter  →  sort  →  page  →  (fields projected by the caller, AFTER filtering)
 *
 * Every rejected input names the offending query parameter in `fields`, so a client can highlight
 * it without guessing which key the engine tripped on.
 */

export type FilterOperator = "eq" | "contains" | "gt" | "gte" | "lt" | "lte"

export type FilterSpec = { column: string; operator: FilterOperator; value: string; raw: string }
export type SortSpec = { column: string; desc: boolean }

export type ListQuery = {
  /** Requested page size; `null` = "all rows" (`meta.limit` is null too). */
  limit: number | null
  /** Effective offset AFTER the `page`/`per_page` translation. */
  offset: number
  sorts: SortSpec[]
  /** `null` = every column; projection happens after filtering. */
  fields: string[] | null
  filters: FilterSpec[]
  /** `/search` term (also settable as `?q=` on the list route); `null` when absent. */
  q: string | null
}

/** Reserved names, so they can never be read as a column filter (§1.3). */
const RESERVED = new Set(["limit", "offset", "page", "per_page", "sort", "order", "fields", "select", "q"])

const OPERATORS: [string, FilterOperator][] = [
  ["__contains", "contains"],
  ["__gte", "gte"],
  ["__gt", "gt"],
  ["__lte", "lte"],
  ["__lt", "lt"],
]

const MAX_LIMIT = 1000

function invalidParam(name: string, message: string): ActionError {
  return fail("validation_failed", "One or more query parameters are not valid.", "validation", {
    [name]: message,
  })
}

/**
 * Integers are parsed by hand, never with `Number()`: `"1.5"`, `"1e3"`, `" 7"`, `""` and `"+1"`
 * are all rejected, so a typo in `limit` cannot silently become a different page size.
 */
function parseInteger(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null
}

function wholeColumn(name: string, headers: string[]): string | null {
  return headers.includes(name) ? name : null
}

function sortSpec(raw: string, headers: string[], param: string): SortSpec | ActionError {
  const text = raw.trim()
  const desc = text.startsWith("-")
  const column = desc ? text.slice(1) : text
  if (column === "") {
    return invalidParam(param, `\`${param}\` must name a column, optionally prefixed with "-" for descending order.`)
  }
  if (!headers.includes(column)) {
    return invalidParam(param, `Unknown column "${column}" in \`${param}\`. Available columns: ${headers.join(", ")}.`)
  }
  return { column, desc }
}

function fieldList(raw: string, headers: string[], param: string): string[] | ActionError {
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")

  const unknown = names.filter((name) => !headers.includes(name))
  if (unknown.length > 0) {
    return invalidParam(
      param,
      `Unknown column(s) ${[...new Set(unknown)].sort().join(", ")} in \`${param}\`. Available columns: ${headers.join(", ")}.`
    )
  }
  // Deduplicated in first-mention order, so `?fields=b,a,b` answers `{b,a}`.
  return [...new Set(names)]
}

function filterSpec(
  param: string,
  value: string,
  headers: string[]
): FilterSpec | ActionError {
  for (const [suffix, operator] of OPERATORS) {
    if (!param.endsWith(suffix)) continue
    const column = param.slice(0, -suffix.length)
    if (column === "" || !wholeColumn(column, headers)) {
      return invalidParam(
        param,
        `Unknown column "${column}" in \`${param}\`. Available columns: ${headers.join(", ")}.`
      )
    }
    return { column, operator, value, raw: param }
  }

  if (!wholeColumn(param, headers)) {
    return invalidParam(
      param,
      `Unknown column "${param}". Available columns: ${headers.join(", ")}.`
    )
  }
  return { column: param, operator: "eq", value, raw: param }
}

/**
 * Parse every §1.3 query parameter.
 *
 * Rules the parser owns (and `tests/engine-core.test.ts` pins):
 * - `limit` is an integer 1…1000 (absent = all rows); `offset` is an integer ≥ 0.
 * - `page` + `per_page` is the alternative pagination: `offset = (page - 1) * per_page`.
 *   Mixing `offset` with `page`, or `limit` with `per_page`, is a 400 — two answers for one thing.
 *   `page` needs a page size from `per_page` (or `limit`), or the window is undefined.
 * - `sort` and `order` are aliases and both repeatable; each value is `col` or `-col`.
 * - `fields`/`select` are aliases; projection happens after filtering.
 * - `q` is `/search` in one parameter.
 * - any other parameter is a filter, exact and case-sensitive, optionally with `__contains`,
 *   `__gt`, `__gte`, `__lt`, `__lte`. A repeated parameter ANDs.
 *   The operator suffix is matched FIRST, so a header actually named `price__gt` is reachable only
 *   as `price__gt=…` read on column `price` — a grammar precedence, not a bug to discover later.
 */
export function parseListQuery(query: URLSearchParams, headers: string[]): ListQuery | ActionError {
  let limit: number | null = null
  let offset = 0
  let page: number | null = null
  let perPage: number | null = null

  for (const [name, text] of pairs(query)) {
    if (name === "limit") {
      const value = parseInteger(text)
      if (value === null || value < 1 || value > MAX_LIMIT) {
        return invalidParam("limit", `limit must be a whole number from 1 to ${MAX_LIMIT}.`)
      }
      limit = value
    } else if (name === "offset") {
      const value = parseInteger(text)
      if (value === null || value < 0) {
        return invalidParam("offset", "offset must be a whole number of 0 or greater.")
      }
      offset = value
    } else if (name === "page") {
      const value = parseInteger(text)
      if (value === null || value < 1) {
        return invalidParam("page", "page must be a whole number of 1 or greater.")
      }
      page = value
    } else if (name === "per_page") {
      const value = parseInteger(text)
      if (value === null || value < 1 || value > MAX_LIMIT) {
        return invalidParam("per_page", `per_page must be a whole number from 1 to ${MAX_LIMIT}.`)
      }
      perPage = value
    }
  }

  if (page !== null && query.getAll("offset").length > 0) {
    return invalidParam("offset", "offset and page cannot be combined — choose one pagination style.")
  }
  if (limit !== null && perPage !== null) {
    return invalidParam("per_page", "limit and per_page cannot be combined — choose one page size.")
  }
  if (perPage !== null) limit = perPage
  if (page !== null) {
    if (limit === null) {
      return invalidParam("per_page", "page needs a page size: send per_page (or limit) with it.")
    }
    offset = (page - 1) * limit
  }

  const sorts: SortSpec[] = []
  for (const name of ["sort", "order"] as const) {
    for (const raw of query.getAll(name)) {
      const spec = sortSpec(raw, headers, name)
      if ("error" in spec) return spec
      sorts.push(spec)
    }
  }

  let fields: string[] | null = null
  for (const name of ["fields", "select"] as const) {
    const raw = query.get(name)
    if (raw === null) continue
    const list = fieldList(raw, headers, name)
    if ("error" in list) return list
    fields = list
  }

  const qText = query.get("q")
  const q = qText === null || qText.trim() === "" ? null : qText

  const filters: FilterSpec[] = []
  for (const [name, value] of pairs(query)) {
    if (RESERVED.has(name)) continue
    const spec = filterSpec(name, value, headers)
    if ("error" in spec) return spec
    filters.push(spec)
  }

  return { limit, offset, sorts, fields, filters, q }
}

/** Every `(name, value)` pair in insertion order, repeated keys included. */
function pairs(query: URLSearchParams): Array<[string, string]> {
  const out: Array<[string, string]> = []
  query.forEach((value, name) => out.push([name, value]))
  return out
}

/* ---------------------------------------------------------------- comparison */

function asFiniteNumber(text: string): number | null {
  if (text.trim() === "") return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/**
 * THE comparison rule for every `gt/gte/lt/lte` filter and every `sort` (§1.3):
 *
 *   **when BOTH sides parse as finite numbers they compare numerically, otherwise they compare
 *   as strings on UTF-16 code units.**
 *
 * This will surprise a reader, so it is spelled out:
 * - `"10" > "9"` is FALSE as a string (code unit `"1"` < `"9"`) and TRUE numerically. A column
 *   that is numeric except for one typo row therefore sorts that row and its neighbours by string
 *   order — `"10"` and `"9"` swap places the moment one cell becomes `"1 0"`.
 * - Mixed text never throws: `"Alpha" < "alpha"` (uppercase sorts first) and `"Z" > "a"` are both
 *   true, because code units are not locale order.
 * - Empty cells compare as `""`: numerically absent, so they sort below any text and above nothing.
 */
export function compareCells(a: string, b: string): number {
  const left = asFiniteNumber(a)
  const right = asFiniteNumber(b)
  if (left !== null && right !== null) return left === right ? 0 : left < right ? -1 : 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

function matchesFilter(record: EngineRecord, filter: FilterSpec): boolean {
  const cell = record[filter.column] ?? ""
  switch (filter.operator) {
    case "eq":
      return cell === filter.value
    case "contains":
      return cell.includes(filter.value)
    case "gt":
      return compareCells(cell, filter.value) > 0
    case "gte":
      return compareCells(cell, filter.value) >= 0
    case "lt":
      return compareCells(cell, filter.value) < 0
    case "lte":
      return compareCells(cell, filter.value) <= 0
  }
}

/** Case-INSENSITIVE substring across every column (`/search`), unlike `__contains`. */
export function matchesSearch(row: EngineRow, term: string): boolean {
  const needle = term.toLowerCase()
  return Object.values(row.record).some((cell) => cell.toLowerCase().includes(needle))
}

/** Multi-key sort; `V8`'s `Array#sort` is stable, so equal rows keep grid order. */
export function sortRows(rows: EngineRow[], sorts: SortSpec[]): EngineRow[] {
  if (sorts.length === 0) return rows
  return [...rows].sort((left, right) => {
    for (const sort of sorts) {
      const order = compareCells(left.record[sort.column] ?? "", right.record[sort.column] ?? "")
      if (order !== 0) return sort.desc ? -order : order
    }
    return 0
  })
}

/**
 * Filter → sort → page. Paging is `meta.count`'s definition: the number returned is the number
 * the client asked for, never the number of rows that exist.
 *
 * `fields` is NOT applied here — the caller projects AFTER filtering, and the record it returns
 * still carries every column until that moment.
 */
export function applyListQuery(table: EngineTable, query: ListQuery): EngineRow[] {
  let rows = table.rows

  if (query.filters.length > 0) {
    rows = rows.filter((row) => query.filters.every((filter) => matchesFilter(row.record, filter)))
  }
  if (query.q !== null) {
    const term = query.q
    rows = rows.filter((row) => matchesSearch(row, term))
  }
  rows = sortRows(rows, query.sorts)

  if (query.offset > 0) rows = rows.slice(query.offset)
  if (query.limit !== null) rows = rows.slice(0, query.limit)
  return rows
}

/**
 * Column projection (§1.3 `fields`/`select`).
 *
 * LIMITATION worth knowing: a `fields` list cannot select a `column_N` placeholder for an EMPTY
 * header cell — the parser validates requested names against `EngineTable.headers`, and those
 * columns are only named `column_N` once the header row has been read, so a request for
 * `column_3` over a truly empty third header cell is a 400. Documented in the contract report;
 * the fix is a header-normalization pass in front of `parseListQuery`, which no wave has scheduled.
 */
export function projectRecord(record: EngineRecord, fields: string[] | null): EngineRecord {
  if (fields === null) return record
  const projected: EngineRecord = {}
  for (const name of fields) projected[name] = record[name] ?? ""
  return projected
}
