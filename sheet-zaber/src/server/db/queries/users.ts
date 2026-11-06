import "server-only"

import { and, desc, eq, ne, sql } from "drizzle-orm"

import { db } from "../client"
import { invitations, userProfiles, users } from "../schema"
import { asDbLike, type DbLike, type DbTx, type Paged } from "./types"

export type UserRow = typeof users.$inferSelect
export type UserRole = "user" | "owner"
export type UserStatus = "active" | "disabled"

/** Every function takes an optional client so a service can run it inside its transaction. */
function client(q?: DbLike | DbTx): DbLike {
  return q === undefined ? db : asDbLike(q)
}

export async function findUserByGoogleSub(
  googleSub: string,
  q?: DbLike | DbTx
): Promise<UserRow | undefined> {
  const [row] = await client(q).select().from(users).where(eq(users.googleSub, googleSub)).limit(1)
  return row
}

export async function findUserById(id: string, q?: DbLike | DbTx): Promise<UserRow | undefined> {
  const [row] = await client(q).select().from(users).where(eq(users.id, id)).limit(1)
  return row
}

export async function createUser(
  input: { googleSub: string; email: string; role: UserRole; invitationId?: string | null },
  q?: DbLike | DbTx
): Promise<UserRow> {
  const [row] = await client(q)
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      googleSub: input.googleSub,
      email: input.email,
      role: input.role,
      invitationId: input.invitationId ?? null,
    })
    .returning()
  return row
}

/** Seeded from Google at registration; later sign-ins update the name without wiping edits. */
export async function upsertUserProfile(
  input: {
    userId: string
    displayName: string
    pictureUrl?: string | null
    timezone?: string | null
    theme?: "dark" | "light" | "system"
  },
  q?: DbLike | DbTx
): Promise<void> {
  const set: Record<string, unknown> = { displayName: input.displayName }
  if (input.pictureUrl !== undefined) set.pictureUrl = input.pictureUrl
  if (input.timezone !== undefined) set.timezone = input.timezone
  if (input.theme !== undefined) set.theme = input.theme

  await client(q)
    .insert(userProfiles)
    .values({
      userId: input.userId,
      displayName: input.displayName,
      pictureUrl: input.pictureUrl ?? null,
      timezone: input.timezone ?? null,
      theme: input.theme ?? "dark",
    })
    .onConflictDoUpdate({ target: userProfiles.userId, set })
}

export async function touchLastLogin(id: string, q?: DbLike | DbTx): Promise<void> {
  await client(q)
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, id))
}

export async function setUserStatus(
  id: string,
  status: UserStatus,
  q?: DbLike | DbTx
): Promise<UserRow | undefined> {
  const [row] = await client(q)
    .update(users)
    .set({ status, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning()
  return row
}

/**
 * The only place `role` is written after INSERT (`security.md` §3 item 5). Callers must be
 * owner-guarded and must audit the change.
 */
export async function setRole(
  id: string,
  role: UserRole,
  q?: DbLike | DbTx
): Promise<UserRow | undefined> {
  const [row] = await client(q)
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning()
  return row
}

/**
 * The only place `api_limit_per_day` is written after INSERT (`backend-api-contract.md` §1.4).
 * Callers must be owner-guarded and must audit the change. `0` is a valid value: it means
 * "unlimited", and the engine never opens a bucket for such a user.
 */
export async function setUserApiLimit(
  id: string,
  limitPerDay: number,
  q?: DbLike | DbTx
): Promise<UserRow | undefined> {
  const [row] = await client(q)
    .update(users)
    .set({ apiLimitPerDay: limitPerDay, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning()
  return row
}

/**
 * Owner census (`backend-api-contract.md` §4.6: `demoteUser` refuses the last owner). Counted in
 * the caller's transaction so a concurrent promote/demote cannot slip under the floor.
 *
 * A `disabled` owner cannot sign in — `readUser` returns null for any status but `active` — so it
 * administers nothing and must not satisfy the floor; only `status = 'active'` rows are counted.
 * `exceptId` is the row about to lose the role, so the caller asks "how many owners would still be
 * able to act", which is the question the lockout guard actually needs answered.
 */
export async function countActiveOwners(exceptId: string, q?: DbLike | DbTx): Promise<number> {
  const [row] = await client(q)
    .select({ total: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, "owner"), eq(users.status, "active"), ne(users.id, exceptId)))
  return row?.total ?? 0
}

/**
 * Owner bootstrap lookup (`scripts/seed-owner.ts`): the owner row only exists once that
 * address has signed in with Google, so the seed promotes it inside its own transaction.
 */
export async function findUserByEmail(email: string, q?: DbLike | DbTx): Promise<UserRow | undefined> {
  const [row] = await client(q).select().from(users).where(eq(users.email, email)).limit(1)
  return row
}

export async function deleteUser(id: string, q?: DbLike | DbTx): Promise<void> {
  await client(q).delete(users).where(eq(users.id, id))
}

export type AdminUserRow = UserRow & {
  displayName: string | null
  apiCount: number
  /** `invitations.label` behind `users.invitation_id` — the memo ONLY, never a code or a hash. */
  invitationLabel: string | null
  /** `COUNT(api_request_logs WHERE user_id = users.id)` (`backend-api-contract.md` §2, §4.6). */
  requestTotal: number
}

/**
 * The three joined aggregates the admin table renders. Written once here so `listUsers` and
 * `findAdminUserById` can never disagree about what a row means.
 *
 * `invitationLabel` and `requestTotal` are additive (contract §4.6 asks the admin list for
 * "invite used … request totals"); every key that already existed keeps its name and type,
 * including `googleSub` — which is why the ADMIN SURFACE (`src/server/admin/users.ts`) projects
 * an explicit column list before anything reaches a response. `users.api_limit_per_day` rides
 * along as `apiLimitPerDay` for the same reason: `user: users` selects it, and the admin
 * projection is the only thing that decides whether the owner sees it.
 */
function adminUserColumns() {
  return {
    user: users,
    displayName: userProfiles.displayName,
    invitationLabel: invitations.label,
    apiCount: sql<number>`(select count(*)::int from api_configurations c where c.user_id = ${users.id})`,
    requestTotal: sql<number>`(select count(*)::int from api_request_logs r where r.user_id = ${users.id})`,
  }
}

function toAdminUserRow(row: {
  user: UserRow
  displayName: string | null
  invitationLabel: string | null
  apiCount: number
  requestTotal: number
}): AdminUserRow {
  return {
    ...row.user,
    displayName: row.displayName,
    invitationLabel: row.invitationLabel,
    apiCount: row.apiCount,
    requestTotal: row.requestTotal,
  }
}

/** Owner-only listing: profile name, invite memo and counts joined in, never an invitation code. */
export async function listUsers(page: { limit: number; offset: number }): Promise<Paged<AdminUserRow>> {
  const rows = await db
    .select(adminUserColumns())
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .leftJoin(invitations, eq(invitations.id, users.invitationId))
    .orderBy(desc(users.createdAt))
    .limit(page.limit)
    .offset(page.offset)

  const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(users)
  return {
    rows: rows.map(toAdminUserRow),
    total: count?.total ?? 0,
  }
}

/**
 * The same row shape for one user, for the mutation verbs that must return the refreshed record
 * (`backend-api-contract.md` §4.6). Takes the optional client so a caller can read the row it just
 * updated inside its own transaction.
 */
export async function findAdminUserById(
  id: string,
  q?: DbLike | DbTx
): Promise<AdminUserRow | undefined> {
  const [row] = await client(q)
    .select(adminUserColumns())
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .leftJoin(invitations, eq(invitations.id, users.invitationId))
    .where(eq(users.id, id))
    .limit(1)
  return row === undefined ? undefined : toAdminUserRow(row)
}
