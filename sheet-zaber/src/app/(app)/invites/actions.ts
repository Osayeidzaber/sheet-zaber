"use server"

import { revalidatePath } from "next/cache"

import { isActionError } from "@/lib/action-result"
import { setUserCanInvite } from "@/server/admin/invite-permission"
import { ownerAction, userAction } from "@/server/actions/support"
import { createInvitations } from "@/server/invitations/service"

const CODE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export type NewCodeResult = { code: string } | { error: string }

/*
 * Terms are fixed here so a permitted member cannot mint a reusable or permanent code. The service
 * re-reads the account and decides whether it may invite.
 */
export async function createMemberCodeAction(): Promise<NewCodeResult> {
  const result = await userAction((actor) =>
    createInvitations({ count: 1, maxUses: 1, expiresAt: new Date(Date.now() + CODE_LIFETIME_MS) }, actor.id)
  )
  if (isActionError(result)) return { error: result.error.message }
  revalidatePath("/invites")
  return { code: result.data.codes[0] }
}

/** Returns an error message, or null on success. */
export async function setUserCanInviteAction(id: string, canInvite: boolean): Promise<string | null> {
  const result = await ownerAction((actor) => setUserCanInvite(id, canInvite, actor))
  if (isActionError(result)) return result.error.message
  revalidatePath(`/admin/users/${id}`)
  return null
}
