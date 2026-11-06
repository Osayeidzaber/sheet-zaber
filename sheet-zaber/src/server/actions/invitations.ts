"use server"

/*
 * Owner-only invitation minting, revoking and listing (`backend-api-contract.md` §2 "Admin", §4.5).
 *
 * Guard split, deliberately: this layer answers `unauthenticated` (no session) and `forbidden`
 * (a valid `user` session), which is exactly what `ownerRoute` answers; the RBAC row
 * `can(role, "invitation.create" | "invitation.revoke")`, the audit rows (including the audited
 * DENIAL) and the uuid check on `id` (`invitations/service.ts:444`) stay in
 * `src/server/invitations/service.ts:221`/`:439`.
 *
 * SECRETS: a read of this table never leaves the safe strings. `listInvitationsAction` and the
 * `invitations` arm of the create payload are `InvitationListItem` — the `code_hash`-stripped row
 * projection (`invitations/service.ts:147`), so `id` and `label` are the only invitation strings a
 * list carries. The plaintext CODES appear once, in `createInvitationsAction`'s return, which §4.5
 * names as the only place a plaintext exists; the admin hands them out and the system cannot read
 * them back. No action here returns a hash, and none redeems a code.
 *
 * NOT IMPLEMENTED HERE ON PURPOSE: `redeemInvitation`/`submitInvitation`. The `/login` wrapper is
 * frontend-owned (`integration-status.md` §Ownership, Q-B2) and `/auth/invitation` is the route;
 * adding a third door would split the throttle surface. When that wrapper is written it MUST pass
 * `RedeemInput.ip` explicitly — the honest value for a server action is `null`, since an action
 * cannot see the socket (B9); `clientIp(req)` is only available in the route. Never fabricate an
 * address from the browser: a made-up `X-Forwarded-For` in the body would poison the IP bucket.
 */

import type { ActionResult } from "@/lib/action-result"
import {
  createInvitations,
  inviteUsers,
  listInvitations,
  listInvitationsForAdmin,
  revokeInvitation,
  type AdminInvitationRow,
  type CreateInvitationsPayload,
  type InvitationListItem,
  type InviteUsersCallOptions,
  type InviteUsersPayload,
} from "@/server/invitations/service"

import { ownerAction } from "./support"

/**
 * §4.5 `createInvitations(input, actorId)`: `{ count, label?, maxUses?, expiresAt? }`, validated by
 * `createInvitationsSchema` inside the service. `expiresAt` is forwarded as a `Date` — an ISO string
 * becomes one here (an unparseable string becomes an Invalid Date, which the schema refuses with the
 * field error), so no rule is decided twice.
 */
export async function createInvitationsAction(input: {
  count: number
  label?: string | null
  maxUses?: number
  expiresAt?: Date | string | null
}): Promise<ActionResult<CreateInvitationsPayload>> {
  const { expiresAt, ...rest } = input
  return ownerAction((actor) =>
    createInvitations(
      {
        ...rest,
        ...(expiresAt === undefined ? {} : { expiresAt: typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt }),
      },
      actor.id
    )
  )
}

/** Mints one code per address and emails it; the plaintext never comes back to the caller. */
export async function inviteUsersAction(
  emails: string[],
  options: InviteUsersCallOptions
): Promise<ActionResult<InviteUsersPayload>> {
  return ownerAction((actor) => inviteUsers(emails, options, actor.id))
}

/**
 * §4.5 `revokeInvitation(id, actorId)`: sets `revoked_at`, audited, idempotent. The id is checked by
 * `invitationIdSchema` (`invitations/service.ts:117`, `:444`), so a malformed id is the service's
 * `validation_failed` here exactly as it is on the route — this layer adds no id rule of its own.
 */
export async function revokeInvitationAction(id: string): Promise<ActionResult<{ id: string }>> {
  return ownerAction((actor) => revokeInvitation(id, actor.id))
}

/**
 * `GET /api/internal/admin/invitations` as the plain list. §4.5: the service's `listInvitations()`
 * takes no actor because the CALLER is the guard — so the owner check lives in this wrapper, and
 * `status`/`redemptions` are absent from `InvitationListItem` by design (§4.5 line 411).
 */
export async function listInvitationsAction(): Promise<ActionResult<InvitationListItem[]>> {
  return ownerAction(() => listInvitations())
}

/**
 * The same page's full §4.5 payload: `InvitationListItem` plus the derived `status` and the
 * `invitation_redemptions` join (`invitations/service.ts:411`). Name resolution for the lead: the
 * contract calls this shape `InvitationRow`, the code calls it `AdminInvitationRow`, because the
 * repository's raw `invitations.$inferSelect` already owns that name (`:386`) — this action forwards
 * whichever the service exports, and the §4.5 line 361 members (`redeemedBy`/`email`/`redeemedAt`)
 * are the contract's own, not a leak this layer introduced.
 */
export async function listAdminInvitationsAction(): Promise<ActionResult<AdminInvitationRow[]>> {
  return ownerAction(() => listInvitationsForAdmin())
}
