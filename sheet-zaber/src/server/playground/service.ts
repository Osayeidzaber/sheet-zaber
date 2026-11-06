import "server-only"

import { fail, ok } from "@/lib/action-result"
import type { PlaygroundRequest, PlaygroundResponse, PlaygroundResult } from "@/lib/playground"
import { playgroundRequestSchema } from "@/lib/schemas"
import type { EngineCall } from "@/server/engine/types"

/*
 * The playground proxy (`backend-api-contract.md` §4.8, `security.md` §4).
 *
 * The mechanism is already ruled and is not re-opened here: the engine is a FUNCTION, so this
 * service awaits `handleEngineCall` in process — no loopback HTTP, no self-request, no base URL.
 * `/api/v1/**` and `POST /api/internal/playground` are two adapters over the one entry point, so
 * anything the playground can do a real client can do (`architecture.md` §3).
 *
 * Three contract rules drive every line below:
 *
 * 1. STATUS IS VERBATIM. The engine's HTTP status is copied into `data.status` unchanged. A
 *    401/404/409/422/429 from `/api/v1` is an `ok: true` playground result, because the playground
 *    call itself succeeded; re-mapping it to 200 would hide the answer and re-mapping it to 500
 *    would turn the user's own typo into a platform fault.
 * 2. THE PLAINTEXT KEY NEVER REACHES THE BROWSER. `PlaygroundRequest` has no key field, and this
 *    service never looks at `headers`: `EngineCall` has no header slot at all, so there is no
 *    channel through which an `Authorization` value could travel. Authentication is the
 *    `{ kind: "keyId", apiKeyId, ownerId: session user }` arm — `api_keys` stores a hash, so no
 *    plaintext exists to inject (`integration-status.md` v0.3). Ownership is resolved in the
 *    engine's single `WHERE id AND user_id` statement, NOT re-checked here: duplicating the rule
 *    would create a second answer shape and turn this route into an existence oracle for other
 *    users' keys (`security.md` §3 item 2). A foreign or missing `apiKeyId` therefore comes back
 *    as the engine's own `invalid_key`/401.
 * 3. AN UNREACHABLE ENGINE IS AN ERROR, NOT A FAKE RESPONSE. If the call throws, or resolves to
 *    something that is not an outcome, the answer is `playground_unreachable` (category
 *    `internal`). A fabricated `status: 500` is forbidden: `PlaygroundResponse` is built only from
 *    bytes the engine actually produced.
 *
 * The one thing this file absorbs is the shape the engine's answer arrives in. `EngineOutcome`
 * publishes `body: string` and no duration, while the engine was, during this same worktree,
 * handing back the envelope as an OBJECT plus its own measured `durationMs`. Both are tolerated
 * here — a string body is forwarded byte-for-byte, an object body is serialised once, and the
 * duration is read from `meta.duration_ms` first — so the adaptation lives in this caller and
 * `src/server/engine/**` stays untouched.
 */

/* ------------------------------------------------------------------ deps seam */

/**
 * Everything the proxy needs from the engine, as one injectable function. Mirrors
 * `RedeemDeps`/`productionDeps` in `src/server/invitations/service.ts`: the rules above are only
 * testable if the thing being proxied can be replaced, and the honest test of a proxy is a stub
 * that records what it was handed.
 *
 * The return is `unknown`, not `EngineOutcome`, on purpose: rule 3 says an outcome is whatever the
 * engine ACTUALLY ANSWERED, so the value is validated (`toPlaygroundResponse`) rather than trusted.
 */
export type PlaygroundDeps = {
  callEngine(call: EngineCall): Promise<unknown>
}

export type PlaygroundOptions = { deps?: Partial<PlaygroundDeps> }

/*
 * The production arm imports the engine lazily. Two reasons, both mechanical: a `/api/internal/**`
 * test must be able to run the proxy without loading the engine module (the seam above), and the
 * engine binds the pool and the rate-limit queries at import time. It is still an in-process
 * function call — `import()`, not `fetch()` (§4.8).
 */
const productionDeps: PlaygroundDeps = {
  callEngine: async (call) => {
    const { handleEngineCall } = await import("@/server/engine/handle")
    return handleEngineCall(call)
  },
}

/* ------------------------------------------------------------------ errors */

function zodFields(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "input"
    if (!(key in fields)) fields[key] = issue.message
  }
  return fields
}

function validationFailed(fields: Record<string, string>) {
  return fail("validation_failed", "The playground request is not valid.", "validation", fields)
}

/** §4.8's third rule, and the ONLY thing this service answers when the engine said nothing. */
function playgroundUnreachable() {
  return fail(
    "playground_unreachable",
    "The API engine did not answer the playground call. No request was completed — try again in a moment.",
    "internal"
  )
}

/* ------------------------------------------------------------------ EngineCall builder */

/**
 * Percent-decode one segment, falling back to the raw text.
 *
 * `decodeURIComponent` throws on a malformed escape (`%zz`, a trailing `%`), and the playground
 * must not turn a typo in the path box into a 500. Passing the segment through un-decoded means
 * the engine's path grammar (§1.3) simply fails to match it, which is the same `api_not_found`/404
 * as any other unknown path — no new status, no oracle, no crash.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * The `path` the user typed, as the engine wants it: split on `/`, empty segments dropped, each
 * survivor percent-decoded. Decoding happens AFTER splitting, so a `%2F` inside a segment stays one
 * segment — exactly what the public route hands the engine for a real client URL.
 */
export function pathSegmentsFor(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.trim().length > 0)
    .map(decodeSegment)
}

/** A `string[]` query value becomes repeated params, the same way `URLSearchParams` reads one. */
function searchParamsFor(query: Record<string, string | string[]> | undefined): URLSearchParams {
  const params = new URLSearchParams()
  if (query === undefined) return params
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item)
    } else {
      params.append(key, value)
    }
  }
  return params
}

/**
 * The whole adaptation, in one place: `PlaygroundRequest` + session owner + client IP → `EngineCall`.
 *
 * Note what is NOT here: `request.headers`. There is no header field on `EngineCall`, so a client
 * that types an `Authorization: Bearer sz_live_…` line into the playground gets it dropped by
 * construction rather than by a filter (§4.8 "the injected Authorization never exists"). `ip` is
 * forwarded because it is a rate-limit bucket dimension and a playground call should be bucketed
 * like the real client call it stands in for; it is never stored (`security.md` §2).
 */
function buildEngineCall(request: PlaygroundRequest, userId: string, ip: string | null): EngineCall {
  return {
    auth: { kind: "keyId", apiKeyId: request.apiKeyId, ownerId: userId },
    method: request.method,
    pathSegments: pathSegmentsFor(request.path),
    searchParams: searchParamsFor(request.query),
    bodyText: request.bodyJson ?? null,
    ip,
  }
}

/* ------------------------------------------------------------------ answer → PlaygroundResponse */

/** §4.8: `EngineOutcome.headers` minus `content-type`, which the route sets itself. Nothing added. */
function headersFor(headers: unknown): Record<string, string> {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === "content-type") continue
    if (typeof value !== "string") continue
    out[key] = value
  }
  return out
}

/**
 * The envelope's own `meta.duration_ms` — the only duration this file may read (never a fabricated
 * number, never a re-format). It handles both body shapes: the object the engine handed back while
 * it was mid-flight, and the serialised string `EngineOutcome` publishes (§4.8), which is parsed
 * here purely to recover that one number.
 */
function metaDurationMs(body: unknown): number | null {
  let envelope: unknown = body
  if (typeof body === "string") {
    try {
      envelope = JSON.parse(body) as unknown
    } catch {
      return null
    }
  }
  if (envelope === null || typeof envelope !== "object") return null
  const meta = (envelope as { meta?: unknown }).meta
  if (meta === null || typeof meta !== "object") return null
  const value = (meta as { duration_ms?: unknown }).duration_ms
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Rule 1 and rule 3, together. Returns `null` exactly when the engine did not answer with an
 * outcome, which the caller turns into `playground_unreachable`.
 *
 * `measuredMs` is the local wall clock around the call, used ONLY when the engine produced no
 * duration of its own at all. The precedence is the contract's own: §4.8 names
 * `meta.duration_ms` in the success envelope, because that is the number the request log row
 * carries, so the envelope is read first, then an explicit `durationMs` on the answer (the shape
 * the engine passed through while it was being written), and only then the local clock.
 */
function toPlaygroundResponse(answer: unknown, measuredMs: number): PlaygroundResponse | null {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return null
  const source = answer as { status?: unknown; body?: unknown; headers?: unknown; durationMs?: unknown }

  const status = source.status
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return null

  // A missing body means no answer, and `String(undefined)` would be a fabricated response (§1.2).
  if (source.body === undefined || source.body === null) return null

  let body: string
  if (typeof source.body === "string") {
    body = source.body
  } else {
    try {
      const text = JSON.stringify(source.body)
      if (typeof text !== "string") return null
      body = text
    } catch {
      return null
    }
  }

  const explicitDuration =
    typeof source.durationMs === "number" && Number.isFinite(source.durationMs) ? source.durationMs : null

  const durationMs = metaDurationMs(body) ?? explicitDuration ?? measuredMs

  return { status, durationMs, headers: headersFor(source.headers), body }
}

/* ------------------------------------------------------------------ entry point */

/**
 * One playground call: validate, build the `EngineCall`, await the engine, forward the answer.
 *
 * `userId` is the LAST required argument like every other user-scoped verb (§4.7) and comes from
 * the session guard, never from the body — a `userId` in the payload would be the oracle this
 * design exists to avoid.
 */
export async function runPlaygroundRequest(
  input: unknown,
  userId: string,
  ip: string | null,
  opts?: PlaygroundOptions
): Promise<PlaygroundResult> {
  const parsed = playgroundRequestSchema.safeParse(input)
  if (!parsed.success) return validationFailed(zodFields(parsed.error))

  // The assignment is the drift check: `playgroundRequestSchema` and §4.8's type must agree (C1).
  const request: PlaygroundRequest = parsed.data
  const deps: PlaygroundDeps = { ...productionDeps, ...opts?.deps }

  const started = performance.now()
  let answer: unknown
  try {
    answer = await deps.callEngine(buildEngineCall(request, userId, ip))
  } catch (error) {
    // Never echo the cause (§1.2); the detail belongs in the server log.
    console.error("[playground] engine call failed", error instanceof Error ? error.message : error)
    return playgroundUnreachable()
  }

  const response = toPlaygroundResponse(answer, Math.max(0, Math.round(performance.now() - started)))
  if (response === null) {
    console.error("[playground] engine produced no outcome")
    return playgroundUnreachable()
  }
  return ok(response)
}
