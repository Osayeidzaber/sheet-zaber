/*
 * Result envelope for every server action and internal route
 * (backend-api-contract.md §4.4). Client-importable: no DB, no env, no server-only.
 */

export type ErrorCategory =
  | "auth"
  | "rate_limit"
  | "validation"
  | "google"
  | "not_found"
  | "internal"

/**
 * `ok` is a TYPE-only discriminant so `result.ok === true` narrows the union; `fail()`
 * never assigns it, so the wire envelope stays exactly `{ error: { … } }`
 * (`backend-api-contract.md` §1.4/§4.4). Authoritative test is `isActionError`.
 */
export type ActionError = {
  ok?: false
  error: {
    code: string
    message: string
    category: ErrorCategory
    fields?: Record<string, string>
  }
}

export type ActionResult<T> = { ok: true; data: T } | ActionError

/** Internal category → HTTP status for JSON routes; server actions carry no status. */
export const CATEGORY_STATUS: Record<ErrorCategory, number> = {
  validation: 400,
  auth: 401,
  not_found: 404,
  rate_limit: 429,
  google: 503,
  internal: 500,
}

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}

export function fail(
  code: string,
  message: string,
  category: ErrorCategory,
  fields?: Record<string, string>
): ActionError {
  return { error: fields ? { code, message, category, fields } : { code, message, category } }
}

export function isActionError(result: object): result is ActionError {
  return "error" in result
}

/** Never echoes a cause: the detail stays server-side in the log. */
export function internalError(): ActionError {
  return fail("internal_error", "The request could not be completed.", "internal")
}

export function statusFor(result: ActionError): number {
  return CATEGORY_STATUS[result.error.category] ?? 500
}
