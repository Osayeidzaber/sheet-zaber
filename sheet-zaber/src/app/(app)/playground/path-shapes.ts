/*
 * The playground's own grammar and form helpers. PURE and client-safe — no `server-only`, no env,
 * no network — so it can be imported straight into a client component. Same layout precedent as
 * `src/app/(app)/logs/filter-params.ts` and `src/app/(app)/analytics/window-params.ts`: a route
 * folder's private module that is not part of the §4 contract surface.
 *
 * Everything here is derived from documents already in the tree, not invented:
 *
 * - the four path shapes and the verbs each one accepts are `docs/backend-api-contract.md` §1.3,
 *   implemented by `shapeOf` / `recordMethod` in `src/server/engine/handle.ts:249-274`. A shape/verb
 *   pair outside that table is not a different result — it is a path the grammar does not match, and
 *   the engine answers 404 (`api_not_found`). The UI says so and still lets you send it, because a
 *   real client can make that mistake and §4.8 rule 1 says the playground shows the engine's answer.
 * - `recordId` / `routeSuffix` are how `src/lib/snippets.ts` builds the same URL, so the cURL/JS/Python
 *   output and the request we sent cannot disagree about the path.
 * - `PlaygroundRequest` (`src/lib/playground.ts`) carries the path as TEXT after `/api/v1`, and
 *   `pathSegmentsFor` (`src/server/playground/service.ts:119`) splits it on `/` and percent-decodes
 *   each survivor. A `{record}` value is therefore encoded exactly as a browser would encode one path
 *   segment, so a primary key holding a `/` cannot silently become two segments.
 */

import { METHOD_VALUES } from "@/lib/schemas"
import type { PlaygroundRequest } from "@/lib/playground"
import type { SnippetMethod, SnippetRequest } from "@/lib/snippets"

/** §1.3: `{record}` is a primary-key value, i.e. arbitrary cell text. */
const PATH_SEGMENT_METHODS: readonly SnippetMethod[] = ["GET", "PATCH", "PUT", "DELETE"]
/** `src/lib/snippets.ts:37` — the verbs whose snippet may carry a body. */
export const BODY_METHODS: readonly SnippetMethod[] = ["POST", "PATCH", "PUT"]

export type PathShapeId = "list" | "record" | "search" | "range"

export type PathShape = {
  id: PathShapeId
  /** The `<select>` label: the documented template, then what it is for. */
  label: string
  /** The path tail appended to the endpoint id, or `""` for the bare `{apiId}` shape. */
  suffix: string
  /** Verbs `shapeOf` accepts for this tail. Off-list verbs are allowed but annotated. */
  methods: readonly SnippetMethod[]
  /** Which extra text box this shape needs, if any. */
  input: "record" | "range" | null
  /** Path as it renders in the option label and the request line. */
  template: string
}

/**
 * The four shapes §1.3 documents, in that order. No fifth shape exists: §1.3's
 * "Limits / batch" entry answers its own question with **No**, so there is no `?where[…]` builder
 * and no bulk verb here.
 */
export const PATH_SHAPES: readonly PathShape[] = [
  {
    id: "list",
    label: "{apiId} — list records",
    suffix: "",
    methods: ["GET", "POST"],
    input: null,
    template: "{apiId}",
  },
  {
    id: "record",
    label: "{apiId}/{record} — one record",
    suffix: "",
    methods: PATH_SEGMENT_METHODS,
    input: "record",
    template: "{apiId}/{record}",
  },
  {
    id: "search",
    label: "{apiId}/search — substring search",
    suffix: "search",
    methods: ["GET"],
    input: null,
    template: "{apiId}/search",
  },
  {
    id: "range",
    label: "{apiId}/range/A1:D20 — raw cell band",
    suffix: "range",
    methods: ["GET"],
    input: "range",
    template: "{apiId}/range/A1:D20",
  },
]

/** The shape a stored id names. An unknown id (a draft from an older build) falls back to `{apiId}`. */
export function shapeById(id: PathShapeId): PathShape {
  return PATH_SHAPES.find((shape) => shape.id === id) ?? PATH_SHAPES[0]
}

/** True when the engine's grammar serves this shape for this verb (§1.3 + `shapeOf`). */
function shapeAcceptsMethod(shape: PathShape, method: SnippetMethod): boolean {
  return shape.methods.includes(method)
}

/**
 * The documented one-line reason a shape/verb pair is a refusal, or `null` when the grammar serves it.
 * Wording is the engine's, not a guess: `shapeOf` returns `null`, and `null` is 404 `api_not_found`.
 */
export function grammarNote(shape: PathShape, method: SnippetMethod): string | null {
  if (shapeAcceptsMethod(shape, method)) return null
  return `${method} on ${shape.template} isn't a supported path, so it answers 404 api_not_found. Sending it is still honest — the playground shows the engine's real refusal.`
}

export type ShapeInputs = { record: string; range: string }

/**
 * The path we send, assembled from the shape only — the user never types a whole path.
 * Returns `null` when a shape's required sub-field is empty, because `{apiId}/` would collapse to
 * the list shape (`pathSegmentsFor` drops empty segments) and send a request the user did not mean.
 */
export function composePath(
  apiId: string,
  shape: PathShape,
  inputs: ShapeInputs
): { path: string } | { error: keyof ShapeInputs } {
  if (shape.input === "record") {
    const record = inputs.record.trim()
    if (record === "") return { error: "record" }
    return { path: `${apiId}/${encodeURIComponent(record)}` }
  }
  if (shape.input === "range") {
    const range = inputs.range.trim()
    if (range === "") return { error: "range" }
    return { path: `${apiId}/range/${range}` }
  }
  return { path: shape.suffix === "" ? apiId : `${apiId}/${shape.suffix}` }
}

/**
 * The same call as a `SnippetRequest`, so `SnippetTabs` renders the bytes the engine actually got.
 *
 * `recordId` keeps the percent-encoded text we sent, so the example and the call cannot diverge for a
 * key containing `/` or `#`. `body` is only attached for POST/PATCH/PUT, because
 * `validateSnippetRequest` refuses a body anywhere else — a body sent on a GET is reported in prose
 * instead of being hidden.
 */
export function snippetRequestFor(
  request: PlaygroundRequest,
  apiId: string,
  shape: PathShape,
  inputs: ShapeInputs,
  baseUrl: string,
  body: unknown
): SnippetRequest {
  const composed = composePath(apiId, shape, inputs)
  const tail = "path" in composed ? composed.path : apiId
  const suffix = tail.slice(apiId.length).replace(/^\//, "")

  const snippet: SnippetRequest = {
    baseUrl,
    method: request.method,
    apiId,
    apiKey: API_KEY_PLACEHOLDER,
  }
  if (suffix !== "") {
    // `search` is a suffix; `range/…` is a suffix; a bare `{record}` value is a recordId (§1.3).
    if (shape.id === "record") snippet.recordId = suffix
    else snippet.routeSuffix = suffix
  }
  if (request.query !== undefined && Object.keys(request.query).length > 0) snippet.query = request.query
  if (request.headers !== undefined && Object.keys(request.headers).length > 0) {
    snippet.headers = request.headers
  }
  if (body !== undefined && BODY_METHODS.includes(request.method)) snippet.body = body
  return snippet
}

/**
 * The key slot. `src/lib/snippets.ts` interpolates `apiKey` literally, so the only safe value here is
 * a placeholder, and `<YOUR_API_KEY>` is the one this dashboard already prints on the endpoint page
 * (`src/app/(app)/apis/[apiId]/page.tsx:60`). No plaintext, no preview, nothing copyable that could
 * become a credential (`security.md` §4).
 */
export const API_KEY_PLACEHOLDER = "<YOUR_API_KEY>"

/* ------------------------------------------------------------------ status wording */

/** §1.2's status table, in words. Codes the table does not list fall back to their class. */
const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
}

export function statusText(status: number): string {
  const exact = STATUS_TEXT[status]
  if (exact !== undefined) return exact
  const cls = Math.floor(status / 100)
  if (cls === 2) return "Success"
  if (cls === 3) return "Redirection"
  if (cls === 4) return "Client error"
  if (cls === 5) return "Server error"
  return "Non-standard status"
}

/**
 * The engine's own refusal code, read out of the body it returned (§1.2 envelope). `null` for a
 * success envelope or a body that is not JSON — the panel never re-maps anything, it only labels.
 */
export function engineErrorCode(body: string): string | null {
  const parsed = parseJsonBody(body)
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const error = (parsed as { error?: unknown }).error
  if (error === null || typeof error !== "object") return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

/** `undefined` = not JSON; anything else is the parsed value (including a literal `null`). */
export function parseJsonBody(text: string): unknown | undefined {
  if (text.trim() === "") return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Pretty-printed ONLY as an addition to the verbatim bytes, never instead of them. */
export function prettyJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value, null, 2)
    return typeof text === "string" ? text : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ query / header rows */

export type FormRow = { id: string; key: string; value: string }

export function emptyRow(id: string): FormRow {
  return { id, key: "", value: "" }
}

/**
 * Rows → `Record<string, string | string[]>`: a repeated key becomes an array, which is exactly how
 * `searchParamsFor` (`src/server/playground/service.ts:127`) replays it as repeated params, and how
 * `URLSearchParams` reads `sort=a&sort=-b` (§1.3). Rows with a blank key are dropped, so an empty row
 * cannot send `=value`.
 */
export function rowsToRecord(rows: readonly FormRow[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === "") continue
    const existing = out[key]
    if (existing === undefined) out[key] = row.value
    else if (Array.isArray(existing)) existing.push(row.value)
    else out[key] = [existing, row.value]
  }
  return out
}

/** Header rows are `Record<string, string>` — none of them reaches the engine (§4.8, see the UI note). */
export function headersToRecord(rows: readonly FormRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === "") continue
    out[key] = row.value
  }
  return out
}

/* ------------------------------------------------------------------ non-sensitive persistence */

/**
 * What survives a reload: method, key row id, endpoint, shape, path parts, query rows and body text.
 *
 * Deliberately absent:
 * - `keyPreview` — §4.8 names it the only key string the client may see, and a persisted one would
 *   sit in `localStorage` long after the row is revoked. It is re-read from the server on every load.
 * - header rows — a user who pastes an `Authorization` value into that box has put a secret in the
 *   field, and none of those rows is forwarded anyway, so persisting them is pure risk for no benefit.
 * - the last response — it is the engine's answer to a call that has already ended.
 */
export const STORAGE_KEY = "sheet-zaber.playground.v1"

export type PersistedForm = {
  method: SnippetMethod
  apiKeyId: string
  apiId: string
  shape: PathShapeId
  record: string
  range: string
  query: FormRow[]
  body: string
}

const SHAPE_VALUES: readonly string[] = ["list", "record", "search", "range"]

/** The verb list is `playgroundRequestSchema`'s own enum (`src/lib/schemas.ts:11`), not a copy. */
export function isSnippetMethod(value: unknown): value is SnippetMethod {
  return typeof value === "string" && (METHOD_VALUES as readonly string[]).includes(value)
}

function isPathShapeId(value: unknown): value is PathShapeId {
  return typeof value === "string" && SHAPE_VALUES.includes(value)
}

function rowsOf(value: unknown): FormRow[] {
  if (!Array.isArray(value)) return []
  const out: FormRow[] = []
  value.forEach((item, index) => {
    if (item === null || typeof item !== "object") return
    const row = item as { id?: unknown; key?: unknown; value?: unknown }
    if (typeof row.key !== "string" || typeof row.value !== "string") return
    out.push({
      id: typeof row.id === "string" && row.id !== "" ? row.id : `restored-${index}`,
      key: row.key,
      value: row.value,
    })
  })
  return out
}

/**
 * Decodes a stored draft. Never throws and never reports: a corrupt, foreign or oversized blob is the
 * same as no draft, because the form is a convenience and the server owns the truth. An id is only
 * restored after the caller checks it still exists in the list the server just rendered.
 */
export function decodePersistedForm(raw: string | null): Partial<PersistedForm> | null {
  if (raw === null || raw === "") return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const value = parsed as Record<string, unknown>
    const out: Partial<PersistedForm> = {}
    if (isSnippetMethod(value.method)) out.method = value.method
    if (isPathShapeId(value.shape)) out.shape = value.shape
    if (typeof value.apiKeyId === "string") out.apiKeyId = value.apiKeyId
    if (typeof value.apiId === "string") out.apiId = value.apiId
    if (typeof value.record === "string") out.record = value.record
    if (typeof value.range === "string") out.range = value.range
    if (typeof value.body === "string") out.body = value.body
    if (Array.isArray(value.query)) out.query = rowsOf(value.query)
    return out
  } catch {
    return null
  }
}

/** A stable primitive snapshot for useSyncExternalStore; unavailable storage means no draft. */
export function readPersistedDraft(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function subscribeToPersistedDraft(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onChange()
  }
  window.addEventListener("storage", onStorage)
  return () => window.removeEventListener("storage", onStorage)
}

/** Write-through, failures swallowed: private mode and quota exhaustion must not break the page. */
export function writePersistedForm(form: PersistedForm): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form))
  } catch {
    // Nothing to tell: the draft is a convenience, and the request line above the Send button already
    // shows exactly what would be sent.
  }
}
