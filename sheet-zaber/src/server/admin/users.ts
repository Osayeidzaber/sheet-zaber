import "server-only"

/*
 * The owner-only admin surface over `users` (`backend-api-contract.md` §2 "Admin", §4.6, §4.7).
 *
 * Three rules hold this module together:
 *
 * 1. RBAC, not routing. Every verb asks `can(actor.role, …)` from `src/server/auth/rbac.ts`. The
 *    `ownerRoute` guard in front of a JSON route is the first line, not the only line: a server
 *    action or a script that imports these functions gets the same answer. A denial is
 *    `forbidden`/`auth`, which `internal-route` maps to 403.
 * 2. No existence oracle. "Not a uuid", "no such row" and "the row vanished mid-write" all return
 *    the SAME `not_found` body, byte for byte, and the role check runs FIRST so a non-owner never
 *    learns whether an id exists. A refusal writes NO audit row: a guessed id must not turn into
 *    a growing table the owner has to read, and `audit_logs` records changes, not attempts here
 *    (the invitation service is the one that audits denials, and it is not this file).
 * 3. The lockout guard. An owner may not disable or demote their OWN account — it is the one
 *    action that can strand the platform with nobody able to administer it. §4.6's "refuse the
 *    last owner" floor is the same guard from the other side; it is implemented even though the
 *    self-check fires first in every reachable shape of the case, so a future role model cannot
 *    quietly drop to zero owners.
 *
 * Wire shape: §4.6's `AdminUserRow` lives HERE (that is the file the contract names) and is built
 * from the repository row by an explicit projection — `googleSub`, `updatedAt` and the profile
 * columns cannot ride along by accident, and an invitation id is a row id ONLY: never a plaintext
 * code, never `invitations.code_hash`.
 *
 * Audit actions: `AuditAction` carries every verb used here (`user.disable`, `user.enable`,
 * `user.promote`, `user.demote`, `user.delete`, `user.limit`). `detail` is `{ from, to }` — the old
 * and new value of the ONE column that moved; never an email (the scrubber would drop the key
 * anyway, and the subject is identifiable by `subjectId`).
 */

import { sql } from "drizzle-orm"
import { z } from "zod"

import { fail, internalError, ok, type ActionResult } from "@/lib/action-result"
import { apiLimitPerDaySchema, MAX_USER_API_LIMIT_PER_DAY } from "@/lib/schemas"
import type { AuthenticatedUser } from "@/server/auth/guards"
import { recordAudit, type AuditAction } from "@/server/admin/audit"
import type { SessionRole } from "@/server/auth/session"
import { can, type Action } from "@/server/auth/rbac"
import { db } from "@/server/db/client"
import type { DbTx } from "@/server/db/queries/types"
import {
  countActiveOwners,
  deleteUser as removeUserRow,
  findAdminUserById,
  findUserById,
  listUsers as listUserRows,
  setRole,
  setUserApiLimit as setUserApiLimitRow,
  setUserStatus as setUserStatusRow,
  type AdminUserRow as UserAdminRow,
  type UserRow,
  type UserRole,
} from "@/server/db/queries/users"
import { countInvitationsCreatedBy } from "@/server/db/queries/admin-support"

/** `users.status`; `deleted` is a schema possibility no session or admin surface accepts. */
export type UserStatus = "active" | "disabled"

/** §4.6 — the only admin view of `users`. Adding a key here is a contract change. */
export type AdminUserRow = {
  id: string
  email: string
  role: SessionRole
  status: UserStatus
  /** `users.invitation_id` — the row id ONLY: never the plaintext code, never a `code_hash`. */
  invitationId: string | null
  invitationLabel: string | null
  apiCount: number
  requestTotal: number
  /**
   * `users.api_limit_per_day` — the STORED number, nothing more. The engine's two rules that this
   * column cannot express on its own (`role = 'owner'` is unlimited whatever it holds, `0` is
   * unlimited for anyone) are enforced in `src/server/engine/ratelimit.ts`, so the UI reads this as
   * "what the owner allocated", never as "what the user can actually send today".
   */
  apiLimitPerDay: number
  lastLoginAt: Date | null
  createdAt: Date
}

export type AdminUserPage = {
  rows: AdminUserRow[]
  total: number
  page: number
  perPage: number
}

/** The lockout message is fixed text — the tests and the UI both quote it (`§2 setUserStatus`). */
export const SELF_ACCESS_MESSAGE = "you cannot revoke your own access"
const LAST_OWNER_MESSAGE = "at least one owner must remain"
/** `invitations.created_by` is RESTRICT, not cascade — the account that minted codes must outlive them. */
const DELETE_BLOCKED_MESSAGE = "this account created invitations and cannot be deleted"
/** `users.api_limit_per_day`: quoted by `setUserApiLimit`'s refusal and by the admin UI alike. */
export const API_LIMIT_MESSAGE = `must be a whole number of 0 to ${MAX_USER_API_LIMIT_PER_DAY} (0 means unlimited)`

const DEFAULT_PAGE = 1
const DEFAULT_PER_PAGE = 50
const MAX_PER_PAGE = 200

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const statusInputSchema = z.enum(["active", "disabled"])

/** One `not_found` for every "this id cannot be acted on", so the id space is not readable. */
function notFound(): ActionResult<never> {
  return fail("not_found", "No user was found with that id.", "not_found")
}

function forbidden(): ActionResult<never> {
  return fail("forbidden", "You are not allowed to do that.", "auth")
}

/** The `users` columns are plain text, so the enum is decided here, once, per direction. */
function asRole(value: string): SessionRole {
  return value === "owner" ? "owner" : "user"
}

function asStatus(value: string): UserStatus {
  return value === "disabled" ? "disabled" : "active"
}

/** The projection §4.6 freezes: eleven keys, nothing else. */
function toAdminUserRow(row: UserAdminRow): AdminUserRow {
  return {
    id: row.id,
    email: row.email,
    role: asRole(row.role),
    status: asStatus(row.status),
    invitationId: row.invitationId,
    invitationLabel: row.invitationLabel,
    apiCount: row.apiCount,
    requestTotal: row.requestTotal,
    apiLimitPerDay: row.apiLimitPerDay,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  }
}

/** A page number arrives as a query string OR a JSON body, so both shapes are read. */
function parseWholeNumber(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function pageFields(field: string, message: string): ActionResult<never> {
  return fail("validation_failed", "The page parameters are not valid.", "validation", {
    [field]: message,
  })
}

/**
 * The `GET /api/internal/admin/users` read: newest first, paged, and still guarded by
 * `can(role, "user.list")` even though the route in front of it is owner-only.
 */
export async function listUsers(
  actor: AuthenticatedUser,
  page: number | string = DEFAULT_PAGE,
  perPage: number | string = DEFAULT_PER_PAGE
): Promise<ActionResult<AdminUserPage>> {
  if (!can(actor.role, "user.list")) return forbidden()

  const pageNumber = parseWholeNumber(page, DEFAULT_PAGE)
  if (pageNumber === null || pageNumber < DEFAULT_PAGE) {
    return pageFields("page", "must be a whole page number of 1 or greater")
  }
  const perPageNumber = parseWholeNumber(perPage, DEFAULT_PER_PAGE)
  if (perPageNumber === null || perPageNumber < 1 || perPageNumber > MAX_PER_PAGE) {
    return pageFields("per_page", `must be a whole number of 1 to ${MAX_PER_PAGE}`)
  }

  try {
    const rows = await listUserRows({
      limit: perPageNumber,
      offset: (pageNumber - 1) * perPageNumber,
    })
    return ok({
      rows: rows.rows.map(toAdminUserRow),
      total: rows.total,
      page: pageNumber,
      perPage: perPageNumber,
    })
  } catch {
    return internalError()
  }
}

/** Fixed key for `pg_advisory_xact_lock`: one queue for every change that can remove an owner's access. */
const OWNER_ACCESS_LOCK = 7_204_911

/**
 * Serializes access-reducing changes until the transaction ends. Without it, two owners acting at
 * once each still count the other as active and both changes commit, leaving no owner at all.
 */
async function lockOwnerAccess(tx: DbTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${OWNER_ACCESS_LOCK})`)
}

/** Everything one verb needs to know about itself. */
type Verb = {
  /** The RBAC row that authorizes it. */
  permission: Action
  /** The `audit_logs.action` value written when the column actually moves. */
  audit: AuditAction
  /** Which `fields` key a refusal is reported under (§4.6 puts role refusals under `role`). */
  field: string
  /** Which column this verb writes, and what it must become. */
  column: "status" | "role" | "api_limit_per_day"
  value: UserStatus | UserRole | number
  /** True for the two verbs that REDUCE the actor's own power. */
  revokesOwnAccess: boolean
  /** Applies the change inside the caller's transaction. */
  write: (id: string, tx: DbTx) => Promise<UserRow | undefined>
}

function currentValue(row: UserRow, column: Verb["column"]): string | number {
  if (column === "status") return row.status
  if (column === "role") return row.role
  return row.apiLimitPerDay
}

/**
 * The shared body of the five verbs: role check → id check → read the target → self-revocation and
 * last-owner refusals → write + audit + re-read in ONE transaction, so a change and its audit row
 * are never separable by a crash (`security.md` §3 item 6).
 *
 * An already-satisfied request (disabling a disabled user, promoting an owner) is an idempotent
 * `ok` that returns the refreshed row and writes NO audit row.
 */
async function applyVerb(
  id: string,
  actor: AuthenticatedUser,
  verb: Verb
): Promise<ActionResult<AdminUserRow>> {
  try {
    if (!can(actor.role, verb.permission)) return forbidden()
    if (!UUID_RE.test(id)) return notFound()

    return await db.transaction(async (tx) => {
      if (verb.revokesOwnAccess) await lockOwnerAccess(tx)

      const target = await findUserById(id, tx)
      if (target === undefined) return notFound()

      if (verb.revokesOwnAccess && target.id === actor.id) {
        return fail("validation_failed", SELF_ACCESS_MESSAGE, "validation", {
          [verb.field]: SELF_ACCESS_MESSAGE,
        })
      }

      // §4.6: neither demotion nor disabling may take the platform below one active owner.
      if (verb.revokesOwnAccess && target.role === "owner" && target.status === "active") {
        if ((await countActiveOwners(id, tx)) < 1) {
          return fail("validation_failed", LAST_OWNER_MESSAGE, "validation", {
            [verb.field]: LAST_OWNER_MESSAGE,
          })
        }
      }

      const before = currentValue(target, verb.column)
      if (before === verb.value) {
        const unchanged = await findAdminUserById(id, tx)
        return unchanged === undefined ? notFound() : ok(toAdminUserRow(unchanged))
      }

      const updated = await verb.write(id, tx)
      if (updated === undefined) return notFound()

      const refreshed = await findAdminUserById(id, tx)
      if (refreshed === undefined) return notFound()

      await recordAudit(
        {
          actorId: actor.id,
          action: verb.audit,
          subjectType: "user",
          subjectId: id,
          detail: { from: before, to: verb.value },
        },
        tx
      )

      return ok(toAdminUserRow(refreshed))
    })
  } catch {
    return internalError()
  }
}

/**
 * Disable or re-enable an account. `disabled` takes effect on the target's very next request,
 * because `readUser` re-reads `users.status` and returns `null` for anything but `active`
 * (`authentication-flow.md` §2) — no token revocation list is involved.
 */
export async function setUserStatus(
  id: string,
  status: UserStatus,
  actor: AuthenticatedUser
): Promise<ActionResult<AdminUserRow>> {
  const parsed = statusInputSchema.safeParse(status)
  if (!parsed.success) {
    return fail("validation_failed", "The status is not valid.", "validation", {
      status: "must be 'active' or 'disabled'",
    })
  }
  // The RBAC row follows the direction: disabling and enabling are separately grantable verbs.
  const disable = parsed.data === "disabled"
  return applyVerb(id, actor, {
    permission: disable ? "user.disable" : "user.enable",
    audit: disable ? "user.disable" : "user.enable",
    field: disable ? "id" : "status",
    column: "status",
    value: parsed.data,
    revokesOwnAccess: disable,
    write: (targetId, tx) => setUserStatusRow(targetId, parsed.data, tx),
  })
}

/**
 * Allocate one user's daily API quota (`users.api_limit_per_day`, contract §1.4): the number of
 * `/api/v1` calls the OWNER of an API may serve per day across ALL of their APIs and keys combined.
 * `0` means unlimited.
 *
 * The value is validated BEFORE the role check — the same order `setUserStatus` uses, so a malformed
 * body cannot probe the id space either. `role = 'owner'` and a stored `0` both mean unlimited, and
 * that bypass is the engine's decision (`engine/ratelimit.ts#engineUserDayLimit`), not this verb's:
 * the row stores what the owner allocated, and an owner's own number is written like anyone else's.
 */
export async function setUserApiLimit(
  id: string,
  limitPerDay: number | string,
  actor: AuthenticatedUser
): Promise<ActionResult<AdminUserRow>> {
  const parsed = apiLimitPerDaySchema.safeParse(limitPerDay)
  if (!parsed.success) {
    return fail("validation_failed", "The API limit is not valid.", "validation", {
      apiLimitPerDay: API_LIMIT_MESSAGE,
    })
  }
  return applyVerb(id, actor, {
    permission: "user.limit",
    audit: "user.limit",
    field: "apiLimitPerDay",
    column: "api_limit_per_day",
    value: parsed.data,
    // Raising or lowering someone else's quota never touches the actor's own access.
    revokesOwnAccess: false,
    write: (targetId, tx) => setUserApiLimitRow(targetId, parsed.data, tx),
  })
}

/** Grant the owner role. Audited (`security.md` §2). */
export async function promoteUser(
  id: string,
  actor: AuthenticatedUser
): Promise<ActionResult<AdminUserRow>> {
  return applyVerb(id, actor, {
    permission: "user.promote",
    audit: "user.promote",
    field: "role",
    column: "role",
    value: "owner",
    revokesOwnAccess: false,
    write: (targetId, tx) => setRole(targetId, "owner", tx),
  })
}

/** Withdraw the owner role. Refuses the actor's own account and the last owner. Audited. */
export async function demoteUser(
  id: string,
  actor: AuthenticatedUser
): Promise<ActionResult<AdminUserRow>> {
  return applyVerb(id, actor, {
    permission: "user.demote",
    audit: "user.demote",
    field: "role",
    column: "role",
    value: "user",
    revokesOwnAccess: true,
    write: (targetId, tx) => setRole(targetId, "user", tx),
  })
}

/**
 * Remove an account outright. There is no soft-deleted state to move to — `users_status_check`
 * admits only `active` and `disabled` — so this is the schema's own cascade path: connections,
 * profiles, spreadsheets, APIs and keys go with the row; `audit_logs.actor_id` and
 * `api_request_logs.user_id` are `SET NULL`, so the history outlives it (`database-schema.md`).
 *
 * §4.3's `Action` union and §4.6's `AuditAction` union each gained one member for this verb
 * (`user.delete`), so the permission is its own row and the audit row says what happened instead
 * of borrowing `user.disable`.
 */
export async function deleteUser(
  id: string,
  actor: AuthenticatedUser
): Promise<ActionResult<{ id: string }>> {
  try {
    if (!can(actor.role, "user.delete")) return forbidden()
    if (!UUID_RE.test(id)) return notFound()

    return await db.transaction(async (tx) => {
      await lockOwnerAccess(tx)

      const target = await findUserById(id, tx)
      if (target === undefined) return notFound()

      if (target.id === actor.id) {
        return fail("validation_failed", SELF_ACCESS_MESSAGE, "validation", {
          id: SELF_ACCESS_MESSAGE,
        })
      }
      if (target.role === "owner" && (await countActiveOwners(id, tx)) < 1) {
        return fail("validation_failed", LAST_OWNER_MESSAGE, "validation", { id: LAST_OWNER_MESSAGE })
      }
      if ((await countInvitationsCreatedBy(id, tx)) > 0) {
        return fail("validation_failed", DELETE_BLOCKED_MESSAGE, "validation", {
          id: DELETE_BLOCKED_MESSAGE,
        })
      }

      await removeUserRow(id, tx)
      await recordAudit(
        {
          actorId: actor.id,
          action: "user.delete",
          subjectType: "user",
          subjectId: id,
          detail: { from: target.status, to: "deleted" },
        },
        tx
      )

      return ok({ id })
    })
  } catch {
    return internalError()
  }
}
