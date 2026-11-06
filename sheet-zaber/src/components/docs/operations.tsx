import type { ReactNode } from "react"

import { BulletList, Em, Para } from "@/components/marketing/legal-doc"
import {
  Callout,
  DocsSection,
  EndpointHeader,
  FailureList,
  ParamTable,
  ShapeBlock,
  SubHeading,
} from "@/components/docs/docs-page"
import type { FailureRow, ParamRow } from "@/components/docs/docs-page"
import { SnippetTabs } from "@/components/ui/snippet-tabs"
import type { SnippetMethod, SnippetRequest } from "@/lib/snippets"

/*
 * One plate per operation in docs/backend-api-contract.md §1.3.
 *
 * Every sentence in here is a line of that section (or of §1.1/§1.2, which define the scope and
 * the statuses), cited in the section's `source` folio. Where the contract documents body
 * semantics but not a response shape — Replace/PUT is that case — this file says so instead of
 * printing an invented one.
 */

const BASE_URL = "https://sheet.zaber.tech/api/v1"

/*
 * Placeholders, never credentials: `<api-id>` stands for `api_configurations.id` (a uuid,
 * docs/database-schema.md) and `sz_live_…` for your own key. Path segments reach the URL
 * verbatim; only query values go through the form-urlencoded serializer.
 */
const API_ID = "<api-id>"
const RECORD = "<record>"
const KEY = "sz_live_…"

/** The refusals every `/api/v1` call can meet, from §1.1 and §1.2. */
const COMMON_FAILURES: FailureRow[] = [
  {
    code: 401,
    codes: ["missing_key", "invalid_key"],
    detail: "No Authorization header, or a key that is revoked, expired, or owned by a different user than the API.",
  },
  {
    code: 403,
    codes: ["key_scope_insufficient", "key_restricted", "api_disabled", "operation_not_allowed"],
    detail: "The key, its scope, its API restriction, the enabled state of the API or its allowed operations refuse the verb.",
  },
  {
    code: 404,
    codes: ["api_not_found"],
    detail: "No API with that id — and the same answer for an API belonging to someone else, so the id space is not an oracle.",
  },
  {
    code: 422,
    codes: ["tab_not_found", "google_sheet_inaccessible"],
    detail: "The configured tab is not in the snapshot for that API, or the sheet cannot be read with the owner's Google grant.",
  },
  {
    code: 429,
    codes: ["rate_limited"],
    detail: "An hourly or daily window is full. The response carries Retry-After in seconds.",
  },
  {
    code: 503,
    codes: ["google_reauth_required", "google_quota_exceeded"],
    detail: "Reauth requires the owner's fresh consent; quota exhaustion instead requires waiting for Google's Retry-After. Check the code before retrying.",
  },
  {
    code: 500,
    codes: ["internal_error"],
    detail: "Anything unexpected. The message never contains internals, and the request is still logged.",
  },
]

function failures(...rows: FailureRow[]): FailureRow[] {
  return [...rows, ...COMMON_FAILURES].sort((a, b) => a.code - b.code)
}

export type OperationDoc = {
  id: string
  index: string
  name: string
  method: SnippetMethod
  path: string
  scope: "read" | "write"
  successCode: number
  successLabel: string
  source: string
  summary: ReactNode
  tables: Array<{
    label: string
    rows: ParamRow[]
    nameLabel?: string
    typeLabel?: string
    meaningLabel?: string
  }>
  shape?: { label: string; code: string; note?: ReactNode }
  request: SnippetRequest
  specific: FailureRow[]
  notes?: ReactNode
}

const META_PLATE = `"meta": {
    "api_id": "<api-id>",
    "count": <rows returned>,
    "limit": <the page size you asked for, or null>,
    "offset": <rows skipped, or 0>,
    "duration_ms": <server milliseconds>
  }`

export const OPERATIONS: OperationDoc[] = [
  {
    id: "list-records",
    index: "5.1",
    name: "List records",
    method: "GET",
    path: "/api/v1/{api}",
    scope: "read",
    successCode: 200,
    successLabel: "data is an array of record objects; meta.count is the rows returned",
    source: "docs/backend-api-contract.md §1.3 · §1.2 envelope",
    summary: (
      <Para>
        Every row of the configured tab below the header row, as objects whose keys are the header
        cells. Filtering, sorting, paging and column selection all happen on the way to the answer,
        and an unknown column in a filter or a sort is a <Em>400</Em> — the tab is not queried by a
        language it does not have.
      </Para>
    ),
    tables: [
      {
        label: "List records query parameters",
        rows: [
          { name: "limit", type: "int ≥1, ≤1000", meaning: "Page size. Optional; the documented default is all rows." },
          { name: "offset", type: "int ≥0", meaning: "Rows to skip. Described as SheetDB-compatible." },
          {
            name: "page + per_page",
            type: "int",
            meaning: (
              <>
                Alternative pagination, where <code className="inline">offset = (page-1)*per_page</code>. Rejected
                if mixed with <code className="inline">offset</code>.
              </>
            ),
          },
          {
            name: "sort",
            type: "column | -column",
            meaning: (
              <>
                Ascending, or descending with a leading <code className="inline">-</code>. Repeatable:{" "}
                <code className="inline">sort=a&amp;sort=-b</code>.
              </>
            ),
          },
          { name: "order", type: "column", meaning: "An alias of sort, kept for SheetDB compatibility." },
          {
            name: "fields | select",
            type: "csv of columns",
            meaning: "A comma-separated column subset, applied after filtering.",
          },
          { name: "q", type: "text", meaning: "Shortcut for a search across all columns — the same thing /search does." },
          {
            name: "any column=value",
            type: "exact match",
            meaning: (
              <>
                Equality filter, repeatable and combined with AND. Value comparison is exact and
                case-sensitive. The operator suffixes <code className="inline">__contains</code>,{" "}
                <code className="inline">__gt</code>, <code className="inline">__gte</code>,{" "}
                <code className="inline">__lt</code> and <code className="inline">__lte</code> are supported.
              </>
            ),
          },
        ],
      },
    ],
    shape: {
      label: "Success body (§1.2 + §1.3)",
      code: `{
  "data": [
    { "<header cell>": "<cell value>" }
  ],
  ${META_PLATE}
}`,
      note: "Field names are the contract's; values are angle brackets so this cannot be read as a captured response.",
    },
    request: {
      baseUrl: BASE_URL,
      method: "GET",
      apiId: API_ID,
      query: { status: "open", sort: ["-created_at"], fields: "id,email,status", limit: "25" },
      apiKey: KEY,
    },
    specific: [
      {
        code: 400,
        codes: ["validation_failed"],
        detail: "A filter or sort names a column the header row does not have, or page/per_page is mixed with offset.",
      },
    ],
    notes: (
      <Callout label="No limit means the whole tab">
        <p>
          §1.3 defaults <code className="inline">limit</code> to all rows: a list call without it asks
          for everything below the header row in one response, so the size of that call is a parameter
          you set rather than something the platform decides for you.
        </p>
      </Callout>
    ),
  },
  {
    id: "single-record",
    index: "5.2",
    name: "Single record",
    method: "GET",
    path: "/api/v1/{api}/{record}",
    scope: "read",
    successCode: 200,
    successLabel: "data is one record object",
    source: "docs/backend-api-contract.md §1.3 · Single record",
    summary: (
      <Para>
        One record, addressed by the value of the primary-key column you designated for that API. The
        path segment is that value — never a row number. If the API has no{" "}
        <code className="inline">primary_key_column</code> the call is refused with{" "}
        <Em>403 operation_not_allowed</Em>, and the message tells you to set a primary key or use list
        plus a filter instead.
      </Para>
    ),
    tables: [
      {
        label: "Single record path segment",
        nameLabel: "Segment",
        rows: [
          {
            name: "{record}",
            type: "primary-key value",
            meaning: (
              <>
                Matched case-sensitively against the stringified cell.
                Zero matches is 404, more than one is 409.
              </>
            ),
          },
        ],
      },
    ],
    shape: {
      label: "Success body",
      code: `{
  "data": { "<header cell>": "<cell value>" },
  ${META_PLATE}
}`,
    },
    request: {
      baseUrl: BASE_URL,
      method: "GET",
      apiId: API_ID,
      recordId: RECORD,
      apiKey: KEY,
    },
    specific: [
      {
        code: 403,
        codes: ["operation_not_allowed"],
        detail: "The API has no primary_key_column, so a single record cannot be addressed at all.",
      },
      {
        code: 404,
        codes: ["record_not_found"],
        detail: "No row matched that primary-key value.",
      },
      {
        code: 409,
        codes: ["ambiguous_record"],
        detail: "More than one row carries that value, so the platform refuses rather than picking one.",
      },
    ],
  },
  {
    id: "search",
    index: "5.3",
    name: "Search",
    method: "GET",
    path: "/api/v1/{api}/search?q=term",
    scope: "read",
    successCode: 200,
    successLabel: "data is an array of matching record objects",
    source: "docs/backend-api-contract.md §1.3 · Search",
    summary: (
      <Para>
        A case-insensitive substring match across all columns. It takes the same{" "}
        <code className="inline">limit</code>, <code className="inline">offset</code>,{" "}
        <code className="inline">sort</code> and <code className="inline">fields</code> parameters as
        the list call, and an empty <code className="inline">q</code> is a 400 rather than a
        match-everything query.
      </Para>
    ),
    tables: [
      {
        label: "Search parameters",
        rows: [
          { name: "q", type: "text, required", meaning: "The substring to look for. Empty → 400 validation_failed." },
          {
            name: "limit · offset · sort · fields",
            type: "as in List records",
            meaning: "The same paging, ordering and column-subset parameters, with the same meanings and bounds.",
          },
        ],
      },
    ],
    shape: {
      label: "Success body",
      code: `{
  "data": [
    { "<header cell>": "<cell value>" }
  ],
  ${META_PLATE}
}`,
    },
    request: {
      baseUrl: BASE_URL,
      method: "GET",
      apiId: API_ID,
      routeSuffix: "search",
      query: { q: "open", limit: "10" },
      apiKey: KEY,
    },
    specific: [
      {
        code: 400,
        codes: ["validation_failed"],
        detail: "q was absent or empty — search never degrades into a full-table scan.",
      },
    ],
  },
  {
    id: "range",
    index: "5.4",
    name: "Range",
    method: "GET",
    path: "/api/v1/{api}/range/{A1notation}",
    scope: "read",
    successCode: 200,
    successLabel: "data.rows is the raw 2-D slice, data.headers the header cells",
    source: "docs/backend-api-contract.md §1.3 · Range",
    summary: (
      <Para>
        The slice you asked for, as cells rather than as records:{" "}
        <code className="inline">range/A1:D20</code>, or{" "}
        <code className="inline">range/Sheet1!A1:D20</code> when the sheet part matches the tab the API
        is configured on. Notation is checked by regex and against the tab&#39;s bounds, so a range
        outside the tab is a 400 and never a silently truncated answer.
      </Para>
    ),
    tables: [
      {
        label: "Range path segment",
        nameLabel: "Segment",
        rows: [
          {
            name: "{A1notation}",
            type: "A1:D20 | Sheet1!A1:D20",
            meaning: (
              <>
                Validated by regex plus a bounds check against the tab size. A sheet part that is not
                the configured tab is refused.
              </>
            ),
          },
        ],
      },
    ],
    shape: {
      label: "Success body",
      code: `{
  "data": {
    "rows": [
      ["<cell>", "<cell>"],
      ["<cell>", "<cell>"]
    ],
    "headers": ["<header cell>", "<header cell>"]
  },
  ${META_PLATE}
}`,
    },
    request: {
      baseUrl: BASE_URL,
      method: "GET",
      apiId: API_ID,
      routeSuffix: "range/A1:D20",
      apiKey: KEY,
    },
    specific: [
      {
        code: 400,
        codes: ["invalid_range"],
        detail: "Notation the regex rejects, a range outside the tab, or a sheet part that is not the configured tab.",
      },
    ],
  },
  {
    id: "create",
    index: "5.5",
    name: "Create",
    method: "POST",
    path: "/api/v1/{api}",
    scope: "write",
    successCode: 201,
    successLabel: "data.created is the count, data.records the echoed objects",
    source: "docs/backend-api-contract.md §1.3 · Create",
    summary: (
      <Para>
        Append a record after the last non-empty row of the tab. Every key in the body must be a column
        the header row knows — an unknown key is a <Em>422 header_mismatch</Em> whose message lists the
        offenders, while a missing key is fine and leaves the cell empty. Values are stringified for
        Sheets, and a key that your header row does not know is refused before anything is written.
      </Para>
    ),
    tables: [
      {
        label: "Create request body",
        nameLabel: "Body",
        typeLabel: "Shape",
        rows: [
          {
            name: "object",
            type: "JSON object",
            meaning: (
              <>
                Column names as keys. Unknown key → 422 header_mismatch; omitted keys are written as
                empty cells.
              </>
            ),
          },
          {
            name: "array of objects",
            type: "≤500 per request",
            meaning: (
              <>
                §1.3 documents the array form with a 500-record ceiling; see the note below before you
                rely on it, because docs/google-integration.md §4 documents v1 as one record per request.
              </>
            ),
          },
        ],
      },
      {
        label: "Create requirements",
        nameLabel: "Requirement",
        typeLabel: "Where",
        rows: [
          { name: "write scope", type: "§1.1", meaning: "The key must carry the write scope, which covers POST." },
          {
            name: "POST allowed",
            type: "§1.3",
            meaning: (
              <>
                <code className="inline">POST</code> must be in the API&#39;s{" "}
                <code className="inline">allowed_operations</code>.
              </>
            ),
          },
          {
            name: "read_write API",
            type: "§1.3",
            meaning: (
              <>
                The API&#39;s <code className="inline">permissions</code> must be{" "}
                <code className="inline">read_write</code>.
              </>
            ),
          },
          {
            name: "no primary key needed",
            type: "docs/plan.md D9",
            meaning: "Append does not resolve a row, so an API without a primary key can still accept POST.",
          },
        ],
      },
    ],
    shape: {
      label: "Success body",
      code: `{
  "data": {
    "created": <records written>,
    "records": [
      { "<header cell>": "<cell value>" }
    ]
  },
  ${META_PLATE}
}`,
      note: "The write itself goes through values.append with insertDataOption=INSERT_ROWS.",
    },
    request: {
      baseUrl: BASE_URL,
      method: "POST",
      apiId: API_ID,
      body: { email: "ada@example.com", status: "open" },
      apiKey: KEY,
    },
    specific: [
      {
        code: 400,
        codes: ["invalid_json"],
        detail: "The body is not parseable JSON.",
      },
      {
        code: 413,
        codes: ["body_too_large"],
        detail: "The request body is over the 1 MB ceiling §1.2 documents.",
      },
      {
        code: 422,
        codes: ["header_mismatch"],
        detail: "A body key is not in the header row; the message lists the offending keys.",
      },
    ],
    notes: (
      <Callout label="Open discrepancy in the source documents">
        <p>
          <code className="inline">docs/backend-api-contract.md</code> §1.3 documents Create as
          accepting one object <em>or an array of objects up to 500</em>, and prints{" "}
          <code className="inline">data.created</code> as a count.{" "}
          <code className="inline">docs/google-integration.md</code> §4 says the opposite for the same
          verb: “Batches: v1 writes one record per request. A POST array &gt;1 record is rejected with{" "}
          <code className="inline">400 validation_failed</code>.” Both are in the contract set, so this
          page states both rather than choosing. A single object is accepted under either reading — that
          is the example above.
        </p>
      </Callout>
    ),
  },
  {
    id: "update-merge",
    index: "5.6",
    name: "Update (merge)",
    method: "PATCH",
    path: "/api/v1/{api}/{record}",
    scope: "write",
    successCode: 200,
    successLabel: "data.updated is 1",
    source: "docs/backend-api-contract.md §1.3 · Update (merge)",
    summary: (
      <Para>
        A partial object: only the columns you send are written, and the row is resolved through the
        primary-key value at request time. The write goes through{" "}
        <code className="inline">values.update</code> per contiguous span, and{" "}
        <code className="inline">data.updated</code> is <Em>1</Em>.
      </Para>
    ),
    tables: [
      {
        label: "Update request body",
        nameLabel: "Body",
        rows: [
          {
            name: "partial object",
            type: "JSON object",
            meaning: (
              <>
                Any subset of the header row&#39;s columns. Keys the header row does not know are a 422{" "}
                <code className="inline">header_mismatch</code>; columns you leave out keep their value.
              </>
            ),
          },
        ],
      },
    ],
    shape: {
      label: "Success body",
      code: `{
  "data": { "updated": 1 },
  ${META_PLATE}
}`,
    },
    request: {
      baseUrl: BASE_URL,
      method: "PATCH",
      apiId: API_ID,
      recordId: RECORD,
      body: { status: "shipped" },
      apiKey: KEY,
    },
    specific: [
      {
        code: 400,
        codes: ["invalid_json"],
        detail: "The body is not parseable JSON.",
      },
      {
        code: 403,
        codes: ["write_requires_primary_key", "operation_not_allowed"],
        detail: "A write verb against an API whose primary_key_column is unset, or whose allowed_operations omit PATCH.",
      },
      {
        code: 404,
        codes: ["record_not_found"],
        detail: "The primary-key value matched no row, so there is nothing to merge into.",
      },
      {
        code: 409,
        codes: ["ambiguous_record"],
        detail: "The primary-key value matched more than one row: §1.5 promises ambiguity always 409s rather than writing two rows.",
      },
      {
        code: 413,
        codes: ["body_too_large"],
        detail: "The request body is over 1 MB.",
      },
      {
        code: 422,
        codes: ["header_mismatch"],
        detail: "A body key is not in the header row.",
      },
    ],
  },
  {
    id: "replace",
    index: "5.7",
    name: "Replace",
    method: "PUT",
    path: "/api/v1/{api}/{record}",
    scope: "write",
    successCode: 200,
    successLabel: "the whole row is written — see the note on what §1.3 does not print",
    source: "docs/backend-api-contract.md §1.3 · Replace",
    summary: (
      <Para>
        A full object over one row. §1.3 states the divergence from PATCH in one sentence: every header
        column except the primary key is optional-but-overwritten, and a column you omit is{" "}
        <Em>cleared</Em>. If you meant to merge, send PATCH.
      </Para>
    ),
    tables: [
      {
        label: "Replace request body",
        nameLabel: "Body",
        rows: [
          {
            name: "full object",
            type: "JSON object",
            meaning: (
              <>
                Every header column you want to keep. Omitted columns are overwritten — this is the
                documented divergence from PATCH, not an accident of ordering.
              </>
            ),
          },
        ],
      },
    ],
    request: {
      baseUrl: BASE_URL,
      method: "PUT",
      apiId: API_ID,
      recordId: RECORD,
      body: { email: "ada@example.com", status: "shipped", note: "" },
      apiKey: KEY,
    },
    specific: [
      {
        code: 400,
        codes: ["invalid_json"],
        detail: "The body is not parseable JSON.",
      },
      {
        code: 403,
        codes: ["write_requires_primary_key", "operation_not_allowed"],
        detail: "A write verb against an API whose primary_key_column is unset, or whose allowed_operations omit PUT.",
      },
      {
        code: 404,
        codes: ["record_not_found"],
        detail: "The primary-key value matched no row.",
      },
      {
        code: 409,
        codes: ["ambiguous_record"],
        detail: "The primary-key value matched more than one row.",
      },
      {
        code: 413,
        codes: ["body_too_large"],
        detail: "The request body is over 1 MB.",
      },
      {
        code: 422,
        codes: ["header_mismatch"],
        detail: "A body key is not in the header row.",
      },
    ],
    notes: (
      <Callout label="What the contract does not say" tone="outline">
        <p>
          §1.3 documents Replace&#39;s <em>body</em> semantics and stops there: it prints{" "}
          <code className="inline">data.updated</code> for PATCH and{" "}
          <code className="inline">data.deleted</code> for DELETE, but no <code className="inline">data</code>{" "}
          shape for PUT, so this page prints none either. The write path it shares with PATCH is{" "}
          <code className="inline">values.update</code> on the resolved single row
.
        </p>
      </Callout>
    ),
  },
  {
    id: "delete",
    index: "5.8",
    name: "Delete",
    method: "DELETE",
    path: "/api/v1/{api}/{record}",
    scope: "write",
    successCode: 200,
    successLabel: "data.deleted is 1",
    source: "docs/backend-api-contract.md §1.3 · Delete",
    summary: (
      <Para>
        One row, resolved by its primary-key value, removed with{" "}
        <code className="inline">spreadsheets.batchUpdate</code> →{" "}
        <code className="inline">deleteDimension</code> for that single row. A body on a DELETE is
        rejected with <Em>400</Em> — there is no conditional-delete form in v1.
      </Para>
    ),
    tables: [
      {
        label: "Delete path segment",
        nameLabel: "Segment",
        rows: [
          {
            name: "{record}",
            type: "primary-key value",
            meaning: "The same resolution the read and merge verbs use: 0 matches → 404, more than 1 → 409.",
          },
        ],
      },
    ],
    shape: {
      label: "Success body",
      code: `{
  "data": { "deleted": 1 },
  ${META_PLATE}
}`,
    },
    request: {
      baseUrl: BASE_URL,
      method: "DELETE",
      apiId: API_ID,
      recordId: RECORD,
      apiKey: KEY,
    },
    specific: [
      {
        code: 400,
        codes: ["validation_failed"],
        detail: "A body was sent with the DELETE — §1.3 rejects body-bearing deletes outright.",
      },
      {
        code: 403,
        codes: ["write_requires_primary_key", "operation_not_allowed"],
        detail: "A delete against an API whose primary_key_column is unset, or whose allowed_operations omit DELETE.",
      },
      {
        code: 404,
        codes: ["record_not_found"],
        detail: "The primary-key value matched no row.",
      },
      {
        code: 409,
        codes: ["ambiguous_record"],
        detail: "The primary-key value matched more than one row, so no row is deleted.",
      },
    ],
    notes: (
      <Callout label="Destructive and single-target by design">
        <p>
          The row index is computed at request time and never persisted; what
          <code className="inline">deleteDimension</code> receives is that one row. Bulk deletion does
          not exist in v1 — the next section states that in the contract&#39;s own words.
        </p>
      </Callout>
    ),
  },
]

/**
 * The §1.3 "Limits / batch" clause, kept as its own section so a reader who is looking for
 * `?where[...]` finds a refusal rather than an absence.
 */
export function NotInV1() {
  return (
    <DocsSection
      id="not-in-v1"
      index="5.9"
      heading="Not in v1"
      source="docs/backend-api-contract.md §1.3 · Limits / batch, §4.10"
    >
      <Para>
        The contract closes the section with a question it answers no: whether{" "}
        <code className="inline">DELETE</code> or <code className="inline">PATCH</code> accept a{" "}
        <code className="inline">?where[column]=value</code> bulk form. <Em>No</Em> — v1 is
        single-record only, which the contract explains as matching spec §7 and “avoiding destructive
        bulk surprises”.
      </Para>
      <BulletList
        items={[
          <>
            <Em>Bulk update and bulk delete.</Em> Not offered; each PATCH, PUT or DELETE addresses one
            primary-key value. A body on a DELETE is a 400.
          </>,
          <>
            <Em>Batch create.</Em> §1.3 and docs/google-integration.md §4 disagree about a POST array —
            see the note in section 5.5. Until that is reconciled, write one record per request.
          </>,
          <>
            <Em>Query-string authentication.</Em> Not supported, so a key never has to appear in
            a URL, a log line or a referrer.
          </>,
          <>
            <Em>Anything §4.10 defers.</Em> The deferred and blocked surfaces are listed on the Overview
            page, and none of them is advertised as a capability of the data API here.
          </>,
        ]}
      />
    </DocsSection>
  )
}

export function OperationBlock({ op }: { op: OperationDoc }) {
  return (
    <DocsSection id={op.id} index={op.index} heading={op.name} source={op.source}>
      {op.summary}

      <EndpointHeader
        method={op.method}
        path={op.path}
        scope={op.scope}
        successCode={op.successCode}
        successLabel={op.successLabel}
      />

      {op.tables.map((table) => (
        <div key={table.label} className="flex flex-col gap-2">
          <SubHeading>{table.label}</SubHeading>
          <ParamTable
            label={table.label}
            nameLabel={table.nameLabel}
            typeLabel={table.typeLabel}
            rows={table.rows}
          />
        </div>
      ))}

      {op.shape ? (
        <div className="flex flex-col gap-2">
          <SubHeading>{op.shape.label}</SubHeading>
          <ShapeBlock label="application/json" shape={op.shape.code} note={op.shape.note} />
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <SubHeading>Example call</SubHeading>
        <p className="max-w-[70ch] text-[13px] leading-[1.6] text-dust">
          Illustrative request built by <code className="inline">src/lib/snippets.ts</code>, the same
          builders the playground uses. Replace <code className="inline">{API_ID}</code>,{" "}
          <code className="inline">{RECORD}</code> and <code className="inline">{KEY}</code> with your
          values and use your own sheet headers. This is not a live request or captured response.
        </p>
        <SnippetTabs request={op.request} />
      </div>

      <div className="flex flex-col gap-2">
        <SubHeading>When it fails</SubHeading>
        <FailureList rows={failures(...op.specific)} />
      </div>

      {op.notes}
    </DocsSection>
  )
}
