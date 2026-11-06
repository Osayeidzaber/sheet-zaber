import "server-only"

import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm"

import { db } from "../client"
import { invitationRedemptions, invitations, users } from "../schema"
import { type DbLike, type DbTx } from "./types"

export type InvitationRow = typeof invitations.$inferSelect

/** Owner-facing list item: `codeHash` is deliberately absent — the hash never travels toward a client. */
export type InvitationListItem = {
  id: string
  label: string | null
  maxUses: number
  uses: number
  expiresAt: Date | null
  revokedAt: Date | null
  createdBy: string
  createdAt: Date
}

/**
 * Every function takes an optional client so a service can run it inside its transaction.
 * `q` returns directly rather than through `asDbLike(q)` (the `users.ts` shape): that helper
 * narrows `Db | DbTx`, so a plain `DbLike` arm stops compiling against it; the declared
 * `DbLike` return type keeps the same assignability proof for `DbTx`.
 */
function client(q?: DbLike | DbTx): DbLike {
  return q === undefined ? db : q
}

/** One batched INSERT; a duplicate `code_hash` surfaces the raw pg error for the service to classify. */
export async function insertInvitations(
  rows: { codeHash: string; label: string | null; maxUses: number; expiresAt: Date | null; createdBy: string }[],
  q?: DbLike | DbTx
): Promise<InvitationRow[]> {
  return client(q)
    .insert(invitations)
    .values(rows.map((row) => ({ id: crypto.randomUUID(), ...row })))
    .returning()
}

/**
 * Single conditional UPDATE — never select-then-update. Only this shape is correct:
 * row-locking makes concurrent calls elect one winner, a `tx` rollback restores `uses`,
 * and the guard (unrevoked, unexpired, `uses < max_uses`) matches `backend-api-contract.md` §4.5.
 */
export async function redeemInvitation(codeHash: string, q?: DbLike | DbTx): Promise<string | null> {
  const [row] = await client(q)
    .update(invitations)
    .set({ uses: sql`${invitations.uses} + 1` })
    .where(
      and(
        eq(invitations.codeHash, codeHash),
        isNull(invitations.revokedAt),
        or(isNull(invitations.expiresAt), gt(invitations.expiresAt, new Date())),
        sql`uses < max_uses`
      )
    )
    .returning({ id: invitations.id })
  return row?.id ?? null
}

/** Counter-free bookkeeping row; the (invitation_id, redeemed_by) unique violation surfaces raw. */
export async function recordRedemption(
  input: { invitationId: string; redeemedBy: string },
  q?: DbLike | DbTx
): Promise<void> {
  await client(q).insert(invitationRedemptions).values({
    id: crypto.randomUUID(),
    invitationId: input.invitationId,
    redeemedBy: input.redeemedBy,
  })
}

/** Idempotent: the `revoked_at IS NULL` guard keeps the first revoke's timestamp. */
export async function revokeInvitation(id: string, q?: DbLike | DbTx): Promise<void> {
  await client(q)
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, id), isNull(invitations.revokedAt)))
}

/**
 * One batched read of EVERY redemption, joined to the redeemer's email, so the admin invitations
 * route gets who/when without an N+1 loop (`backend-api-contract.md` §4.5). Grouped by the caller.
 *
 * `redeemedBy` is the account id — kept because the admin payload names it — and `email` is the
 * human-facing half. An account deleted after redeeming drops out of this INNER JOIN: the
 * invitation's `uses` counter still tells the owner that a redemption happened, which is the honest
 * answer, and no ghost email is invented for a row that no longer exists.
 */
export type InvitationRedemption = {
  invitationId: string
  redeemedBy: string
  email: string
  redeemedAt: Date
}

export async function listRedemptions(q?: DbLike | DbTx): Promise<InvitationRedemption[]> {
  return client(q)
    .select({
      invitationId: invitationRedemptions.invitationId,
      redeemedBy: invitationRedemptions.redeemedBy,
      email: users.email,
      redeemedAt: invitationRedemptions.redeemedAt,
    })
    .from(invitationRedemptions)
    .innerJoin(users, eq(users.id, invitationRedemptions.redeemedBy))
    .orderBy(desc(invitationRedemptions.redeemedAt))
}

/** Owner-facing listing; the explicit column list is what guarantees no `codeHash` leaks. */
export async function listInvitations(q?: DbLike | DbTx): Promise<InvitationListItem[]> {
  return client(q)
    .select({
      id: invitations.id,
      label: invitations.label,
      maxUses: invitations.maxUses,
      uses: invitations.uses,
      expiresAt: invitations.expiresAt,
      revokedAt: invitations.revokedAt,
      createdBy: invitations.createdBy,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .orderBy(desc(invitations.createdAt))
}
