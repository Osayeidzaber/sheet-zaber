"use server"

// Form and presentation adapters only. The authenticated backend actions own
// authorization, validation, mutations and audit records.
import { revalidatePath } from "next/cache"

import { isActionError, ok, type ActionError, type ActionResult } from "@/lib/action-result"
import {
  deleteUserAction,
  demoteUserAction,
  promoteUserAction,
  setUserApiLimitAction,
  setUserStatusAction,
} from "@/server/actions/admin"
import {
  createInvitationsAction as createInvitationsVerb,
  inviteUsersAction,
  revokeInvitationAction as revokeInvitationVerb,
} from "@/server/actions/invitations"
import type { AdminUserRow } from "@/server/admin/users"

import type {
  CreateInvitationsState,
  InviteByEmailState,
  IssuedInvitation,
  UserActionResult,
  UserMutationResult,
  UserStatusValue,
} from "./action-types"

function confirmOf(row: AdminUserRow): UserMutationResult {
  return { id: row.id, email: row.email, role: row.role, status: row.status }
}

function toState(result: ActionError): CreateInvitationsState {
  return {
    status: "error",
    message: result.error.message,
    code: result.error.code,
    ...(result.error.fields === undefined ? {} : { fields: result.error.fields }),
  }
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key)
  return typeof value === "string" ? value.trim() : ""
}

export async function adminSetUserStatusAction(
  id: string,
  status: UserStatusValue
): Promise<UserActionResult> {
  const result = await setUserStatusAction(id, status)
  if (isActionError(result)) return result

  revalidatePath("/admin/users", "page")
  revalidatePath("/admin", "page")
  return ok(confirmOf(result.data))
}

export async function adminSetUserLimitAction(id: string, limitPerDay: string): Promise<UserActionResult> {
  const result = await setUserApiLimitAction(id, limitPerDay)
  if (isActionError(result)) return result

  revalidatePath("/admin/users", "layout")
  return ok(confirmOf(result.data))
}

export async function adminDeleteUserAction(id: string): Promise<ActionResult<{ id: string }>> {
  const result = await deleteUserAction(id)
  if (isActionError(result)) return result

  revalidatePath("/admin/users", "layout")
  revalidatePath("/admin", "page")
  return result
}

export async function adminPromoteUserAction(id: string): Promise<UserActionResult> {
  const result = await promoteUserAction(id)
  if (isActionError(result)) return result

  revalidatePath("/admin/users", "page")
  revalidatePath("/admin", "page")
  return ok(confirmOf(result.data))
}

export async function adminDemoteUserAction(id: string): Promise<UserActionResult> {
  const result = await demoteUserAction(id)
  if (isActionError(result)) return result

  revalidatePath("/admin/users", "page")
  revalidatePath("/admin", "page")
  return ok(confirmOf(result.data))
}

export async function createInvitationsAction(
  _previous: CreateInvitationsState,
  formData: FormData
): Promise<CreateInvitationsState> {
  const label = text(formData, "label")
  const maxUses = text(formData, "maxUses")
  const expiresAt = text(formData, "expiresAt")

  // Adapt numeric form text; the backend schema validates the resulting values.
  // Blank optional inputs are omitted so its defaults, not null coercion, apply.
  const result = await createInvitationsVerb({
    count: Number(text(formData, "count")),
    ...(label === "" ? {} : { label }),
    ...(maxUses === "" ? {} : { maxUses: Number(maxUses) }),
    ...(expiresAt === "" ? {} : { expiresAt }),
  })
  if (isActionError(result)) return toState(result)

  revalidatePath("/admin/invitations", "page")
  revalidatePath("/admin", "page")

  const issued: IssuedInvitation[] = result.data.invitations.map((row) => ({
    id: row.id,
    label: row.label,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }))

  // Codes are returned only to this creation's reveal, never stored or logged here.
  return { status: "created", codes: result.data.plaintext, issued }
}

export async function inviteByEmailAction(
  _previous: InviteByEmailState,
  formData: FormData
): Promise<InviteByEmailState> {
  const emails = text(formData, "emails")
    .split(/[\s,;]+/)
    .filter((address) => address !== "")
  const label = text(formData, "label")
  const expiresAt = text(formData, "expiresAt")

  const result = await inviteUsersAction(emails, {
    ...(label === "" ? {} : { label }),
    ...(expiresAt === "" ? {} : { expiresAt }),
  })
  if (isActionError(result)) {
    // Zod reports a bad address under `emails.<index>`; the form has one field for all of them.
    const fields = result.error.fields ?? {}
    const emailError = Object.entries(fields).find(([key]) => key.startsWith("emails"))?.[1]
    return {
      status: "error",
      message: result.error.message,
      code: result.error.code,
      fields: { emails: emailError, label: fields.label, expiresAt: fields.expiresAt },
    }
  }

  revalidatePath("/admin/invitations", "page")
  revalidatePath("/admin", "page")
  return { status: "sent", deliveries: result.data.deliveries }
}

export async function revokeInvitationAction(
  id: string
): Promise<ActionResult<{ id: string }>> {
  const result = await revokeInvitationVerb(id)
  if (isActionError(result)) return result

  revalidatePath("/admin/invitations", "page")
  return result
}
