import "server-only"

/*
 * The owner-only READ side of the admin surface over one account
 * (`backend-api-contract.md` §2 "Admin", §4.6) — the two halves the owner asked for:
 * "i can see all users, and edit their infomation" needs a detail view, and "the admin panel
 * should show all the api request n everything" needs the per-account usage counters and the
 * other account's API-key inventory.
 *
 * It is a separate file from `src/server/admin/users.ts` on purpose: that module owns the WRITE
 * verbs, their lockout guards and their audit rows. Nothing here changes a column, so nothing here
 * can need an audit row — and a read cannot inherit a mutation's invariants by accident.
 *
 * The same three rules as `admin/users.ts` hold this module together:
 *
 * 1. RBAC, not routing. `can(actor.role, "user.read")` is asked INSIDE every function here, before
 *    anything is read, so a server action or a script that imports them gets the same answer as
 *    `ownerRoute`. A denial is `forbidden`/`auth`, which `internal-route` maps to 403.
 * 2. No existence oracle. "Not a uuid" and "no such row" return the SAME `not_found` body, byte for
 *    byte, and the identical one the shipped PATCH/DELETE verbs return (`admin/users.ts:97`) — a
 *    guessed id cannot be sorted into "real" and "not real".
 * 3. The scope is the URL PATH. `?user_id=` is not read here at all, so it cannot disagree with the
 *    segment the route already resolved (`§2` routes hand the id through `InternalContext.path`).
 *
 * SECRET RULE (the reason the key list is safe to hand an owner): `api_keys.key_hash` is
 * secret-equivalent and the plaintext `sz_live_…` is never stored, so this module has no path that
 * can produce either. The row shape is written field by field from `ApiKeyMeta`, which the
 * repository already projects without `keyHash` (`db/queries/api-keys.ts:37`), and
 * `GET /api/internal/admin/users/{id}/keys` returns `preview` — the display-safe `sz_live_ab12…`
 * prefix — and nothing else about the credential's value.
 *
 * IDENTITY RULE: nothing here writes, and nothing here even reads `users.google_sub` into a
 * payload. `users.email` is UNIQUE and is the anchor matched on Google sign-in
 * (`authentication-flow.md` §1), so an owner edit of it would silently strand the account;
 * `email` is therefore output-only in this surface.
 */

import { and, eq, gt, gte, isNull, or, sql } from "drizzle-orm"

import { fail, internalError, ok, type ActionResult } from "@/lib/action-result"
import type { AuthenticatedUser } from "@/server/auth/guards"
import { can } from "@/server/auth/rbac"
import type { SessionRole } from "@/server/auth/session"
import { db } from "@/server/db/client"
import { apiKeys, apiRequestLogs, registeredSpreadsheets } from "@/server/db/schema"
import { listApiKeysForAdmin, type AdminApiKeyRow, type ApiKeyScope } from "@/server/db/queries/api-keys"
import { findAdminUserById, findUserById, type AdminUserRow as UserAdminRow } from "@/server/db/queries/users"

/** §4.6's `AdminUserRow` — re-declared here rather than imported, see the projection note below. */
export type AdminUserDetailRow = {
  id: string
  email: string
  role: SessionRole
  status: "active" | "disabled"
  invitationId: string | null
  invitationLabel: string | null
  apiCount: number
  requestTotal: number
  apiLimitPerDay: number
  lastLoginAt: Date | null
  createdAt: Date
}

/**
 * The detail payload: the ten §4.6 keys plus the three the owner panel needs and the list cannot
 * afford to compute per row (they are only ever shown for ONE account).
 */
export type AdminUserDetail = AdminUserDetailRow & {
  /** `COUNT(api_request_logs WHERE user_id = id AND created_at >= UTC midnight)`. */
  requestsToday: number
  /** `COUNT(registered_spreadsheets WHERE user_id = id)` — both statuses: an inaccessible sheet is still a problem the owner sees. */
  spreadsheetCount: number
  /** Never revoked AND not past `expires_at`; expiry is judged by the database clock, the same clock `findApiKeyByHash` uses. */
  activeKeyCount: number
}

/** One row of `GET /api/internal/admin/users/{id}/keys`. No `userId`: the list is already scoped to the id in the path. */
export type AdminUserKeyRow = {
  id: string
  /** `api_keys.key_preview` — `sz_live_ab12…last4`, display-safe by design. */
  preview: string
  name: string
  scopes: ApiKeyScope[]
  allowedApiIds: string[] | null
  expiresAt: Date | null
  revokedAt: Date | null
  lastUsedAt: Date | null
  createdAt: Date
  /** `COUNT(api_request_logs WHERE api_key_id = key.id)`. */
  requestCount: number
}

export type AdminUserKeyPage = { rows: AdminUserKeyRow[] }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Byte-identical to `admin/users.ts:97`, which is the point: one miss, one body. */
function notFound(): ActionResult<never> {
  return fail("not_found", "No user was found with that id.", "not_found")
}

function forbidden(): ActionResult<never> {
  return fail("forbidden", "You are not allowed to do that.", "auth")
}

/** `users.role` / `users.status` are plain text, so the enum is decided here, once, per column. */
function asRole(value: string): SessionRole {
  return value === "owner" ? "owner" : "user"
}

function asStatus(value: string): "active" | "disabled" {
  return value === "disabled" ? "disabled" : "active"
}

/**
 * The §4.6 projection, field by field. It is a SECOND copy of `admin/users.ts:114`'s private
 * `toAdminUserRow` — that function is not exported and `admin/users.ts` is frozen for this surface,
 * so the alternative was spreading the repository row, which carries `googleSub` and
 * `updatedAt`. An explicit list is the only version of this that cannot leak.
 */
function toDetailRow(row: UserAdminRow): AdminUserDetailRow {
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

/**
 * The UTC midnight `now` falls in — the floor for `requestsToday`. Computed from an injected clock
 * so the boundary is a value a test can pin, and never the wall clock moving underneath an
 * assertion. `Date.UTC` of the UTC parts is midnight-of-that-UTC-day regardless of the host's zone.
 */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * The three counters, issued together (`Promise.all`, the same shape `db/queries/platform-stats.ts`
 * uses for the owner analytics tile): three narrow COUNTs, each with its predicate written in the
 * WHERE clause rather than in a correlated subquery. A raw `(select count(*) … = ${users.id})` chunk
 * would be one round-trip, but Drizzle leaves a `${column}` UNQUALIFIED when the outer select has no
 * join, and Postgres then binds `"id"` to the subquery's own table — so the one-statement version is
 * a type error (or, worse, a silently wrong number) waiting for the next edit.
 *
 * `activeKeyCount` never counts a revoked row and never counts a lapsed one: expiry is judged by
 * `now()`, the database clock, exactly as `findApiKeyByHash` judges it, so no function instance's own
 * clock can decide whether a key is still live.
 */
async function readCounts(
  userId: string,
  now: Date
): Promise<Pick<AdminUserDetail, "requestsToday" | "spreadsheetCount" | "activeKeyCount">> {
  const dayStart = utcDayStart(now)
  const total = sql<number>`count(*)::int`

  const [requests, sheets, keys] = await Promise.all([
    db
      .select({ total })
      .from(apiRequestLogs)
      .where(and(eq(apiRequestLogs.userId, userId), gte(apiRequestLogs.createdAt, dayStart))),
    db
      .select({ total })
      .from(registeredSpreadsheets)
      .where(eq(registeredSpreadsheets.userId, userId)),
    db
      .select({ total })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.userId, userId),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`))
        )
      ),
  ])

  return {
    requestsToday: requests[0]?.total ?? 0,
    spreadsheetCount: sheets[0]?.total ?? 0,
    activeKeyCount: keys[0]?.total ?? 0,
  }
}

/**
 * `GET /api/internal/admin/users/{id}`: the §4.6 row plus that account's usage counters.
 *
 * Order is load-bearing: role → id shape → row → counters. A non-owner never reaches a read, so it
 * never learns whether the id exists; a malformed id never reaches a read either.
 */
export async function getUserDetail(
  id: string,
  actor: AuthenticatedUser,
  now: Date = new Date()
): Promise<ActionResult<AdminUserDetail>> {
  try {
    if (!can(actor.role, "user.read")) return forbidden()
    if (!UUID_RE.test(id)) return notFound()

    const row = await findAdminUserById(id)
    if (row === undefined) return notFound()

    return ok({ ...toDetailRow(row), ...(await readCounts(id, now)) })
  } catch {
    return internalError()
  }
}

/** The repository view → the wire view, named key by key: `userId` and any future column cannot ride along. */
function toKeyRow(row: AdminApiKeyRow): AdminUserKeyRow {
  return {
    id: row.id,
    preview: row.keyPreview,
    name: row.name,
    scopes: row.scopes,
    allowedApiIds: row.allowedApiIds,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    requestCount: row.requestCount,
  }
}

/**
 * `GET /api/internal/admin/users/{id}/keys`: another account's credentials, newest first, revoked
 * ones included (the owner is exactly the reader who needs to see them).
 *
 * The target account must exist, or the answer is the same `not_found` as every other miss; a
 * real account with no keys answers `{ rows: [] }`, never a 404. No row can carry a secret: the
 * repository projection has no `keyHash` column and the plaintext was never stored.
 */
export async function listAdminUserKeys(
  id: string,
  actor: AuthenticatedUser
): Promise<ActionResult<AdminUserKeyPage>> {
  try {
    if (!can(actor.role, "user.read")) return forbidden()
    if (!UUID_RE.test(id)) return notFound()

    // Existence only — the row itself is never serialized here, so no column can leak through it.
    if ((await findUserById(id)) === undefined) return notFound()

    return ok({ rows: (await listApiKeysForAdmin(id)).map(toKeyRow) })
  } catch {
    return internalError()
  }
}
