"use server"

/*
 * Owner-only admin verbs over `users` (`backend-api-contract.md` §2 "Admin", §4.6).
 *
 * `src/server/admin/users.ts` owns every rule: `can(role, …)` (`:153`, `:215`), the uuid-shaped id
 * check that answers `not_found` without an existence oracle (`:216`), the status enum
 * (`:277`), the self-revocation lockout guard, the last-owner floor, the transaction that pairs the
 * change with its `audit_logs` row, and the ten-key `AdminUserRow` projection that keeps `googleSub`,
 * any invitation code and `invitations.code_hash` off the wire (`admin/users.ts:114`). This file adds
 * the guard the route already has (`unauthenticated` → `forbidden`) and nothing else — the service's
 * `ActionResult` is returned verbatim, so an action can never disagree with
 * `PATCH /api/internal/admin/users/{id}`.
 *
 * SIGNATURE NOTE (doc-vs-code, reported not patched): §4.6 spells these verbs with an
 * `actorId: string` last argument, while the shipped functions take the whole `AuthenticatedUser`
 * (`src/server/admin/users.ts:148`, `:272`, `:297`, `:313`) because the RBAC row is read from the
 * reloaded session. The session object is forwarded as-is; it is never spread into the input, so a
 * client cannot inject a role by way of the actor.
 */

import type { ActionResult } from "@/lib/action-result"
import {
  deleteUser,
  demoteUser,
  listUsers,
  promoteUser,
  setUserApiLimit,
  setUserStatus,
  type AdminUserPage,
  type AdminUserRow,
  type UserStatus,
} from "@/server/admin/users"

import { ownerAction } from "./support"

/** §2 `GET /api/internal/admin/users?page&per_page`: the paged `AdminUserRow` list. */
export async function listAdminUsersAction(
  page?: number | string,
  perPage?: number | string
): Promise<ActionResult<AdminUserPage>> {
  return ownerAction((actor) => listUsers(actor, page, perPage))
}

/**
 * §2 `setUserStatus(id, 'active'|'disabled')`: immediate, because `readUser` re-reads
 * `users.status` on the target's next request (`authentication-flow.md` §2). `status` stays `unknown`
 * on the wire and is asserted, not trusted: `admin/users.ts:277` parses it with its own
 * `z.enum(["active","disabled"])` and answers `validation_failed` with the `status` field error, so
 * the cast below is plumbing for the compiler and the only way to keep this layer from re-deciding a
 * rule the service already owns.
 */
export async function setUserStatusAction(
  id: string,
  status: unknown
): Promise<ActionResult<AdminUserRow>> {
  return ownerAction((actor) => setUserStatus(id, status as UserStatus, actor))
}

/** `users.api_limit_per_day`: validated by the service; 0 means unlimited. */
export async function setUserApiLimitAction(
  id: string,
  limitPerDay: number | string
): Promise<ActionResult<AdminUserRow>> {
  return ownerAction((actor) => setUserApiLimit(id, limitPerDay, actor))
}

/** §2 `promoteUser(id)`: role change, audited. */
export async function promoteUserAction(id: string): Promise<ActionResult<AdminUserRow>> {
  return ownerAction((actor) => promoteUser(id, actor))
}

/** §2 `demoteUser(id)`: refuses the actor's own account and the last owner; audited. */
export async function demoteUserAction(id: string): Promise<ActionResult<AdminUserRow>> {
  return ownerAction((actor) => demoteUser(id, actor))
}

/** `DELETE /api/internal/admin/users/{id}`: the schema's cascade path, guarded the same way. */
export async function deleteUserAction(id: string): Promise<ActionResult<{ id: string }>> {
  return ownerAction((actor) => deleteUser(id, actor))
}
