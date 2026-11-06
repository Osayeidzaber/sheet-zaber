import "server-only"

import { eq } from "drizzle-orm"

import { fail, internalError, ok, type ActionResult } from "@/lib/action-result"
import { recordAudit } from "@/server/admin/audit"
import { can } from "@/server/auth/rbac"
import type { AuthenticatedUser } from "@/server/auth/guards"
import { db } from "@/server/db/client"
import { users } from "@/server/db/schema"

/** The owner's switch for whether one account may create invitation codes. Audited. */
export async function setUserCanInvite(
  id: string,
  canInvite: boolean,
  actor: AuthenticatedUser
): Promise<ActionResult<{ id: string; canInvite: boolean }>> {
  if (!can(actor.role, "user.invite_permission")) return fail("forbidden", "You are not allowed to do that.", "auth")
  if (typeof canInvite !== "boolean") {
    return fail("validation_failed", "The permission is not valid.", "validation", { canInvite: "must be true or false" })
  }
  try {
    const changed = await db.transaction(async (tx) => {
      const [row] = await tx.update(users).set({ canInvite, updatedAt: new Date() }).where(eq(users.id, id)).returning({ id: users.id })
      if (!row) return false
      await recordAudit(
        { actorId: actor.id, action: "user.invite_permission", subjectType: "user", subjectId: id, detail: { canInvite } },
        tx
      )
      return true
    })
    return changed ? ok({ id, canInvite }) : fail("not_found", "No user was found with that id.", "not_found")
  } catch {
    return internalError()
  }
}
