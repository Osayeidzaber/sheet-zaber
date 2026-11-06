"use client"

/*
 * The playground client: build a documented `/api/v1` call, send it once through
 * `POST /api/internal/playground`, and render whatever the engine answered.
 *
 * The contract rules this file exists to make visible (`docs/backend-api-contract.md` §4.8):
 *
 * 1. STATUS IS VERBATIM. The engine's status arrives inside `data`, so a 404/409/422/429 is a
 *    SUCCESSFUL playground call. It goes to `EngineAnswer`, never to the failure block.
 * 2. THE PLAINTEXT KEY NEVER REACHES THE BROWSER. There is no key input on this page, in any arm. The
 *    payload carries `apiKeyId` — a row id — and the only key text rendered anywhere is the
 *    `keyPreview` inside a `<select>` label, which is never persisted (`./path-shapes.ts`) and never
 *    written into a snippet, whose key slot is the `<YOUR_API_KEY>` placeholder.
 * 3. AN UNREACHABLE ENGINE IS AN ERROR. `playground_unreachable` renders as a failure with its own
 *    copy. No `status: 500` is fabricated: `EngineAnswer` mounts only when a complete `data` arm
 *    exists, i.e. only when the engine actually answered.
 * 4. Headers are collected because §4.8's type has a `headers` slot, and labelled for what the
 *    implementation does with them: `EngineCall` has no header field at all
 *    (`src/server/playground/service.ts:149`), so NO typed header is forwarded — an `Authorization`
 *    line in particular cannot be, which is `docs/security.md` §4's rule satisfied by construction
 *    rather than by a filter written here.
 *
 * Transport: the fetch runs only inside the Send handler — never during render, because the route may
 * not be mounted while `src/server/engine/**` is still landing — and with same-origin default
 * credentials: the session cookie belongs to this origin, so nothing is configured and nothing is
 * overridden. One request at a time, by ref rather than by button state, so a second click cannot
 * duplicate a call that would be logged.
 */

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { Button, PillLink } from "@/components/ui/button"
import { InlineCode } from "@/components/ui/code"
import { SelectField, TextArea, TextField } from "@/components/ui/field"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/state"
import { SnippetTabs } from "@/components/ui/snippet-tabs"
import type { ActionError } from "@/lib/action-result"
import type { PlaygroundRequest, PlaygroundResponse } from "@/lib/playground"
import { METHOD_VALUES, playgroundRequestSchema } from "@/lib/schemas"
import type { SnippetMethod, SnippetRequest } from "@/lib/snippets"
import { formatNumber } from "@/lib/format"
import { EngineAnswer } from "./engine-answer"
import {
  API_KEY_PLACEHOLDER,
  BODY_METHODS,
  composePath,
  decodePersistedForm,
  emptyRow,
  grammarNote,
  headersToRecord,
  isSnippetMethod,
  PATH_SHAPES,
  readPersistedDraft,
  rowsToRecord,
  shapeById,
  snippetRequestFor,
  statusText,
  STORAGE_KEY,
  subscribeToPersistedDraft,
  writePersistedForm,
  type FormRow,
  type PathShapeId,
  type PersistedForm,
} from "./path-shapes"

/** Key rows the page may offer: `id`, `name`, `keyPreview` — nothing else is allowed to reach here. */
export type PlaygroundKeyOption = { id: string; name: string; keyPreview: string }

/** Every field is a real `ApiConfig` member (`src/server/apis/service.ts:68`), used only for annotation. */
export type PlaygroundApiOption = {
  id: string
  /** The short URL segment, used for every path this page shows or sends. */
  publicId: string
  name: string
  tabTitle: string
  enabled: boolean
  permissions: "read" | "read_write"
  allowedOperations: string[]
  primaryKeyColumn: string | null
}

export type PlaygroundClientProps = {
  keys: PlaygroundKeyOption[]
  apis: PlaygroundApiOption[]
  /** `<site>/api/v1`, computed on the server so no env import crosses into this bundle. */
  baseUrl: string
  /** Keys that exist but have lapsed, so the empty state can tell "no keys" from "none usable". */
  lapsedKeyCount: number
}

/** `src/lib/schemas.ts:103` — `playgroundRequestSchema`'s own ceiling on the raw body text. */
const BODY_CHAR_CAP = 1_000_000

type FieldKey =
  | "apiKeyId"
  | "apiId"
  | "method"
  | "record"
  | "range"
  | "path"
  | "query"
  | "headers"
  | "bodyJson"

type Fields = Partial<Record<FieldKey, string>>

/** Every way a send can end without an engine answer. Each arm has its own copy in `FailureBlock`. */
type Failure =
  | { kind: "network" }
  | { kind: "no_envelope"; httpStatus: number }
  | { kind: "unexpected"; httpStatus: number }
  | ({ kind: "envelope" } & Pick<ActionError["error"], "code" | "message" | "fields">)

/** The last call, kept in component state so it survives every re-render of this panel. */
type LastCall = {
  request: PlaygroundRequest
  response: PlaygroundResponse
  snippet: SnippetRequest
  /** True when a body was sent on a verb whose snippet builders refuse one (`src/lib/snippets.ts:75`). */
  bodyHiddenFromSnippet: boolean
}

const METHOD_OPTIONS = METHOD_VALUES.map((method) => ({ value: method, label: method }))
const SHAPE_OPTIONS = PATH_SHAPES.map((shape) => ({ value: shape.id, label: shape.label }))

function newRowId(): string {
  return `row-${Math.random().toString(36).slice(2, 10)}`
}

/* ------------------------------------------------------------------ reply parsing */

/**
 * HTTP success is `{ data }`, failure is `{ error }`; only in-process success carries `ok: true`.
 * Validate the outer envelope separately from `data.status`: engine refusals are completed calls,
 * not transport failures. Never synthesize an engine answer from a malformed reply (§4.8).
 */
function readReply(body: unknown, httpStatus: number): Failure | { response: PlaygroundResponse } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { kind: "unexpected", httpStatus }
  }
  const record = body as Record<string, unknown>

  if ("error" in record) {
    if (record.error === null || typeof record.error !== "object" || Array.isArray(record.error)) {
      return { kind: "unexpected", httpStatus }
    }
    const error = record.error as Record<string, unknown>
    const raw = error.fields
    const fields: Record<string, string> | undefined =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : undefined
    return {
      kind: "envelope",
      code: typeof error.code === "string" ? error.code : "unknown",
      message:
        typeof error.message === "string"
          ? error.message
          : "The playground returned an error with no description.",
      fields,
    }
  }

  const data = record.data
  if (httpStatus < 200 || httpStatus >= 300 || data === null || typeof data !== "object" || Array.isArray(data)) {
    return { kind: "unexpected", httpStatus }
  }
  const answer = data as Record<string, unknown>
  if (
    typeof answer.status !== "number" ||
    !Number.isInteger(answer.status) ||
    answer.status < 100 ||
    answer.status > 599 ||
    typeof answer.durationMs !== "number" ||
    !Number.isFinite(answer.durationMs) ||
    answer.durationMs < 0 ||
    typeof answer.body !== "string" ||
    answer.headers === null ||
    typeof answer.headers !== "object" ||
    Array.isArray(answer.headers)
  ) {
    return { kind: "unexpected", httpStatus }
  }
  const headerEntries = Object.entries(answer.headers as Record<string, unknown>)
  if (headerEntries.some(([, value]) => typeof value !== "string")) {
    return { kind: "unexpected", httpStatus }
  }
  const headers = Object.fromEntries(headerEntries) as PlaygroundResponse["headers"]
  return {
    response: { status: answer.status, durationMs: answer.durationMs, headers, body: answer.body },
  }
}

/* ------------------------------------------------------------------ the page's client half */

// The server cannot read this browser's storage. `undefined` is distinct from "no saved draft".
function serverDraftSnapshot(): undefined {
  return undefined
}

export function PlaygroundClient(props: PlaygroundClientProps) {
  const storedDraft = useSyncExternalStore(
    subscribeToPersistedDraft,
    readPersistedDraft,
    serverDraftSnapshot,
  )
  const { keys, apis, baseUrl, lapsedKeyCount } = props

  if (keys.length === 0 || apis.length === 0) {
    return (
      <div className="flex flex-col gap-8">
        <ExplainerStrip baseUrl={baseUrl} />
        {keys.length === 0 ? <EmptyKeys lapsedKeyCount={lapsedKeyCount} /> : null}
        {apis.length === 0 ? <EmptyApis /> : null}
      </div>
    )
  }

  if (storedDraft === undefined) {
    return (
      <div className="flex flex-col gap-8">
        <ExplainerStrip baseUrl={baseUrl} />
        <Panel as="section">
          <PanelHeader title="Request builder" description="Restoring this browser's draft. Nothing has been sent." />
          <PanelBody className="flex flex-col gap-5">
            <div role="status" aria-label="Loading request builder" className="grid gap-5 lg:grid-cols-2">
              <Skeleton className="h-11 w-full rounded-field" />
              <Skeleton className="h-11 w-full rounded-field" />
              <Skeleton className="h-11 w-full rounded-field" />
              <Skeleton className="h-11 w-full rounded-field" />
            </div>
            <Skeleton className="h-40 w-full rounded-field" />
          </PanelBody>
        </Panel>
      </div>
    )
  }

  // Mount only once the browser snapshot exists; later storage/prop updates never overwrite edits.
  return <PlaygroundForm {...props} initialDraft={storedDraft} />
}

function PlaygroundForm({
  keys,
  apis,
  baseUrl,
  initialDraft,
}: PlaygroundClientProps & { initialDraft: string | null }) {
  const [saved] = useState(() => decodePersistedForm(initialDraft))
  const [method, setMethod] = useState<SnippetMethod>(saved?.method ?? "GET")
  const [selectedKeyId, setApiKeyId] = useState(saved?.apiKeyId ?? "")
  const [selectedApiId, setApiId] = useState(saved?.apiId ?? "")
  // Derive validity from the latest server lists without a prop-reset effect or losing other edits.
  const apiKeyId = keys.some((key) => key.id === selectedKeyId) ? selectedKeyId : ""
  const apiId = apis.some((api) => api.id === selectedApiId) ? selectedApiId : ""
  const pathId = apis.find((api) => api.id === apiId)?.publicId ?? ""
  const [shapeId, setShapeId] = useState<PathShapeId>(saved?.shape ?? "list")
  const [record, setRecord] = useState(saved?.record ?? "")
  const [range, setRange] = useState(saved?.range ?? "")
  const [queryRows, setQueryRows] = useState<FormRow[]>(saved?.query ?? [])
  const [headerRows, setHeaderRows] = useState<FormRow[]>([])
  const [bodyText, setBodyText] = useState(saved?.body ?? "")

  const [pending, setPending] = useState(false)
  const [fields, setFields] = useState<Fields | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [lastCall, setLastCall] = useState<LastCall | null>(null)

  const inFlight = useRef<AbortController | null>(null)
  const shape = shapeById(shapeId)

  // Synchronize edits out to storage, never back into live form state.
  useEffect(() => {
    const draft: PersistedForm = {
      method,
      apiKeyId,
      apiId,
      shape: shapeId,
      record,
      range,
      query: queryRows,
      body: bodyText,
    }
    writePersistedForm(draft)
  }, [method, apiKeyId, apiId, shapeId, record, range, queryRows, bodyText])

  // Stop waiting when unmounted; aborting the browser fetch does not undo server-side execution.
  useEffect(
    () => () => {
      inFlight.current?.abort()
      inFlight.current = null
    },
    []
  )

  const composed = useMemo(
    () => (pathId === "" ? null : composePath(pathId, shape, { record, range })),
    [pathId, shape, record, range]
  )

  /** The line the user sees before sending: the shape template with whatever is filled in. */
  const previewPath = useMemo(() => {
    if (composed !== null && "path" in composed) return composed.path
    if (pathId === "") return "{apiId}"
    if (shape.input === "record") return `${pathId}/{record}`
    if (shape.input === "range") return `${pathId}/range/A1:D20`
    return shape.suffix === "" ? pathId : `${pathId}/${shape.suffix}`
  }, [pathId, composed, shape])

  const note = grammarNote(shape, method)
  const selectedApi = apis.find((api) => api.id === apiId) ?? null
  const logsHref = apiId === "" ? "/logs" : `/logs?apiId=${encodeURIComponent(apiId)}`

  const clearDraft = useCallback(() => {
    setMethod("GET")
    setShapeId("list")
    setRecord("")
    setRange("")
    setQueryRows([])
    setHeaderRows([])
    setBodyText("")
    setFields(null)
    setFailure(null)
    setLastCall(null)
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // A blocked storage API cannot block a reset that is also happening in memory.
    }
  }, [])

  const send = useCallback(async () => {
    // One at a time, by ref: the disabled button is the affordance, this is the guarantee.
    if (inFlight.current !== null) return

    const blocked: Fields = {}
    if (apiKeyId === "") blocked.apiKeyId = "Choose the key row this call authenticates with."
    if (apiId === "") blocked.apiId = "Choose the endpoint the path is built from."

    const built = pathId === "" ? null : composePath(pathId, shape, { record, range })
    if (built !== null && "error" in built) {
      blocked[built.error] =
        built.error === "record"
          ? "This path needs the primary-key value. With it empty, the engine would read a list call instead."
          : "This path needs the A1 band, for example A1:D20."
    }

    /*
     * Raw JSON text is parsed here ONLY so a typo does not cost a round trip. The engine owns the
     * authoritative check (§1.3: `invalid_json` 400, `header_mismatch` 422) and the bytes sent are the
     * text as typed, not the re-serialised value.
     */
    let bodyValue: unknown
    let bodyJson: string | undefined
    const trimmedBody = bodyText.trim()
    if (trimmedBody !== "") {
      try {
        bodyValue = JSON.parse(trimmedBody) as unknown
        bodyJson = bodyText
      } catch (error) {
        blocked.bodyJson =
          error instanceof Error
            ? `Not valid JSON: ${error.message}. Nothing was sent.`
            : "Not valid JSON. Nothing was sent."
      }
    }

    const query = rowsToRecord(queryRows)
    const headers = headersToRecord(headerRows)

    if (Object.keys(blocked).length > 0) {
      setFields(blocked)
      return
    }
    // Unreachable — every `null`/`error` above recorded a message — but narrowing beats a cast.
    if (built === null || !("path" in built)) return

    const candidate: PlaygroundRequest = {
      apiKeyId,
      method,
      path: built.path,
      ...(Object.keys(query).length > 0 ? { query } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(bodyJson !== undefined ? { bodyJson } : {}),
    }

    // The server's own validator, run locally first: one schema, so a refusal here and a refusal
    // there cannot disagree (`src/lib/schemas.ts:97`).
    const parsed = playgroundRequestSchema.safeParse(candidate)
    if (!parsed.success) {
      const zodFields: Fields = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "path")
        let target: FieldKey = "path"
        if (key === "path") {
          target = shape.input === "record" ? "record" : shape.input === "range" ? "range" : "path"
        } else if (
          key === "apiKeyId" ||
          key === "method" ||
          key === "query" ||
          key === "headers" ||
          key === "bodyJson"
        ) {
          target = key
        }
        if (zodFields[target] === undefined) zodFields[target] = issue.message
      }
      setFields(zodFields)
      return
    }
    const request = parsed.data

    setFields(null)
    setFailure(null)
    const controller = new AbortController()
    inFlight.current = controller
    setPending(true)

    try {
      const response = await fetch("/api/internal/playground", {
        method: "POST",
        // No `credentials` key: same-origin default is what a same-origin session cookie needs, and
        // `include` would be a cross-origin claim this page does not make.
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      })

      const reply = await response.json().catch(() => null)
      if (controller.signal.aborted) return
      if (reply === null) {
        setFailure({ kind: "no_envelope", httpStatus: response.status })
        return
      }

      const outcome = readReply(reply, response.status)
      if ("kind" in outcome) {
        setFailure(outcome)
        return
      }

      setLastCall({
        request,
        response: outcome.response,
        snippet: snippetRequestFor(request, pathId, shape, { record, range }, baseUrl, bodyValue),
        // The builders accept a body only on POST/PATCH/PUT, so a body sent elsewhere is explained
        // in prose rather than silently dropped from the example.
        bodyHiddenFromSnippet: bodyValue !== undefined && !BODY_METHODS.includes(request.method),
      })
    } catch (error) {
      if (controller.signal.aborted) return
      // A rejected `fetch` reached no JSON body, so nothing is known about an engine answer.
      if (error instanceof Error) {
        // The message is browser text (usually "Failed to fetch"). It stays in the console so the page
        // never implies it came from Sheet Zaber.
        console.error("[playground] fetch rejected", error.message)
      }
      setFailure({ kind: "network" })
    } finally {
      inFlight.current = null
      setPending(false)
    }
  }, [apiId, apiKeyId, baseUrl, bodyText, headerRows, method, pathId, queryRows, range, record, shape])

  const reloadPage = useCallback(() => {
    window.location.reload()
  }, [])

  return (
    <div className="flex flex-col gap-8">
      <ExplainerStrip baseUrl={baseUrl} />

      <Panel as="section">
        <PanelHeader
          title="Request builder"
          description="The path is assembled from the four shapes the engine documents, so a path outside that grammar cannot be typed."
          action={
            <Button variant="ghost" size="sm" onClick={clearDraft} disabled={pending}>
              Clear draft
            </Button>
          }
        />
        <PanelBody className="flex flex-col gap-6">
          <div className="grid gap-5 lg:grid-cols-2">
            <SelectField
              label="Method"
              required
              value={method}
              options={METHOD_OPTIONS}
              onChange={(event) => {
                if (isSnippetMethod(event.target.value)) setMethod(event.target.value)
                setFields(null)
              }}
              hint="Whether a given path answers one is the engine's grammar, annotated below."
              error={fields?.method}
            />
            <SelectField
              label="API key row"
              required
              value={apiKeyId}
              options={keys.map((key) => ({ value: key.id, label: `${key.name} · ${key.keyPreview}` }))}
              placeholder="Choose one of your active keys"
              onChange={(event) => {
                setApiKeyId(event.target.value)
                setFields(null)
              }}
              hint="Only the row id is sent: there is no key field in this request and no key string exists to send. The preview in each label is the whole of what the browser can see."
              error={fields?.apiKeyId}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <SelectField
              label="Endpoint"
              required
              value={apiId}
              options={apis.map((api) => ({
                value: api.id,
                label: `${api.name} · ${api.tabTitle}${api.enabled ? "" : " (disabled)"}`,
              }))}
              placeholder="Choose one of your endpoints"
              onChange={(event) => {
                setApiId(event.target.value)
                setFields(null)
              }}
              hint="Its id becomes the first path segment. A disabled endpoint reads as absent to the engine, so it answers 404."
              error={fields?.apiId}
            />
            <SelectField
              label="Path shape"
              required
              value={shapeId}
              options={SHAPE_OPTIONS}
              onChange={(event) => {
                const next = event.target.value
                setShapeId(PATH_SHAPES.some((item) => item.id === next) ? (next as PathShapeId) : "list")
                setFields(null)
              }}
              hint="List or create, one record by primary key, search, or a raw A1 band — those are all the paths. There is no bulk form: the contract answers that question with No."
            />
          </div>

          {shape.input === "record" ? (
            <TextField
              label="Record — primary-key value"
              required
              value={record}
              spellCheck={false}
              autoComplete="off"
              placeholder="42"
              onChange={(event) => {
                setRecord(event.target.value)
                setFields(null)
              }}
              hint="Sent as one percent-encoded segment, so a key holding / or # cannot split into two calls. The endpoint must have a primary key column configured or the engine answers 403 operation_not_allowed."
              error={fields?.record}
              className="font-mono"
            />
          ) : null}

          {shape.input === "range" ? (
            <div className="flex flex-col gap-2">
              <TextField
                label="Range — A1 notation"
                required
                value={range}
                spellCheck={false}
                autoComplete="off"
                placeholder="A1:D20"
                onChange={(event) => {
                  setRange(event.target.value)
                  setFields(null)
                }}
                hint="The engine's own parser decides what is valid, including a Sheet1!A1:D20 tab prefix; a bad band is 400 invalid_range and a band outside the tab is refused too. Nothing is pre-checked here, so you see the engine's answer."
                error={fields?.range}
                className="font-mono"
              />
              {selectedApi !== null ? (
                <p className="text-[13px] leading-[1.6] text-dust">
                  This endpoint serves tab <InlineCode>{selectedApi.tabTitle}</InlineCode>, so a spelled
                  tab prefix must equal it.
                </p>
              ) : null}
            </div>
          ) : null}

          {selectedApi !== null && shape.input === "record" && selectedApi.primaryKeyColumn === null ? (
            <p className="border-l-2 border-warn bg-lift px-4 py-3 text-[13px] leading-[1.6] text-paper">
              This endpoint has no primary key column, so {method} on {previewPath} answers 403
              operation_not_allowed. List the rows with a filter instead.
            </p>
          ) : null}

          {selectedApi !== null &&
          !selectedApi.allowedOperations.includes(method) &&
          grammarNote(shape, method) === null ? (
            <p className="border-l-2 border-warn bg-lift px-4 py-3 text-[13px] leading-[1.6] text-paper">
              This endpoint allows {selectedApi.allowedOperations.join(", ") || "no verbs"}. {method}
              is not among them, so the engine answers 403 operation_not_allowed whatever the key
              says.
            </p>
          ) : null}

          {selectedApi !== null &&
          selectedApi.permissions === "read" &&
          BODY_METHODS.includes(method) ? (
            <p className="border-l-2 border-warn bg-lift px-4 py-3 text-[13px] leading-[1.6] text-paper">
              This endpoint is read-only, so a write verb is refused even by a key that carries
              the write scope.
            </p>
          ) : null}

          <div className="flex flex-col gap-2 border-t border-rule pt-5">
            <p className="folio">Request line</p>
            <p className="break-all font-mono text-[13px] text-mist">
              <span className="text-paper">{method}</span> {baseUrl}/{previewPath}
            </p>
            {note !== null ? (
              <p className="border-l-2 border-warn bg-lift px-4 py-3 text-[13px] leading-[1.6] text-paper">
                {note}
              </p>
            ) : null}
            {fields?.path !== undefined ? (
              <p role="alert" className="text-[13px] leading-[1.6] text-paper">
                ⚠ {fields.path}
              </p>
            ) : null}
            <PayloadPreview
              method={method}
              apiKeyId={apiKeyId}
              previewPath={previewPath}
              queryRows={queryRows}
              headerRows={headerRows}
              bodyText={bodyText}
            />
          </div>

          <RowEditor
            title="Query parameters"
            description="Replayed to the engine as repeated params, the way a URL carries them: limit, offset, sort, fields, q, column=value and the __contains / __gt operators. A search call needs q=term — an empty q is 400, and an unknown column in a filter or sort is 400 validation_failed."
            rows={queryRows}
            keyPlaceholder="limit"
            valuePlaceholder="25"
            onChange={(rows) => {
              setQueryRows(rows)
              setFields(null)
            }}
            error={fields?.query}
          />

          <RowEditor
            title="Headers"
            description="Stored in the request and echoed into the snippet, but the engine receives none of them: EngineCall has no header slot at all, so an Authorization line here is dropped by construction and can never override the key row chosen above."
            rows={headerRows}
            keyPlaceholder="X-Trace-Id"
            valuePlaceholder="playground"
            onChange={(rows) => {
              setHeaderRows(rows)
              setFields(null)
            }}
            error={fields?.headers}
            persistNote="Header rows are never saved between visits: a pasted secret has no business in localStorage, and none of these values is forwarded anyway."
          />

          <div className="flex flex-col gap-2">
            <TextArea
              label="Body — raw JSON text"
              value={bodyText}
              rows={8}
              spellCheck={false}
              autoComplete="off"
              placeholder={'{\n  "name": "new row"\n}'}
              onChange={(event) => {
                setBodyText(event.target.value)
                setFields(null)
              }}
              hint="Forwarded as the exact bytes you type; the engine validates them authoritatively. Parsed here first only so a typo does not waste a call."
              error={fields?.bodyJson}
              className="font-mono"
            />
            <p className="font-mono text-[12px] text-dust">
              {formatNumber(bodyText.length)} / {formatNumber(BODY_CHAR_CAP)} characters — the
              bodyJson ceiling of playgroundRequestSchema
            </p>
            {bodyText.trim() !== "" && !BODY_METHODS.includes(method) ? (
              <p className="text-[13px] leading-[1.6] text-paper">
                ⚠ {method} with a body: the engine still receives these bytes, but the shared snippet
                builders accept a body only on POST/PATCH/PUT, so the cURL/JS/Python example will omit it
.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-5">
            <Button variant="solid" onClick={() => void send()} disabled={pending} loading={pending}>
              {pending ? "Sending…" : "Send request"}
            </Button>
            <span aria-live="polite" className="folio">
              {pending
                ? "waiting on the engine"
                : failure !== null
                  ? "no engine answer received for this attempt"
                  : lastCall !== null
                    ? `last call · ${lastCall.response.status} ${statusText(lastCall.response.status)}`
                    : "nothing sent yet"}
            </span>
            <PillLink href={logsHref} variant="ghost" size="sm">
              Request log
            </PillLink>
          </div>

          {fields !== null ? (
            <div className="flex flex-col gap-2 border-l-2 border-edge bg-lift px-4 py-3">
              <p className="folio folio-strong">Not sent — fix this first</p>
              <p className="text-[13px] leading-[1.6] text-mist">
                Nothing left the browser, so the engine has no record of this attempt. The response
                below {lastCall !== null ? "is from the previous call." : "has not appeared yet."}
              </p>
            </div>
          ) : null}
        </PanelBody>
      </Panel>

      {failure !== null ? <FailureBlock failure={failure} onReload={reloadPage} /> : null}

      {lastCall !== null ? (
        <>
          <EngineAnswer
            response={lastCall.response}
            sent={lastCall.request}
            baseUrl={baseUrl}
            logsHref={logsHref}
            onReload={reloadPage}
          />
          <Panel as="section">
            <PanelHeader
              title="The same call as a real client"
              description="Built from the request that was just sent, by the shared snippet builders the docs use."
            />
            <PanelBody className="flex flex-col gap-4">
              {lastCall.request.headers !== undefined ? (
                <p className="text-[13px] leading-[1.6] text-dust">
                  The header rows appear below because you typed them, and a real client would send
                  them too — but the engine ignored them for this call, so reproducing it with
                  them changes nothing.
                </p>
              ) : null}
              {lastCall.bodyHiddenFromSnippet ? (
                <p className="text-[13px] leading-[1.6] text-paper">
                  ⚠ The body that was sent is not in this example: the builders refuse a body on{" "}
                  {lastCall.request.method}. The engine still received those
                  bytes, and the response above is its answer to them.
                </p>
              ) : null}
              <SnippetTabs request={lastCall.snippet} />
              <p className="text-[13px] leading-[1.6] text-dust">
                Replace <InlineCode>{API_KEY_PLACEHOLDER}</InlineCode> with a key from{" "}
                <Link href="/keys" className="text-paper underline">
                  Keys
                </Link>
                . The playground authenticates with the row id instead, so no plaintext existed here to
                copy into a snippet.
              </p>
            </PanelBody>
          </Panel>
        </>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ subviews */

/**
 * The payload as it will be serialised, kept on screen on purpose: it is the visible proof of §4.8
 * rule 2 — no key field in it, and no `keyPreview` either. Angle-bracket text marks a slot the user
 * has not filled in yet, and nothing is sent until every one of them is a real value.
 */
function PayloadPreview({
  method,
  apiKeyId,
  previewPath,
  queryRows,
  headerRows,
  bodyText,
}: {
  method: SnippetMethod
  apiKeyId: string
  previewPath: string
  queryRows: FormRow[]
  headerRows: FormRow[]
  bodyText: string
}) {
  const query = rowsToRecord(queryRows)
  const headers = headersToRecord(headerRows)
  const payload: PlaygroundRequest = {
    apiKeyId: apiKeyId === "" ? "<api_keys.id of the chosen row>" : apiKeyId,
    method,
    path: previewPath,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(bodyText.trim() !== "" ? { bodyJson: bodyText } : {}),
  }
  return (
    <details className="flex flex-col gap-2">
      <summary className="folio cursor-pointer select-none hover:text-mist">
        Payload this page sends to /api/internal/playground
      </summary>
      <pre tabIndex={0} className="codeblock">{JSON.stringify(payload, null, 2)}</pre>
      <p className="text-[13px] leading-[1.6] text-dust">
        The only key-related field is <span className="font-mono">apiKeyId</span>, a row id.
        Angle brackets mark what you have not chosen yet; those are not sent.
      </p>
    </details>
  )
}

function RowEditor({
  title,
  description,
  rows,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
  error,
  persistNote,
}: {
  title: string
  description: string
  rows: FormRow[]
  keyPlaceholder: string
  valuePlaceholder: string
  onChange: (rows: FormRow[]) => void
  error?: string
  persistNote?: string
}) {
  return (
    <fieldset className="flex flex-col gap-3 border-t border-rule pt-5">
      <legend className="folio">{title}</legend>
      <p className="max-w-[92ch] text-[13px] leading-[1.6] text-dust">{description}</p>
      {rows.length === 0 ? <p className="font-mono text-[12px] text-dust">none</p> : null}
      {rows.map((row, index) => (
        <div key={row.id} className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="folio">name</span>
            <input
              className="field font-mono text-[13px]"
              value={row.key}
              placeholder={keyPlaceholder}
              spellCheck={false}
              autoComplete="off"
              aria-label={`${title} name ${index + 1}`}
              onChange={(event) => {
                const value = event.target.value
                onChange(rows.map((item, i) => (i === index ? { ...item, key: value } : item)))
              }}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="folio">value</span>
            <input
              className="field font-mono text-[13px]"
              value={row.value}
              placeholder={valuePlaceholder}
              spellCheck={false}
              autoComplete="off"
              aria-label={`${title} value ${index + 1}`}
              onChange={(event) => {
                const value = event.target.value
                onChange(rows.map((item, i) => (i === index ? { ...item, value } : item)))
              }}
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            aria-label={`Remove ${title} row ${index + 1}`}
          >
            Remove
          </Button>
        </div>
      ))}
      {error !== undefined ? (
        <p role="alert" className="text-[13px] leading-[1.6] text-paper">
          ⚠ {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="line" size="sm" onClick={() => onChange([...rows, emptyRow(newRowId())])}>
          Add row
        </Button>
        {persistNote !== undefined ? (
          <p className="min-w-0 flex-1 text-[13px] leading-[1.6] text-dust">{persistNote}</p>
        ) : null}
      </div>
    </fieldset>
  )
}

/** §4.8's stated facts and nothing beyond them. */
function ExplainerStrip({ baseUrl }: { baseUrl: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-panel border border-rule bg-lift px-5 py-4">
      <p className="folio">How this page works</p>
      <p className="max-w-[92ch] text-[13px] leading-[1.7] text-mist">
        The playground calls the same engine a real client calls, in process, and authenticates with
        the key&apos;s <span className="text-paper">row id</span> instead of a bearer string. A
        plaintext key therefore never exists anywhere between this page and the engine: it is not
        typed, not stored, and not in these examples. Anything you can do here, a client can do too —
        one entry point, the same path grammar, the same scope and endpoint checks, the same rate-limit
        buckets, and the same request-log row.
      </p>
      <p className="font-mono text-[12px] text-dust">
        engine base: {baseUrl} · transport: POST /api/internal/playground · contract:
        docs/backend-api-contract.md §4.8
      </p>
    </div>
  )
}

function EmptyKeys({ lapsedKeyCount }: { lapsedKeyCount: number }) {
  return (
    <EmptyState
      title={lapsedKeyCount > 0 ? "None of your keys is usable" : "No active keys yet"}
      body={
        lapsedKeyCount > 0
          ? `You own ${lapsedKeyCount} ${
              lapsedKeyCount === 1 ? "key" : "keys"
            }, and every one has passed its expiry, so the engine would answer 401 for all of them. Regenerate or create one, then come back.`
          : "A playground call authenticates with one of your own key rows, so with none yet there is nothing to select. Create one — its full value is shown once, then only the preview."
      }
      action={
        <PillLink href="/keys" variant="solid" size="sm">
          Go to Keys
        </PillLink>
      }
    />
  )
}

function EmptyApis() {
  return (
    <EmptyState
      title="No endpoints yet"
      body="Every documented path starts with an endpoint id, so with none published there is no path to build. Publish one endpoint from a connected spreadsheet first."
      action={
        <PillLink href="/apis/new" variant="solid" size="sm">
          Create an endpoint
        </PillLink>
      }
    />
  )
}

/** Every arm of a call that produced no engine answer, each with its own words and its own fix. */
function FailureBlock({ failure, onReload }: { failure: Failure; onReload: () => void }) {
  if (failure.kind === "network") {
    return (
      <ErrorState
        title="The playground call never arrived"
        body="The browser could not complete the POST to /api/internal/playground — a dropped connection, an offline tab, or a server that refused before answering. No engine status, duration or body exists for this attempt, and none is shown."
        action={
          <Button variant="line" size="sm" onClick={onReload}>
            Reload the page
          </Button>
        }
      />
    )
  }

  if (failure.kind === "no_envelope") {
    return (
      <ErrorState
        title="The playground route answered, but not with a JSON envelope"
        body={`The reply carried HTTP ${failure.httpStatus} and no parseable JSON, so this page cannot say what the engine said. The likeliest cause is that the playground route is not deployed in this build yet. There is no engine status in that reply, so no status is invented.`}
        action={
          <Button variant="line" size="sm" onClick={onReload}>
            Retry
          </Button>
        }
      />
    )
  }

  if (failure.kind === "unexpected") {
    return (
      <ErrorState
        title="The playground reply did not match its contract"
        body={`HTTP ${failure.httpStatus} returned JSON, but neither an error envelope nor a complete { status, durationMs, headers, body } answer. `}
        action={
          <Button variant="line" size="sm" onClick={onReload}>
            Retry
          </Button>
        }
      />
    )
  }

  const { code, message, fields: serverFields } = failure
  const fieldEntries = serverFields === undefined ? [] : Object.entries(serverFields)

  if (code === "playground_unreachable") {
    return (
      <ErrorState
        title="The engine did not answer"
        body={`${message} The playground route ran and the engine produced no outcome, so there is no status, no duration and no body for this attempt — and none is invented (`}
        code={code}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="line" size="sm" onClick={onReload}>
              Retry
            </Button>
            <PillLink href="/logs" variant="ghost" size="sm">
              Request log
            </PillLink>
          </div>
        }
      />
    )
  }

  if (code === "invalid_key") {
    return (
      <ErrorState
        title="That key row is not usable by this session"
        body={`${message} A playground request carries only api_keys.id, and the engine matches it against your session owner in one statement — a row that is not yours and a row that is gone answer identically on purpose, so this page cannot say which it is. Reload if this page's key list has gone stale. When the refusal comes from the engine instead of this route, it is shown as the 401 response it is.`}
        code={code}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="line" size="sm" onClick={onReload}>
              Reload the key list
            </Button>
            <PillLink href="/keys" variant="ghost" size="sm">
              Keys
            </PillLink>
          </div>
        }
      />
    )
  }

  if (code === "unauthenticated") {
    return (
      <ErrorState
        title="Your session is no longer valid"
        body={`${message} The route wrapper stopped this request before its handler ran, so the engine never saw it: nothing was sent and nothing was logged. Sign in again to continue — your draft stays in this browser.`}
        code={code}
        action={
          <PillLink href="/login" variant="solid" size="sm">
            Sign in
          </PillLink>
        }
      />
    )
  }

  if (code === "validation_failed") {
    return (
      <ErrorState
        title="The playground refused the shape of this request"
        body={`${message} playgroundRequestSchema checks the request before the engine is called, so the engine never ran and there is no engine status to show.`}
        code={code}
        action={
          fieldEntries.length > 0 ? (
            <FieldList entries={fieldEntries} />
          ) : (
            <Button variant="line" size="sm" onClick={onReload}>
              Retry
            </Button>
          )
        }
      />
    )
  }

  return (
    <ErrorState
      title="The playground returned an error"
      body={`${message} No engine answer came back with it, so there is no status, duration or body to show for this attempt.`}
      code={code}
      action={
        <div className="flex flex-col gap-3">
          {fieldEntries.length > 0 ? <FieldList entries={fieldEntries} /> : null}
          <Button variant="line" size="sm" onClick={onReload}>
            Retry
          </Button>
        </div>
      }
    />
  )
}

function FieldList({ entries }: { entries: Array<[string, string]> }) {
  return (
    <ul className="flex flex-col gap-1 text-[13px] leading-[1.6] text-mist">
      {entries.map(([field, issue]) => (
        <li key={field}>
          <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-dust">{field}</span>{" "}
          {issue}
        </li>
      ))}
    </ul>
  )
}
