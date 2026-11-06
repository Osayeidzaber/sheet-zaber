import { NextResponse, type NextRequest } from "next/server"

import { SESSION_COOKIE, verifySession } from "@/server/auth/session"

/*
 * `src/proxy.ts` — the Next 16 replacement for `middleware.ts` (PROXY_FILENAME in
 * `next/dist/lib/constants.js`; the compiled entry accepts a `proxy` or default export).
 *
 * THIS IS A UX GATE, NOT A SECURITY BOUNDARY (`architecture.md` §4, Q-B7 in
 * `integration-status.md`). Every guarded surface re-establishes the caller itself: the `(app)`
 * layout calls `requireUser()`, `(app)/admin/layout.tsx` calls `requireOwner()`, and each
 * `/api/internal/*` route is wrapped by `userRoute`/`ownerRoute`. A Server Action POST does not
 * pass through this file at all, so nothing here may be relied upon to authorize anything.
 *
 * Two deliberate narrowings:
 *
 * 1. No role branch. `authentication-flow.md` §2 rule 2 makes the database role win over the
 *    cookie role, which is how a demotion or a disable takes effect on the next request. A role
 *    check here would invert that for one case: an owner promoted after sign-in would be bounced
 *    out of `/admin` until their cookie was re-signed, because the payload still says `user`.
 *    `requireOwner()` reads the row, so the promotion works — the gate stays a session check.
 *
 * 2. An allowlist of gated prefixes rather than "everything that isn't public". Default-deny would
 *    redirect any unknown path — including a marketing 404 — to `/login`, which is a worse answer
 *    than the not-found screen. A new `(app)` route is therefore ungated *by the proxy* until it is
 *    listed below; it is still gated by the layout, which is the check that actually matters.
 */

/**
 * Redirecting `/api/**` or `/auth/**` would break the product rather than improve it: `/api/v1` is
 * key-authed and called by HTTP clients and scripts, `/api/internal/*` answers JSON to `fetch` and
 * returns its own 401, and `/auth/*` is the OAuth and invitation handshake — an intermediate
 * redirect there either loses a POST body or re-signs a flow mid-exchange. Neither is listed in the
 * matcher below, so neither reaches this file.
 */

/**
 * The `(app)` route group. Bare path plus `:path*` are both listed because
 * `/dashboard/:path*` is not guaranteed to match `/dashboard` itself.
 */
const GATED_PREFIXES = [
  "/overview",
  "/spreadsheets",
  "/apis",
  "/keys",
  "/playground",
  "/logs",
  "/analytics",
  "/settings",
  "/admin",
] as const

/**
 * A signed-in visitor on `/login` is sent to `/overview`, and a `?next=` on the sign-in URL is
 * ignored on purpose: `src/app/login/page.tsx` reads `error` only and has no `next` handling, so
 * emitting one here would be an affordance nothing honours. Same-origin paths are the only values
 * this file ever generates, and it never reflects a request-supplied destination.
 */
const SIGN_IN_PATH = "/login"

function isGated(pathname: string): boolean {
  return GATED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * 303 rather than the 307 default. A 307 replays the original method and body onto the
 * destination, so a Server Action POST that arrives without a session would be re-issued against
 * `/login` — which has no such handler. 303 tells the client to follow with GET.
 */
function toLocation(url: URL): NextResponse {
  return NextResponse.redirect(url, 303)
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname, origin } = req.nextUrl
  const signedIn = verifySession(req.cookies.get(SESSION_COOKIE)?.value) !== null

  // /login is never redirected from here. A signature cannot tell a live account from a disabled one,
  // and the guard sends disabled accounts to /login, so bouncing them back would loop forever. The
  // login page reads the users row and forwards live sessions itself.
  if (pathname === SIGN_IN_PATH) return NextResponse.next()

  if (isGated(pathname) && !signedIn) {
    return toLocation(new URL(SIGN_IN_PATH, origin))
  }

  return NextResponse.next()
}

export const config = {
  // Next parses this statically, so it must be a literal: keep it in step with GATED_PREFIXES.
  matcher: [
    "/overview",
    "/overview/:path*",
    "/spreadsheets",
    "/spreadsheets/:path*",
    "/apis",
    "/apis/:path*",
    "/keys",
    "/keys/:path*",
    "/playground",
    "/playground/:path*",
    "/logs",
    "/logs/:path*",
    "/analytics",
    "/analytics/:path*",
    "/settings",
    "/settings/:path*",
    "/admin",
    "/admin/:path*",
    "/login",
    "/login/:path*",
  ],
}
