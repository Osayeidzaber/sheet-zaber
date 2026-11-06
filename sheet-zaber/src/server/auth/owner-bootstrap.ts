import "server-only"

import { eq } from "drizzle-orm"

import { env } from "@/lib/env"
import { recordAudit } from "@/server/admin/audit"
import { db } from "@/server/db/client"
import { createUser, type UserRow } from "@/server/db/queries/users"
import { users } from "@/server/db/schema"

/*
 * The way into a brand-new instance. Only an owner can create invitation codes, and a code needs an
 * existing creator, so the first owner cannot redeem one. Pass only an email Google has verified.
 * Once any owner row exists, in any status, this returns null and invitations are the only way in.
 */
export async function bootstrapOwner(identity: { sub: string; email: string }): Promise<UserRow | null> {
  if (identity.email.trim().toLowerCase() !== env.OWNER_EMAIL.trim().toLowerCase()) return null

  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.role, "owner")).limit(1)
    if (owner) return null

    const created = await createUser({ googleSub: identity.sub, email: identity.email, role: "owner" }, tx)
    await recordAudit(
      { actorId: created.id, action: "owner.bootstrap", subjectType: "user", subjectId: created.id, detail: { source: "first-sign-in" } },
      tx
    )
    return created
  })
}
