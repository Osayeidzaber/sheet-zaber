import { fail, isActionError, statusFor, type ActionError } from "@/lib/action-result"
import { PENDING_COOKIE, buildClearPendingHeaders, verifyPending } from "@/server/auth/pending"
import {
  SESSION_MAX_AGE_SECONDS,
  buildSessionSetHeaders,
  signSession,
} from "@/server/auth/session"
import { clientBucketIp, readCookie } from "@/server/http/request"
import { redeemInvitation } from "@/server/invitations/service"

/*
 * `POST /auth/invitation` — the only route consumer of `sz_pending` (`authentication-flow.md` §1).
 * Accepts a HTML form POST (the /login invitation step) and a JSON body alike.
 *
 * This adapter parses the request and writes cookies. The attempt throttle and the redemption
 * transaction both live in the service, because a server action over the same service is exactly
 * as reachable as this route (`backend-api-contract.md` §2 brute-force row).
 */

export const dynamic = "force-dynamic"

/** `authentication-flow.md` §1/§2: a finished registration lands on the overview. */
const DEFAULT_RETURN_TO = "/overview"

const CODE_FIELDS = ["code", "invitation_code", "invitationCode", "plaintextCode"] as const

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

/** The body is read once, from either shape, and only ever as text. */
async function readSubmittedBody(req: Request): Promise<{ code: string | null; returnTo: string | null; username: string | null }> {
  let field: (name: string) => unknown = () => null
  try {
    // Only real form encodings go to formData(): a JSON string body sent by fetch without a header
    // arrives as text/plain, and formData() would throw on it.
    const contentType = req.headers.get("content-type") ?? ""
    if (!contentType.includes("multipart/form-data") && !contentType.includes("application/x-www-form-urlencoded")) {
      const body: unknown = await req.json()
      const record =
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {}
      field = (name: string) => record[name]
    } else {
      const form = await req.formData()
      field = (name: string) => form.get(name)
    }
  } catch {
    return { code: null, returnTo: null, username: null }
  }

  let code: string | null = null
  for (const name of CODE_FIELDS) code ??= nonEmpty(field(name))
  return { code, returnTo: nonEmpty(field("returnTo")), username: nonEmpty(field("username")) }
}

/** Relative-path-only: a caller-supplied absolute URL would turn this redirect into an open one. */
function safeReturnTo(value: string | null): string {
  if (
    value !== null &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    value.length <= 200 &&
    !value.includes("\\")
  ) {
    return value
  }
  return DEFAULT_RETURN_TO
}

function prefersJson(req: Request): boolean {
  const accept = req.headers.get("accept") ?? ""
  if (accept.includes("application/json")) return true
  return (req.headers.get("content-type") ?? "").includes("application/json")
}

function errorResponse(error: ActionError, options: { clearPending: boolean }): Response {
  const headers = new Headers()
  // The service owns the window maths and hands the seconds back through `fields.retry_after`.
  const retryAfter = error.error.fields?.retry_after
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter)
  // Cleared only when the cookie itself is the problem: an invalid code must leave `sz_pending`
  // alive so the person can retry without re-running Google consent.
  if (options.clearPending) {
    for (const cookie of buildClearPendingHeaders()) headers.append("set-cookie", cookie)
  }
  return Response.json(error, { status: statusFor(error), headers })
}

export async function POST(req: Request): Promise<Response> {
  const pending = verifyPending(readCookie(req, PENDING_COOKIE))

  const submitted = await readSubmittedBody(req)
  if (submitted.code === null) {
    return errorResponse(
      fail("validation_failed", "An invitation code is required.", "validation", {
        code: "invitation code is not valid",
      }),
      { clearPending: false }
    )
  }

  const result = await redeemInvitation({ plaintextCode: submitted.code, pending, ip: clientBucketIp(req), username: submitted.username })
  if (isActionError(result)) {
    return errorResponse(result, { clearPending: result.error.code === "pending_expired" })
  }

  // The session role is the DB row the service just wrote, never anything the browser sent.
  const token = signSession({
    uid: result.data.userId,
    role: result.data.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  })
  const headers = new Headers()
  for (const cookie of buildSessionSetHeaders(token)) headers.append("set-cookie", cookie)
  for (const cookie of buildClearPendingHeaders()) headers.append("set-cookie", cookie)
  const fromQuery = new URL(req.url).searchParams.get("returnTo")
  const target = safeReturnTo(submitted.returnTo ?? fromQuery)

  if (prefersJson(req)) {
    return Response.json({ ok: true, redirect: target }, { status: 200, headers })
  }
  headers.set("location", target)
  return new Response(null, { status: 303, headers })
}
