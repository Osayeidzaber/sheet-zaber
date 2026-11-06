/*
 * Shared action-state shapes for the owner console.
 *
 * These live in their own module because `./actions.ts` is a `"use server"` file, and such a module
 * may export async functions only (§ hard rules) — yet the client islands need the state type to
 * declare their `useActionState` initial value and to read `error.fields` by name. One plain module
 * serves both sides and holds no logic.
 *
 * No secret material appears in any of these types. `codes` is the one exception by necessity:
 * `createInvitations` returns plaintext codes exactly once (`docs/backend-api-contract.md` §4.5) and
 * that single return is the ONLY place they exist client-side. They are never put in a URL, a query,
 * `localStorage`, or a re-fetched list — see `./invitations/code-reveal.tsx`.
 */

import type { ActionResult } from "@/lib/action-result"

/** The `users` columns a mutation may move, mirrored locally so no client file imports `server-only` code. */
export type UserStatusValue = "active" | "disabled"
export type RoleValue = "owner" | "user"

/** What a user mutation confirms: the four columns the verbs write, and nothing else. */
export type UserMutationResult = {
  id: string
  email: string
  role: RoleValue
  status: UserStatusValue
}

/** Field names `createInvitationsSchema` (`src/lib/schemas.ts:28`) can report. */
export type InvitationFieldErrors = {
  count?: string
  label?: string
  maxUses?: string
  expiresAt?: string
}

/**
 * One created invitation row, from `CreateInvitationsPayload.invitations` — the hash-stripped
 * `InvitationListItem` projection (`src/server/invitations/service.ts:147`). Dates are ISO strings so
 * the payload stays serializable across the action boundary.
 */
export type IssuedInvitation = {
  id: string
  label: string | null
  maxUses: number
  uses: number
  expiresAt: string | null
  createdAt: string
}

export type CreateInvitationsState =
  | { status: "idle" }
  | { status: "error"; message: string; code: string; fields?: InvitationFieldErrors }
  | { status: "created"; codes: string[]; issued: IssuedInvitation[] }

export type UserActionResult = ActionResult<UserMutationResult>

export type InviteDeliveryView = { email: string; invitationId: string; accepted: boolean; reason?: string }

export type InviteByEmailState =
  | { status: "idle" }
  | { status: "error"; message: string; code: string; fields?: { emails?: string; label?: string; expiresAt?: string } }
  | { status: "sent"; deliveries: InviteDeliveryView[] }
