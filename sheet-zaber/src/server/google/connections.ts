import "server-only"

import { OAuth2Client } from "google-auth-library"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { env } from "@/lib/env"
import { readUser, type AuthenticatedUser } from "@/server/auth/guards"
import {
  deleteConnection,
  findConnectionForUser,
  listConnections as listConnectionRows,
  upsertConnection,
  type GoogleConnectionRow,
} from "@/server/db/queries/google-connections"

import { decryptRefreshToken, encryptRefreshToken, evictAccessToken } from "./tokens"

/*
 * Connection service (backend-api-contract.md §4.6/§4.7, google-integration.md §2).
 * The projected `Connection` is the only shape that may reach a client: `userId`,
 * `refreshTokenEnc` and every token stay inside these functions.
 */

export type ConnectionStatus = "connected" | "reauth_required" | "disconnected"

export type Connection = {
  id: string
  googleEmail: string
  scope: string
  status: ConnectionStatus
  connectedAt: Date
  lastUsedAt: Date | null
}

function toConnection(row: GoogleConnectionRow): Connection {
  // The column is CHECK-constrained to these three values; unrecognised text degrades
  // to "connected" only via a DB outside this schema, and never carries a token anyway.
  const status: ConnectionStatus =
    row.status === "reauth_required" || row.status === "disconnected" ? row.status : "connected"
  return {
    id: row.id,
    googleEmail: row.googleEmail,
    scope: row.scope,
    status,
    connectedAt: row.connectedAt,
    lastUsedAt: row.lastUsedAt,
  }
}

/**
 * Encrypt-and-upsert. The repository upsert on `(user_id, google_email)` resets status to
 * `connected` on conflict — that is what revives a `reauth_required` row after re-consent.
 */
export async function connectGoogle(input: {
  userId: string
  googleEmail: string
  refreshToken: string
  scope: string
}): Promise<Connection> {
  const row = await upsertConnection({
    userId: input.userId,
    googleEmail: input.googleEmail,
    refreshTokenEnc: encryptRefreshToken(input.refreshToken),
    scope: input.scope,
  })
  // A new grant replaces the old refresh token; its cached access token must not survive it.
  evictAccessToken(row.id)
  return toConnection(row)
}

export async function listConnectionsForUser(userId: string): Promise<Connection[]> {
  const rows = await listConnectionRows(userId)
  return rows.map(toConnection)
}

/** The §4.7 action surface behind `GET /api/internal/connections`. */
export async function listConnections(session: AuthenticatedUser): Promise<ActionResult<Connection[]>> {
  return ok(await listConnectionsForUser(session.id))
}

/**
 * The guard spreadsheet/API services call before touching Google. Codes per §4.4:
 * an explicit id that matches nothing is `not_found` (same shape as "not yours"),
 * a dead grant is `google_reauth_required`, never-connected is `validation_failed`.
 */
export async function requireUsableConnection(
  userId: string,
  connectionId?: string
): Promise<ActionResult<Connection>> {
  const row = await findConnectionForUser(userId, connectionId)
  if (!row) {
    if (connectionId !== undefined) {
      return fail("not_found", "No connected Google account matches that id.", "not_found")
    }
    // Distinguish "never connected" from "every connection is dead" so the UI shows
    // "Connect Google" versus the reconnect banner.
    const rows = await listConnectionRows(userId)
    if (rows.length > 0) {
      return fail("google_reauth_required", "Reconnect your Google account to continue.", "google")
    }
    return fail("validation_failed", "Connect a Google account first.", "validation")
  }
  if (row.status !== "connected") {
    return fail("google_reauth_required", "Reconnect your Google account to continue.", "google")
  }
  return ok(toConnection(row))
}

/**
 * Disconnect, two documented forms (§4.7): the service form with an explicit owner, and
 * the dashboard-action form taking only the connection id and resolving the session user
 * itself. Owner scoping is enforced in both; the row IS the access grant, so Google's
 * revoke is best-effort and a revoke failure never blocks the delete (§2).
 */
export async function disconnectGoogle(
  userId: string,
  connectionId: string
): Promise<ActionResult<{ id: string }>>
export async function disconnectGoogle(connectionId: string): Promise<ActionResult<never>>
export async function disconnectGoogle(
  first: string,
  second?: string
): Promise<ActionResult<{ id: string }>> {
  if (second === undefined) {
    // One-argument form: no session means nothing of theirs can be deleted, and a
    // foreign/unknown id answers identically — no existence oracle (security.md §3.4).
    const session = await readUser()
    if (!session) {
      return fail("not_found", "No connected Google account matches that id.", "not_found")
    }
    return disconnectForOwner(session.id, first)
  }
  return disconnectForOwner(first, second)
}

async function disconnectForOwner(
  userId: string,
  connectionId: string
): Promise<ActionResult<{ id: string }>> {
  const row = await findConnectionForUser(userId, connectionId)
  if (!row) {
    return fail("not_found", "No connected Google account matches that id.", "not_found")
  }

  await revokeBestEffort(row)
  await deleteConnection(connectionId, userId)
  evictAccessToken(connectionId)
  return ok({ id: connectionId })
}

/** Best-effort Google revoke seam — injectable so tests never open a socket (§2). */
export type RevokeTransport = (refreshToken: string) => Promise<void>

const googleRevokeTransport: RevokeTransport = async (refreshToken) => {
  const client = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)
  await client.revokeToken(refreshToken)
}

let revokeTransport: RevokeTransport = googleRevokeTransport

/** Test seam only; `null` restores the real Google revoke. */
export function setRevokeTransport(transport: RevokeTransport | null): void {
  revokeTransport = transport ?? googleRevokeTransport
}

async function revokeBestEffort(row: GoogleConnectionRow): Promise<void> {
  // Without client credentials there is nothing to revoke with (dev before configuration);
  // deleting the row below still enforces the disconnect.
  if (!env.googleOAuthConfigured) return
  let refreshToken: string
  try {
    refreshToken = decryptRefreshToken(row.refreshTokenEnc)
  } catch {
    return
  }
  try {
    await revokeTransport(refreshToken)
  } catch {
    // A Google-side revoke failure never blocks the deletion (§2).
  }
}
