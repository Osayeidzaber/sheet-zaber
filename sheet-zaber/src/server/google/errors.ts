/*
 * Google failure taxonomy (`google-integration.md` §2/§3, `backend-api-contract.md` §4.4).
 *
 * `src/server/google/sheets.ts` funnels EVERY thrown value through `fromGoogleError`, so the
 * layers above branch on `GoogleApiError.kind` and never on an SDK type. That is what keeps the
 * "only `src/server/google/**` may import `googleapis`" rule (architecture.md §5) enforceable:
 * nothing outside that folder needs to know what a `GaxiosError` looks like.
 *
 * status → kind → (code, category) → ActionResult/HTTP:
 *   401            reauth          google_reauth_required   google      503  (§2 refresh path)
 *   403, 404       inaccessible    google_sheet_inaccessible google     503  (§3 step 3)
 *   429            rate_limited    rate_limited             rate_limit   429
 *   400            invalid_request invalid_range            validation   400
 *   500, 502, 503,
 *   504            upstream        google_unavailable       google       503
 *   anything else  internal        internal_error           internal     500
 *
 * Nothing is swallowed: an error we cannot classify becomes a typed 500-class `internal`
 * error, never `undefined` and never a bare rethrow into a server action.
 */

import {
  fail,
  internalError,
  type ActionError,
  type ErrorCategory,
} from "@/lib/action-result"

/** The statuses the taxonomy recognizes explicitly; every other status falls through to `internal`. */
export type GoogleStatus = 401 | 403 | 404 | 429 | 500 | 503

export type GoogleErrorKind =
  /** The grant died or the token is no longer accepted: refresh once, then `reauth_required`. */
  | "reauth"
  /** This connection cannot open this sheet — the §3 permission boundary answered "no". */
  | "inaccessible"
  /** Google is throttling us; the row/state is untouched. */
  | "rate_limited"
  /** Google's own failure (5xx); nothing the user did wrong. */
  | "upstream"
  /** We sent a request Google refused to parse (bad A1 range, bad row index). */
  | "invalid_request"
  /** Unclassifiable — reported as an internal error, never silently absorbed. */
  | "internal"

export class GoogleApiError extends Error {
  readonly status: number
  readonly kind: GoogleErrorKind
  /** Google's machine-readable reason (`INSUFFICIENT_PERMISSIONS`, `quotaExceeded`, …) when present. */
  readonly reason: string | null

  constructor(status: number, kind: GoogleErrorKind, message: string, reason: string | null = null) {
    super(message)
    this.name = "GoogleApiError"
    this.status = status
    this.kind = kind
    this.reason = reason
  }
}

const GOOGLE_STATUSES: readonly GoogleStatus[] = [401, 403, 404, 429, 500, 503]

/** Codes that exist outside `GoogleStatus` but still classify cleanly. */
const ADDITIONAL_STATUS_KINDS: ReadonlyMap<number, GoogleErrorKind> = new Map([
  [400, "invalid_request"],
  [422, "invalid_request"],
  [502, "upstream"],
  [504, "upstream"],
])

function kindForStatus(status: number): GoogleErrorKind {
  const known = GOOGLE_STATUSES.find((candidate) => candidate === status)
  if (known !== undefined) {
    switch (known) {
      case 401:
        return "reauth"
      case 403:
      case 404:
        return "inaccessible"
      case 429:
        return "rate_limited"
      default:
        return "upstream"
    }
  }
  return ADDITIONAL_STATUS_KINDS.get(status) ?? "internal"
}

const MESSAGE_REAUTH =
  "Google needs you to reconnect your account before Sheet Zaber can read that spreadsheet."
const MESSAGE_INACCESSIBLE =
  "Sheet Zaber could not open that spreadsheet. Check the link and that this Google account can access it."
const MESSAGE_RATE_LIMITED = "Google is rate-limiting requests right now. Try again in a moment."
const MESSAGE_UNAVAILABLE = "Google is unavailable right now. Try again in a moment."
const MESSAGE_INVALID_REQUEST = "Sheet Zaber could not build that request for Google."

/** One row per kind: the envelope every caller hands back, so no service re-invents the table. */
const KIND_RULES: Readonly<Record<GoogleErrorKind, { code: string; category: ErrorCategory; message: string }>> = {
  reauth: { code: "google_reauth_required", category: "google", message: MESSAGE_REAUTH },
  inaccessible: { code: "google_sheet_inaccessible", category: "google", message: MESSAGE_INACCESSIBLE },
  rate_limited: { code: "rate_limited", category: "rate_limit", message: MESSAGE_RATE_LIMITED },
  upstream: { code: "google_unavailable", category: "google", message: MESSAGE_UNAVAILABLE },
  invalid_request: { code: "invalid_range", category: "validation", message: MESSAGE_INVALID_REQUEST },
  internal: { code: "internal_error", category: "internal", message: "The request could not be completed." },
}

export function googleErrorKindForStatus(status: number): GoogleErrorKind {
  return kindForStatus(status)
}

/**
 * The envelope for a Google failure. `internal` deliberately routes through `internalError()`
 * so an unclassifiable cause never reaches the browser (§4.4 "messages … never contain … ").
 */
export function googleActionError(error: unknown): ActionError {
  const apiError = error instanceof GoogleApiError ? error : fromGoogleError(error)
  const rule = KIND_RULES[apiError.kind]
  if (rule.category === "internal") return internalError()
  return fail(rule.code, rule.message, rule.category)
}

export function isReauthRequired(error: unknown): boolean {
  return classify(error).kind === "reauth"
}

export function isInaccessible(error: unknown): boolean {
  return classify(error).kind === "inaccessible"
}

function classify(error: unknown): GoogleApiError {
  return error instanceof GoogleApiError ? error : fromGoogleError(error)
}

/* ---------------------------------------------------------------- narrowing helpers */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** Google reports status as a number; `googleapis`' older shapes and the Sheets stub use "401". */
function asStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value
  const text = asString(value)
  if (text === undefined || !/^[1-5]\d\d$/.test(text)) return undefined
  return Number(text)
}

/**
 * HTTP status of a thrown value, in the order the transports actually populate it:
 * `GaxiosError.status` (set whenever there is a response) → `GaxiosError.code` (the AIP-193
 * body's `error.code`) → `response.status` → the legacy `GoogleError.code` → `cause`.
 */
function statusOf(error: unknown, depth = 0): number | undefined {
  if (depth > 3) return undefined
  const record = asRecord(error)
  if (record === undefined) return undefined

  for (const key of ["status", "code"] as const) {
    const found = asStatus(record[key])
    if (found !== undefined) return found
  }
  const response = asRecord(record["response"])
  const fromResponse =
    response === undefined ? undefined : asStatus(response["status"]) ?? bodyStatus(response["data"])
  if (fromResponse !== undefined) return fromResponse

  const data = record["data"]
  const fromData = bodyStatus(data)
  if (fromData !== undefined) return fromData

  return statusOf(record["cause"], depth + 1)
}

function bodyStatus(value: unknown): number | undefined {
  const container = asRecord(value)
  if (container === undefined) return undefined
  const direct = asStatus(container["status"]) ?? asStatus(container["code"])
  if (direct !== undefined) return direct
  const inner = asRecord(container["error"])
  return inner === undefined ? undefined : asStatus(inner["status"]) ?? asStatus(inner["code"])
}

/**
 * Google's machine reason. v4 bodies use `error.errors[].reason` (legacy) or
 * `error.details[].reason` (AIP-193 `ErrorInfo`); the `status` string ("PERMISSION_DENIED")
 * is the last resort so `reason` is rarely null in practice.
 */
function reasonsIn(container: Record<string, unknown>): string | null {
  for (const key of ["errors", "details"] as const) {
    const entries = container[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const item = asRecord(entry)
      const reason = item === undefined ? undefined : asString(item["reason"])
      if (reason !== undefined) return reason
    }
  }
  return null
}

function isAipStatus(value: string): boolean {
  return /^[A-Z_]{3,}$/.test(value)
}

function reasonOf(error: unknown, depth = 0): string | null {
  if (depth > 4) return null
  const record = asRecord(error)
  if (record === undefined) return null

  const direct = reasonsIn(record)
  if (direct !== null) return direct

  // The containers Google's bodies actually use, in the order the transports nest them.
  for (const key of ["error", "response", "data", "cause"] as const) {
    const nested = record[key]
    const fromNested = reasonOf(nested, depth + 1)
    if (fromNested !== null) return fromNested
    const container = asRecord(nested)
    const status = container === undefined ? undefined : asString(container["status"])
    if (status !== undefined && isAipStatus(status)) return status
  }

  const own = asString(record["status"])
  return own !== undefined && isAipStatus(own) ? own : null
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  const record = asRecord(error)
  const inner = record === undefined ? undefined : asRecord(record["error"])
  const fromInner = inner === undefined ? undefined : asString(inner["message"])
  return (
    asString(record?.["message"]) ??
    fromInner ??
    "Google request failed"
  )
}

/**
 * The single entry point for a Google failure. Accepts whatever `googleapis` threw (a
 * `GaxiosError` carrying a response, an older `GoogleError` with a numeric `code`), the
 * in-memory Sheets stub's `SheetsStubError` (`status: "401"`, `code: 401`), or a plain
 * `Error`/non-object — and always returns a typed `GoogleApiError`.
 */
export function fromGoogleError(error: unknown): GoogleApiError {
  if (error instanceof GoogleApiError) return error

  const status = statusOf(error)
  const reason = reasonOf(error)
  const message = messageOf(error)
  if (status === undefined) {
    // No HTTP status at all (transport failure, programmer error, thrown string): a typed 500
    // class so callers still branch on a kind instead of swallowing it.
    return new GoogleApiError(500, "internal", message, reason)
  }
  return new GoogleApiError(status, kindForStatus(status), message, reason)
}
