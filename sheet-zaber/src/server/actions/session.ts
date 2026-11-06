"use server"

/*
 * The session read the dashboard shell consumes (`backend-api-contract.md` §2 "Auth & session",
 * §4.2/§4.4). It is the one place the browser may ask "who am I" and it answers with the guard's
 * own value — the `users` row re-read by `readUser`, so a disabled account or a demoted role is
 * reflected on the next action without waiting for the cookie to expire.
 *
 * `AuthenticatedUser` is `{ id, email, role }` and nothing else (§4.2): no `status`, no `googleSub`,
 * no token material. There is no logout action here — clearing the session cookie is the form POST
 * to `/auth/logout` (§2, `integration-status.md` B3), never a GET and never an action.
 */

import { ok, type ActionResult } from "@/lib/action-result"
import type { AuthenticatedUser } from "@/server/auth/guards"

import { userAction } from "./support"

export async function getSessionUser(): Promise<ActionResult<AuthenticatedUser>> {
  return userAction((session) => ok(session))
}

/**
 * Role only, for a nav/CTA that must not pull the caller's email across the boundary.
 * Derived from the same `readUser` row as `getSessionUser`, never from the cookie claim.
 */
export async function getSessionRole(): Promise<ActionResult<{ role: AuthenticatedUser["role"] }>> {
  return userAction((session) => ok({ role: session.role }))
}
