import "server-only"

import { fail, type ActionError, type ErrorCategory } from "@/lib/action-result"
import type { SnippetMethod } from "@/lib/snippets"
import { GoogleApiError, fromGoogleError, type GoogleErrorKind } from "@/server/google/errors"
import { GoogleAuthError } from "@/server/google/tokens"

/*
 * The engine's wire vocabulary (`backend-api-contract.md` §1.2): the codes, the statuses they carry,
 * and the one throw path that keeps them from drifting. Nothing in this file touches the database,
 * Google, or the request — it exists so `handle.ts` reads as the lifecycle only.
 */

/** The same value `src/server/http/request.ts#json` sets, so both surfaces advertise JSON alike. */
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8"

/** A rejection with its §1.2 envelope and the HTTP status the contract pins for it. */
export class EngineRejection {
  constructor(
    readonly status: number,
    readonly error: ActionError,
    readonly headers: Record<string, string> = {}
  ) {}
}

/**
 * Throw the rejection. Every guard goes through here so a `409` cannot silently become a `400`,
 * and so `handleEngineCall`'s single catch builds the envelope once.
 */
export function reject(status: number, error: ActionError, headers?: Record<string, string>): never {
  throw new EngineRejection(status, error, headers)
}

/**
 * Thrown by the default Sheets factory when the API's connection cannot serve Google at all: a
 * missing or `reauth_required`/`disconnected` row is 503 `google_not_connected` (§4.4).
 */
export class EngineNotConnected extends Error {
  constructor() {
    super("google_not_connected")
    this.name = "EngineNotConnected"
  }
}

/**
 * One message for "no such id", "disabled", "sheet inaccessible", "owner disabled" and "not
 * yours": the route must not be an existence oracle (`security.md` §3 items 2 and 4).
 */
export function apiNotFound(): ActionError {
  return fail("api_not_found", "No API was found with that id.", "not_found")
}

/** §1.1: a key that is absent, revoked, expired, foreign or simply wrong. */
export const INVALID_KEY: ActionError = fail("invalid_key", "That API key is not valid.", "auth")

export function missingKey(): ActionError {
  return fail("missing_key", "Send your API key in the Authorization header: Bearer sz_live_…", "auth")
}

export function invalidJson(message: string): ActionError {
  return fail("invalid_json", message, "validation")
}

export function validationFailed(message: string, fields: Record<string, string>): ActionError {
  return fail("validation_failed", message, "validation", fields)
}

export function bodyTooLarge(): ActionError {
  return fail("body_too_large", "The request body is larger than 1 MB.", "validation")
}

export function rateLimited(retryAfterSeconds: number): ActionError {
  // §4.4: `fields.retry_after` is the contract vehicle for a rate_limited answer, so a route reads
  // the `Retry-After` header and an action reads the same number out of one envelope.
  return fail(
    "rate_limited",
    "This API key has used up its requests for the current window. Try again later.",
    "rate_limit",
    { retry_after: String(retryAfterSeconds) }
  )
}

export function writeRequiresPrimaryKey(): ActionError {
  return fail(
    "write_requires_primary_key",
    "This API has no primary key column, so records cannot be addressed for PATCH, PUT or DELETE. Set a primary key first.",
    "auth"
  )
}

export function readRequiresPrimaryKey(): ActionError {
  // §1.3: a single-record read without a PK is `operation_not_allowed`, with the documented fix.
  return fail(
    "operation_not_allowed",
    "This API has no primary key column, so a single record cannot be read by id. Set a primary key or list records and filter instead.",
    "auth"
  )
}

/**
 * The §1.2/§1.5 answer for a primary-key lookup that matched nothing or matched twice. `fail()` is
 * called with THREE arguments on the 404 arm so no `fields` key appears — an empty map would still
 * be truthy and would serialise as `"fields": {}`.
 */
export function primaryKeyError(matches: number, column: string, value: string): ActionError {
  if (matches === 0) {
    return fail("record_not_found", `No record with id=${value}`, "not_found")
  }
  return fail(
    "ambiguous_record",
    `The primary key column "${column}" matched ${matches} records, so none of them can be chosen. Make the value unique or filter the list instead.`,
    "validation"
  )
}

/** §1.2 422 `header_mismatch`: offenders first, then what the sheet actually offers. */
export function headerMismatch(message: string, offenders: string[], headers: string[]): ActionError {
  if (offenders.length === 0 && headers.length === 0) {
    return fail("header_mismatch", message, "validation")
  }
  return fail("header_mismatch", message, "validation", {
    ...(offenders.length === 0 ? {} : { fields: offenders.join(", ") }),
    ...(headers.length === 0 ? {} : { available: headers.join(", ") }),
  })
}

export function invalidRange(a1: string, detail: string): ActionError {
  const shown = a1 === "" ? "(empty)" : a1
  return fail("invalid_range", `"${shown}" is not a range this API can serve. ${detail}`, "validation")
}

export function tabNotFound(): ActionError {
  // §1.2 lists `tab_not_found` at 422: the API is real and authorized, the tab is gone. Category
  // `validation` per the same row (`google/validation` splits as google for the sheet, validation
  // for the tab and the header).
  return fail(
    "tab_not_found",
    "That tab is no longer in this spreadsheet. Refresh the spreadsheet's tabs and try again.",
    "validation"
  )
}

function keyScopeMessage(method: SnippetMethod): string {
  const scope = method === "GET" ? "read" : "write"
  return `This API key does not have the ${scope} scope this operation needs.`
}

/** The 403 texts. Each names the caller's own fix and says nothing about the API behind it. */
export function restrictedMessage(code: string, method: SnippetMethod): string {
  switch (code) {
    case "key_restricted":
      return "This API key is restricted to a different set of APIs."
    case "key_scope_insufficient":
      return keyScopeMessage(method)
    case "operation_not_allowed":
      return `This API does not allow ${method} requests.`
    default:
      // An authorization code this module does not know is still a 403, and still leaks nothing.
      return "This request is not allowed for this API key."
  }
}

/* ---------------------------------------------------------------- Google status table (§1.2, §1.5) */

/** THE engine's table — it wins over `src/server/google/errors.ts#KIND_RULES`, which is the
 * dashboard's mapping (`backend-api-contract.md` §4.4) and answers 503 for codes §1.2 pins at 422. */
export const GOOGLE_RULES: Record<GoogleErrorKind, { status: number; code: string; category: ErrorCategory; message: string }> = {
  reauth: {
    status: 503,
    code: "google_reauth_required",
    category: "google",
    message: "Google needs the owner of this spreadsheet to reconnect their account before this API can serve data.",
  },
  inaccessible: {
    status: 422,
    code: "google_sheet_inaccessible",
    category: "google",
    message: "Sheet Zaber could not open that spreadsheet for this API. Check that the tab still exists and that the connected Google account can reach it.",
  },
  rate_limited: {
    status: 503,
    code: "google_quota_exceeded",
    category: "google",
    message: "Google is rate-limiting Sheet Zaber right now. Try again in a moment.",
  },
  invalid_request: {
    status: 400,
    code: "invalid_range",
    category: "validation",
    message: "Sheet Zaber could not build that request for Google.",
  },
  upstream: {
    status: 503,
    code: "google_unavailable",
    category: "google",
    message: "Google is unavailable right now. Try again in a moment.",
  },
  internal: {
    status: 500,
    code: "internal_error",
    category: "internal",
    message: "The request could not be completed.",
  },
}

/**
 * Normalise anything a Google call (or the default Sheets factory) threw into a `GoogleApiError`.
 * A `GoogleAuthError` — a token this process cannot mint, from a revoked refresh token or a
 * decryption failure — is a 401-class failure, which is what puts it on the single-retry path and,
 * when the retry cannot mint either, at 503 `google_reauth_required` (§1.5).
 */
export function toGoogleError(error: unknown): GoogleApiError {
  if (error instanceof GoogleApiError) return error
  if (error instanceof GoogleAuthError) {
    return new GoogleApiError(401, "reauth", "Google needs a fresh access token", error.reason)
  }
  // Anything with no HTTP status (a TypeError, a thrown string, a stub's plain `Error`) classifies
  // as `internal` there, so a bug in the engine can never be mistaken for a Google outage.
  return fromGoogleError(error)
}

/**
 * Google's own `Retry-After`, when it supplied one (§1.5 "Retry-After passthrough").
 *
 * `fromGoogleError` keeps only `status`/`kind`/`reason`, so the header has to be read off the RAW
 * thrown value before normalising: a `GaxiosError` puts it in `response.headers['retry-after']`
 * (case-insensitively) and Google's quota bodies also say "Please retry in 30.0s". The test stub
 * carries no header at all, which is why this extractor is unit-tested separately.
 */
export function retryAfterFromError(error: unknown): number | null {
  const seconds = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.ceil(value)
    if (typeof value !== "string") return null
    const text = value.trim()
    if (/^\d+$/.test(text)) return Number(text)
    const inSeconds = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(text)
    return inSeconds === null ? null : Math.ceil(Number(inSeconds[1]))
  }

  if (typeof error !== "object" || error === null) return null
  const record = error as Record<string, unknown>
  const direct = seconds(record["retryAfter"]) ?? seconds(record["retry_after"]) ?? seconds(record["RetryAfter"])
  if (direct !== null) return direct

  const response = record["response"]
  if (typeof response !== "object" || response === null) return seconds(record["message"])
  const headers = (response as Record<string, unknown>)["headers"]
  if (typeof headers !== "object" || headers === null) return seconds(record["message"])
  const map = headers as Record<string, unknown>
  return seconds(map["retry-after"] ?? map["Retry-After"] ?? map["RETRY-AFTER"]) ?? seconds(record["message"])
}
