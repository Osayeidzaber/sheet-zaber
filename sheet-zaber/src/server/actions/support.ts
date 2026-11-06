import "server-only"

import { fail, internalError, type ActionError, type ActionResult } from "@/lib/action-result"
import { readUser, type AuthenticatedUser } from "@/server/auth/guards"
import { findConnectionForUser } from "@/server/db/queries/google-connections"
import { createSheetsClient } from "@/server/google/sheets"
import { evictAccessToken, getAccessToken as mintAccessToken } from "@/server/google/tokens"
import type { GetAccessToken, SheetsDeps } from "@/server/spreadsheets/service"

/*
 * The action layer's only shared code, and it is the action-side twin of
 * `src/server/http/internal-route.ts:40`: read the session with the existing guard (`readUser`),
 * answer `unauthenticated` for a missing/dead cookie and `forbidden` for a valid session whose
 * role is not enough (§4.4 — 401 vs 403 is the difference between "sign in" and "you may not"),
 * turn a throw into `internal_error` without echoing the cause, and otherwise return the
 * service's `ActionResult` verbatim.
 *
 * This file is deliberately NOT a `"use server"` module: a directive here would publish every
 * helper as a callable endpoint. It is imported by the action files, which do carry the directive.
 * No SQL, no ownership rule and no domain validation lives here — a verb's rules stay in its
 * service (`docs/backend-api-contract.md` §2, §4.7; `docs/integration-status.md` B10).
 */

/** §4.4 `unauthenticated`, byte-identical to the wrapper's 401 body (`internal-route.ts:45`). */
export function unauthenticatedError(): ActionError {
  return fail("unauthenticated", "Sign in to continue.", "auth")
}

/** §4.4 `forbidden`: a real session, insufficient role. The route answers 403; an action carries no status. */
export function forbiddenError(): ActionError {
  return fail("forbidden", "This area is for platform owners.", "auth")
}

/**
 * There is deliberately no id validation, no shape validation and no zod→`fields` mapping helper
 * in this layer. Every dashboard id names a `text` column (`src/server/db/schema.ts` uses no `uuid`
 * postgres type, the values come from `crypto.randomUUID()`), so a malformed id cannot raise a
 * driver error — it simply names no row, and each service already answers it in its own documented
 * voice: `apis/service.ts`, `keys/service.ts`, `spreadsheets/service.ts` and `admin/users.ts:216`
 * return `not_found`, `invitations/service.ts:388` returns `validation_failed` from its own
 * `z.uuid()`. Adding a second opinion here would both diverge from the route for the same input and
 * break the rule at the top of this file, so each action just delegates.
 *
 * The one exception is `toggleApiAction`'s `enabled` flag (`apis.ts`), which no shared schema covers
 * and which therefore cannot be trusted as a truthy client-shaped value.
 */

export type ActionHandler<T> = (
  session: AuthenticatedUser
) => ActionResult<T> | Promise<ActionResult<T>>

/**
 * The guard + envelope wrapper. `ownerOnly` is decided the same way `ownerRoute` decides it —
 * from the `users` row `readUser` re-reads, never from the cookie's role claim — so a demoted or
 * disabled account is refused on its next action even with an unexpired cookie.
 */
async function guarded<T>(handler: ActionHandler<T>, ownerOnly: boolean): Promise<ActionResult<T>> {
  const session = await readUser()
  if (session === null) return unauthenticatedError()
  if (ownerOnly && session.role !== "owner") return forbiddenError()

  try {
    return await handler(session)
  } catch (error) {
    // Never echo the cause: the detail stays in the server log (`security.md` §4).
    console.error("[actions]", error instanceof Error ? error.message : error)
    return internalError()
  }
}

/** Any active session (`userRoute` equivalent). */
export function userAction<T>(handler: ActionHandler<T>): Promise<ActionResult<T>> {
  return guarded(handler, false)
}

/** Owner only (`ownerRoute` equivalent): `unauthenticated` then `forbidden`, in that order. */
export function ownerAction<T>(handler: ActionHandler<T>): Promise<ActionResult<T>> {
  return guarded(handler, true)
}

/**
 * The production `SheetsDeps` (`src/server/spreadsheets/service.ts:73`) for one session user.
 *
 * CROSS-OWNED GAP, REPORTED NOT PATCHED (`docs/integration-status.md` B10): the service declares
 * the `SheetsDeps` TYPE but nothing under `src/server/**` builds it, and minting an access token
 * needs the owner-scoped `google_connections` ROW — `tokens.getAccessToken` reads
 * `refresh_token_enc` off it (`src/server/google/tokens.ts:88`) — which only the repository
 * exposes. Every action layer is therefore forced to repeat these lines, which is exactly why the
 * frontend's `(app)/spreadsheets/actions.ts` looks the way it does. The right home is a
 * `productionSheetsDeps(userId: string): SheetsDeps` export next to the type; until then this is
 * the ONLY place in `src/server/actions/**` that touches a repository read, it is the same
 * owner-scoped read `GET /api/internal/connections` uses, and it adds no rule of its own:
 * `findConnectionForUser(userId, …)` can only return the caller's own row, so a foreign
 * connectionId is not even mintable.
 */
export function buildSheetsDeps(userId: string): SheetsDeps {
  const getAccessToken: GetAccessToken = async (connectionId, forceRefresh) => {
    if (forceRefresh) evictAccessToken(connectionId)
    // `status` is not filtered here on purpose: a `reauth_required` row still has to be attempted
    // so the service can map Google's answer to the typed code instead of a bare 500.
    const row = await findConnectionForUser(userId, connectionId)
    if (row === undefined) throw new Error("connection_not_found")
    return mintAccessToken(row)
  }
  return { getAccessToken, client: (accessToken, spreadsheetId) => createSheetsClient(accessToken, spreadsheetId) }
}
