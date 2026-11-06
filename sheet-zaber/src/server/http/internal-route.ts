import "server-only"

import { statusFor, type ActionResult } from "@/lib/action-result"
import { env } from "@/lib/env"
import { readUser, type AuthenticatedUser } from "@/server/auth/guards"
import { json } from "@/server/http/request"

/*
 * One guard and one serializer for every `/api/internal/**` JSON route
 * (backend-api-contract.md §2, §4.4). A handler that forgets to re-check the session is the
 * classic way to leak another user's row, so the guard lives here: handlers receive a
 * `user.id` produced by `readUser`, which re-reads the `users` row and returns the DB role.
 *
 * The context carries `path` instead of Next's `params` on purpose — a handler written against
 * `params` inherits Next's per-route generic, and one written against the URL works on every
 * route file, catch-all included.
 */

export type InternalContext = {
  user: AuthenticatedUser
  req: Request
  url: URL
  /** Pathname segments after `/api/internal`, e.g. `["apis","abc","stats"]`. */
  path: string[]
}

export type InternalHandler<T> = (
  ctx: InternalContext
) => ActionResult<T> | Promise<ActionResult<T>>

/** Any active session; a disabled or cleared cookie is a 401, never a redirect. */
export function userRoute<T>(handler: InternalHandler<T>) {
  return internalRoute(handler, false)
}

/** Owner only. A valid non-owner gets 403 (permission), a missing session gets 401 (authentication). */
export function ownerRoute<T>(handler: InternalHandler<T>) {
  return internalRoute(handler, true)
}

function internalRoute<T>(handler: InternalHandler<T>, ownerOnly: boolean) {
  return async (req: Request): Promise<Response> => {
    if (isCrossSiteWrite(req)) {
      return json(
        { error: { code: "forbidden", message: "Cross-site requests are not allowed.", category: "auth" } },
        403
      )
    }

    const user = await readUser(req)
    if (user === null) {
      return json(
        { error: { code: "unauthenticated", message: "Sign in to continue.", category: "auth" } },
        401
      )
    }
    if (ownerOnly && user.role !== "owner") {
      return json(
        { error: { code: "forbidden", message: "This area is for platform owners.", category: "auth" } },
        403
      )
    }

    const url = new URL(req.url)
    try {
      const result = await handler({ user, req, url, path: internalPath(url.pathname) })
      if ("error" in result) {
        // `auth` is 401 by §4.4's default map; `forbidden` above is the one carve-out.
        return json(result, result.error.code === "forbidden" ? 403 : statusFor(result))
      }
      return json({ data: result.data }, 200)
    } catch (err) {
      // Never echo the cause: the detail stays in the server log (`security.md` §4).
      console.error("[internal-route]", err instanceof Error ? err.message : err)
      return json(
        { error: { code: "internal_error", message: "The request could not be completed.", category: "internal" } },
        500
      )
    }
  }
}

/**
 * Explicit CSRF check for cookie-authenticated writes. Browsers attach `Origin` to every such
 * request, so an absent header means a non-browser client, which no cookie can be tricked out of.
 */
function isCrossSiteWrite(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false
  const origin = req.headers.get("origin")
  if (origin === null) return req.headers.get("sec-fetch-site") === "cross-site"

  const allowed = [new URL(req.url).origin]
  if (env.NEXT_PUBLIC_SITE_URL) allowed.push(new URL(env.NEXT_PUBLIC_SITE_URL).origin)
  return !allowed.includes(origin)
}

function internalPath(pathname: string): string[] {
  const marker = "/api/internal/"
  const start = pathname.indexOf(marker)
  const rest = start === -1 ? pathname : pathname.slice(marker.length - 1)
  return rest.split("/").filter((segment) => segment.length > 0 && segment !== "internal")
}
