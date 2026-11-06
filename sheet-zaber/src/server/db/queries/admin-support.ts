import "server-only"

import { eq, sql } from "drizzle-orm"

import { db } from "../client"
import { invitations } from "../schema"
import { type DbLike, type DbTx } from "./types"

/*
 * The one read the admin delete verb needs and no existing query file answers:
 * `invitations.created_by` references `users.id` with NO cascade (`database-schema.md`), so
 * deleting an account that ever minted a code is a `23503` integrity error, not a delete.
 * Counting it up front lets the service refuse in words instead of 500.
 */

/** Same optional-client shape as every other query module, so it runs inside a `DbTx`. */
function client(q?: DbLike | DbTx): DbLike {
  return q === undefined ? db : q
}

export async function countInvitationsCreatedBy(
  userId: string,
  q?: DbLike | DbTx
): Promise<number> {
  const [row] = await client(q)
    .select({ total: sql<number>`count(*)::int` })
    .from(invitations)
    .where(eq(invitations.createdBy, userId))
  return row?.total ?? 0
}
