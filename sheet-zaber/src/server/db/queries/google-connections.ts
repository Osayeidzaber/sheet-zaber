import "server-only"

import { and, asc, desc, eq } from "drizzle-orm"

import { db } from "../client"
import { googleConnections } from "../schema"
import type { DbLike, DbTx } from "./types"

/*
 * `google_connections` repository (`google-integration.md` §2).
 *
 * `refreshTokenEnc` is opaque AES-256-GCM text owned by `src/server/google/*`: this module
 * stores and returns it, it never decodes or re-encrypts it. A row may be handed to a service,
 * but only the projected `Connection` shape reaches the browser (`backend-api-contract.md` §4.6).
 */

export type GoogleConnectionRow = typeof googleConnections.$inferSelect
export type GoogleConnectionStatus = "connected" | "reauth_required" | "disconnected"

/**
 * Every function takes an optional client so a service can run it inside its transaction.
 * Typing the return as `DbLike` is the check that a `DbTx` needs no cast (see `types.ts`).
 */
function client(q?: DbLike | DbTx): DbLike {
  return q ?? db
}

/**
 * `(user_id, google_email)` is the unique key, so re-consent updates in place: the id survives
 * (usage and rows pointing at this connection keep working) and `status` resets to `connected`,
 * which is what revives a `reauth_required` row. `connectedAt` keeps the first connect.
 */
export async function upsertConnection(
  input: { userId: string; googleEmail: string; refreshTokenEnc: string; scope: string },
  q?: DbLike | DbTx
): Promise<GoogleConnectionRow> {
  const [row] = await client(q)
    .insert(googleConnections)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      googleEmail: input.googleEmail,
      refreshTokenEnc: input.refreshTokenEnc,
      scope: input.scope,
      status: "connected",
    })
    .onConflictDoUpdate({
      target: [googleConnections.userId, googleConnections.googleEmail],
      set: {
        refreshTokenEnc: input.refreshTokenEnc,
        scope: input.scope,
        status: "connected",
        updatedAt: new Date(),
      },
    })
    .returning()
  return row
}

/** Every account the user has connected — several Google accounts per user is the design. */
export async function listConnections(
  userId: string,
  q?: DbLike | DbTx
): Promise<GoogleConnectionRow[]> {
  return client(q)
    .select()
    .from(googleConnections)
    .where(eq(googleConnections.userId, userId))
    .orderBy(desc(googleConnections.connectedAt), asc(googleConnections.id))
}

/**
 * Two modes, on purpose.
 * - With `connectionId`: ownership-scoped lookup by id that ignores `status` — a `disconnected`
 *   row still has to be addressable so it can be shown and deleted.
 * - Without it: the connection the engine may actually use, i.e. `connected` only, newest first.
 *   Returning `undefined` once every row is dead is the point: the alternative is trying to
 *   refresh a revoked token.
 */
export async function findConnectionForUser(
  userId: string,
  connectionId?: string,
  q?: DbLike | DbTx
): Promise<GoogleConnectionRow | undefined> {
  const conditions =
    connectionId === undefined
      ? and(eq(googleConnections.userId, userId), eq(googleConnections.status, "connected"))
      : and(eq(googleConnections.userId, userId), eq(googleConnections.id, connectionId))

  const [row] = await client(q)
    .select()
    .from(googleConnections)
    .where(conditions)
    .orderBy(desc(googleConnections.connectedAt), asc(googleConnections.id))
    .limit(1)
  return row
}

/** `reauth_required` is set when a refresh fails; `disconnected` when the grant died. */
export async function markConnectionStatus(
  id: string,
  status: GoogleConnectionStatus,
  q?: DbLike | DbTx
): Promise<void> {
  await client(q)
    .update(googleConnections)
    .set({ status, updatedAt: new Date() })
    .where(eq(googleConnections.id, id))
}

/** Usage, not a change to the connection, so only `last_used_at` moves. */
export async function touchConnectionUsed(id: string, q?: DbLike | DbTx): Promise<void> {
  await client(q)
    .update(googleConnections)
    .set({ lastUsedAt: new Date() })
    .where(eq(googleConnections.id, id))
}

/**
 * Owner-scoped: a wrong `userId` deletes nothing. The row itself is the access grant, so its
 * removal is what enforces the disconnect — and `registered_spreadsheets.connection_id` is
 * `onDelete: "cascade"`, so the sheets registered through it go with it.
 */
export async function deleteConnection(
  id: string,
  userId: string,
  q?: DbLike | DbTx
): Promise<void> {
  await client(q)
    .delete(googleConnections)
    .where(and(eq(googleConnections.id, id), eq(googleConnections.userId, userId)))
}
