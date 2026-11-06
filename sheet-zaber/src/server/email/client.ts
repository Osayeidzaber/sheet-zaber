import "server-only"

import { fail, ok, type ActionError, type ActionResult } from "@/lib/action-result"
import { env } from "@/lib/env"

/*
 * Resend transport — the ONLY file that talks to api.resend.com (`backend-api-contract.md` §1.2
 * category discipline applied to a third party). No npm dependency: the documented REST shape is
 * `POST https://api.resend.com/emails` with `Authorization: Bearer ${RESEND_API_KEY}` and a JSON
 * body `{ from, to: string[], subject, html, text }`; a success is 2xx with `{ id }` in the body,
 * and failures are `{ statusCode, name, message }` — e.g. `missing_api_key` (401),
 * `validation_error` (400/403/422, which covers a rejected recipient or an unverified sender),
 * `rate_limit_exceeded` (429).
 *
 * Two rules the rest of the server relies on:
 *
 * 1. The API key never leaves this file except inside the `Authorization` header. Error messages
 *    are ours, fixed strings; Resend's `message` is never echoed, so neither a key nor request
 *    content (an invitation code!) can ride it back out in an error body.
 * 2. A failure is always an `ActionResult`, never a throw — callers decide whether a refused send
 *    matters (`src/server/invitations/service.ts` turns it into `accepted: false`).
 */

export const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails"

/** Bound the wait: a hung Resend must not hold a route open indefinitely. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** Same ceiling the public API enforces on request bodies (§1.2 `body_too_large` >1 MB). */
export const MAX_EMAIL_BODY_BYTES = 1_000_000

export type EmailMessage = {
  to: string
  subject: string
  text: string
  html: string
}

export type EmailSendConfig = {
  apiKey: string | undefined
  from: string | undefined
}

/** Test seam: the transport is injectable exactly like `RedeemDeps`, so no test ever opens a socket. */
export type EmailTransportDeps = {
  fetchImpl: typeof globalThis.fetch
  config: EmailSendConfig
  timeoutMs: number
}

/** Read through `src/lib/env.ts` only — `.env.local` never gets touched by this module directly. */
export function readEmailSendConfig(): EmailSendConfig {
  return { apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM_EMAIL }
}

/**
 * Config absence is a typed failure at CALL time, not a boot failure and not a guess. There is
 * deliberately no fallback sender (no `onboarding@resend.dev`): the sender must be a domain the
 * owner verified in the Resend dashboard, so "no from address" stops here.
 */
export function emailSendConfigError(config: EmailSendConfig): ActionError | null {
  if (!config.from) {
    return fail(
      "email_from_missing",
      "No sender address is configured. Set RESEND_FROM_EMAIL to an address on a domain you verified with the email provider.",
      "validation"
    )
  }
  if (!config.apiKey) {
    return fail("email_not_configured", "Outbound email is not configured on this server.", "internal")
  }
  return null
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function resendErrorName(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined
  const name = (json as { name?: unknown }).name
  return typeof name === "string" ? name : undefined
}

export async function sendEmail(
  message: EmailMessage,
  opts?: { deps?: Partial<EmailTransportDeps> }
): Promise<ActionResult<{ id: string }>> {
  const deps: EmailTransportDeps = {
    fetchImpl: globalThis.fetch,
    config: readEmailSendConfig(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...opts?.deps,
  }

  const configError = emailSendConfigError(deps.config)
  if (configError) return configError

  const payload = JSON.stringify({
    from: deps.config.from,
    // Resend's documented `to` is a string array; one address per send keeps `deliveries`
    // per-address at the service layer.
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
  })
  if (byteLength(payload) > MAX_EMAIL_BODY_BYTES) {
    return fail("email_body_too_large", "The email body exceeds the size limit.", "validation")
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs)
  let response: Response
  try {
    response = await deps.fetchImpl(RESEND_EMAILS_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.config.apiKey}`,
        "content-type": "application/json",
      },
      body: payload,
      signal: controller.signal,
    })
  } catch {
    // Timeout (abort) or a transport failure. `internal` (500), not `auth`: nothing here says the
    // CALLER's session is broken, and the message never quotes the cause, so the key cannot ride it.
    clearTimeout(timer)
    return fail("email_unavailable", "The email provider could not be reached.", "internal")
  }

  // The timeout also covers the body: a provider that stalls mid-response must not hold the route.
  const json: unknown = await response.json().catch(() => null)
  clearTimeout(timer)

  if (!response.ok) {
    const name = resendErrorName(json)
    if (response.status === 429 || name === "rate_limit_exceeded") {
      return fail("email_rate_limited", "The email provider rate-limited this send. Try again shortly.", "rate_limit")
    }
    if (response.status === 400 || response.status === 403 || response.status === 422 || name === "validation_error") {
      // A rejected address (or an unverified sender domain) is the request's problem, not the
      // server's: `validation` (400) per the envelope's category set.
      return fail("email_address_rejected", "The email provider rejected the message.", "validation")
    }
    // 401 `missing_api_key` is OUR configuration seen late; answering it `auth` would 401 the
    // dashboard at a valid session, so it maps to `internal` like every other provider fault.
    return fail("email_send_failed", "The email provider refused the send.", "internal")
  }

  const id = (json as { id?: unknown } | null)?.id
  if (typeof id !== "string" || id === "") {
    return fail("email_send_failed", "The email provider returned an unreadable success payload.", "internal")
  }
  return ok({ id })
}
