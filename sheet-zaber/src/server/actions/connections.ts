"use server"

/*
 * Google connections: the reconnect banner's source and the disconnect verb
 * (`backend-api-contract.md` §2 "Spreadsheets (user)", §4.6, §4.7; `docs/google-integration.md` §2).
 *
 * The §4.6 `Connection` is the only shape that may reach a browser: `userId` and
 * `refresh_token_enc` stay in the repository row, and no verb here returns token material —
 * `disconnectGoogleAction` answers with the row id and nothing else.
 *
 * `reconnectGoogle()` is NOT an action: §4.7 says so explicitly, it is the plain link
 * `/auth/google/connect`, and an action could not return an OAuth consent URL without pretending
 * to own the round trip. `/auth/logout` is likewise the form POST, not an action (B3).
 *
 * ARGUMENT ORDER WARNING (doc-vs-code, reported not patched): the shipped
 * `disconnectGoogle` overloads are `(userId, connectionId)` for the two-argument form and
 * `(connectionId)` for the self-guarding one (`src/server/google/connections.ts:115`), while
 * §4.7 publishes `disconnectGoogle(connectionId, userId)`. Two plain strings, so the type system
 * cannot catch a swap — this file follows the SHIPPED signature. The one-argument form is not
 * used here because it answers `not_found` where this layer owes `unauthenticated`.
 */

import type { ActionResult } from "@/lib/action-result"
import {
  disconnectGoogle,
  listConnections,
  type Connection,
} from "@/server/google/connections"

import { userAction } from "./support"

/** `GET /api/internal/connections` as an action: every connection the caller owns, `status` included. */
export async function listConnectionsAction(): Promise<ActionResult<Connection[]>> {
  return userAction((session) => listConnections(session))
}

/**
 * §4.7 disconnect: the row deletion is what enforces access, and Google's `revokeToken()` is
 * best-effort inside the service — a revoke failure never fails the action, and a foreign, unknown
 * or malformed id is `not_found`, because `findConnectionForUser` only ever matches the caller's own
 * row (`google/connections.ts:140`).
 */
export async function disconnectGoogleAction(connectionId: string): Promise<ActionResult<{ id: string }>> {
  return userAction((session) => disconnectGoogle(session.id, connectionId))
}
