import { randomUUID } from "node:crypto"

import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { isActionError, type ActionResult } from "@/lib/action-result"
import { apiRequestLogs, auditLogs, invitations, users } from "@/server/db/schema"

import {
  TEST_DB_URL_KEY,
  getTestDb,
  getTestDbUrl,
  migrateTestDb,
  startTestDb,
  stopTestDb,
  truncateAll,
  type TestDb,
} from "./helpers/db"

/*
 * The owner-only verbs over `users` (`backend-api-contract.md` §2 Admin, §4.6) against the real
 * embedded PostgreSQL 16 and the committed migrations — because every claim in this file is about
 * the database: the role column moving, exactly one `audit_logs` row per change, and NO row per
 * refusal. Prerequisites are raw schema inserts (`src/app/(app)` and the sibling services are
 * concurrent work, and importing them here would make this suite flaky for reasons that are not
 * this surface's).
 *
 * The 401-after-disable claim is checked through a `userRoute` probe, which is the same
 * `readUser`-backed path the real routes take (`authentication-flow.md` §2): a `disabled` row makes
 * the guard return `null`, and the guard is the only thing that kept the session alive.
 */

type AdminModule = typeof import("@/server/admin/users")
type GuardsModule = typeof import("@/server/auth/guards")
type SessionModule = typeof import("@/server/auth/session")
type InternalRouteModule = typeof import("@/server/http/internal-route")
type UserRow = typeof users.$inferSelect
type AuthenticatedUser = import("@/server/auth/guards").AuthenticatedUser

let test: TestDb
let admin: AdminModule
let guards: GuardsModule
let session: SessionModule
let internalRoute: InternalRouteModule
let cookieName = "sz_session"

beforeAll(async () => {
  let url: string
  try {
    url = inject(TEST_DB_URL_KEY)
  } catch {
    await startTestDb()
    await migrateTestDb()
    url = getTestDbUrl()
  }
  // The lazy pool reads `env.DATABASE_URL` on the first query, so the URL is published before the
  // modules under test are imported.
  process.env.DATABASE_URL = url

  test = await getTestDb()
  const [adminModule, guardsModule, sessionModule, routeModule] = await Promise.all([
    import("@/server/admin/users"),
    import("@/server/auth/guards"),
    import("@/server/auth/session"),
    import("@/server/http/internal-route"),
  ])
  admin = adminModule
  guards = guardsModule
  session = sessionModule
  internalRoute = routeModule
  cookieName = session.SESSION_COOKIE
}, 300_000)

beforeEach(async () => {
  await truncateAll()
})

afterAll(async () => {
  await stopTestDb()
})

async function insertUser(over: Partial<{ role: string; status: string }> = {}): Promise<UserRow> {
  const id = randomUUID()
  const [row] = await test
    .insert(users)
    .values({
      id,
      googleSub: `admin-sub-${id}`,
      email: `admin-${id}@example.com`,
      role: over.role ?? "user",
      status: over.status ?? "active",
    })
    .returning()
  return row
}

function actor(row: UserRow): AuthenticatedUser {
  return { id: row.id, email: row.email, role: row.role === "owner" ? "owner" : "user" }
}

function token(row: UserRow, role: "user" | "owner" = "user"): string {
  return session.signSession({
    uid: row.id,
    role,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
}

function requestFor(row: UserRow): Request {
  return new Request("http://localhost:3001/logs", {
    headers: new Headers({ cookie: `${cookieName}=${token(row)}` }),
  })
}

async function auditRows(action: string, subjectId: string) {
  return test
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.subjectId, subjectId)))
}

async function allAuditRows() {
  return test.select().from(auditLogs)
}

async function reload(id: string): Promise<UserRow> {
  const [row] = await test.select().from(users).where(eq(users.id, id))
  return row
}

/** Unwraps the `ok` side; a refusal fails the test with the envelope printed. */
function data<T>(result: ActionResult<T>): T {
  if (isActionError(result)) throw new Error(`unexpected refusal: ${JSON.stringify(result.error)}`)
  return result.data
}

function errorOf(result: ActionResult<unknown>) {
  if (!isActionError(result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`)
  return result.error
}

describe("setUserStatus", () => {
  it("disables and re-enables an account, and the disabled session's own route call is a 401", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()
    const probe = internalRoute.userRoute(async (ctx) => ({ ok: true, data: { id: ctx.user.id } }) as const)

    // Baseline: a live session on an active row.
    expect((await probe(requestFor(member))).status).toBe(200)

    const disabled = data(await admin.setUserStatus(member.id, "disabled", actor(owner)))
    expect(disabled).toMatchObject({ id: member.id, status: "disabled", email: member.email })
    expect((await reload(member.id)).status).toBe("disabled")

    // The guard re-reads the row, so the SAME signed cookie is now an unauthenticated request.
    const refusal = await probe(requestFor(member))
    expect(refusal.status).toBe(401)
    expect(await refusal.json()).toEqual({
      error: { code: "unauthenticated", message: "Sign in to continue.", category: "auth" },
    })
    expect(await guards.readUser(requestFor(member))).toBeNull()

    const enabled = data(await admin.setUserStatus(member.id, "active", actor(owner)))
    expect(enabled.status).toBe("active")
    expect((await probe(requestFor(member))).status).toBe(200)

    // One audit row per direction — and only per direction that moved a column.
    expect(await auditRows("user.disable", member.id)).toHaveLength(1)
    expect(await auditRows("user.enable", member.id)).toHaveLength(1)
  })

  it("writes the actor and the subject on the audit row, and no secret-shaped detail", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()

    data(await admin.setUserStatus(member.id, "disabled", actor(owner)))

    const [row] = await auditRows("user.disable", member.id)
    expect(row).toMatchObject({
      actorId: owner.id,
      action: "user.disable",
      subjectType: "user",
      subjectId: member.id,
      detail: { from: "active", to: "disabled" },
    })
  })

  it("is idempotent: a no-op status write returns the row and audits nothing", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser({ status: "disabled" })

    const result = data(await admin.setUserStatus(member.id, "disabled", actor(owner)))
    expect(result.status).toBe("disabled")
    expect(await allAuditRows()).toHaveLength(0)
  })

  it("refuses a status that is not one of the two literals, without touching the row", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()

    const error = errorOf(
      await admin.setUserStatus(member.id, "deleted" as "disabled", actor(owner))
    )
    expect(error).toMatchObject({ code: "validation_failed", category: "validation" })
    expect(error.fields).toEqual({ status: "must be 'active' or 'disabled'" })
    expect((await reload(member.id)).status).toBe("active")
    expect(await allAuditRows()).toHaveLength(0)
  })
})

describe("the lockout guard", () => {
  it("refuses an owner disabling their own account, with the fixed message and no audit row", async () => {
    const owner = await insertUser({ role: "owner" })

    const error = errorOf(await admin.setUserStatus(owner.id, "disabled", actor(owner)))
    expect(error.code).toBe("validation_failed")
    expect(error.category).toBe("validation")
    expect(error.message).toBe("you cannot revoke your own access")
    expect(error.fields).toEqual({ id: "you cannot revoke your own access" })
    expect((await reload(owner.id)).status).toBe("active")
    expect(await allAuditRows()).toHaveLength(0)
  })

  it("refuses an owner demoting their own account, with the same message and no audit row", async () => {
    const owner = await insertUser({ role: "owner" })

    const error = errorOf(await admin.demoteUser(owner.id, actor(owner)))
    expect(error.message).toBe("you cannot revoke your own access")
    expect(error.fields).toEqual({ role: "you cannot revoke your own access" })
    expect((await reload(owner.id)).role).toBe("owner")
    expect(await allAuditRows()).toHaveLength(0)
  })

  it("never leaves the platform without an owner: a second owner may be demoted, and an owner remains", async () => {
    const first = await insertUser({ role: "owner" })
    const second = await insertUser({ role: "owner" })

    const demoted = data(await admin.demoteUser(second.id, actor(first)))
    expect(demoted).toMatchObject({ id: second.id, role: "user" })
    expect((await reload(second.id)).role).toBe("user")

    const owners = await test.select().from(users).where(eq(users.role, "owner"))
    expect(owners.map((row) => row.id)).toEqual([first.id])
  })
})

describe("promoteUser / demoteUser", () => {
  it("flips users.role and writes exactly one audit_logs row each", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()

    const promoted = data(await admin.promoteUser(member.id, actor(owner)))
    expect(promoted.role).toBe("owner")
    expect((await reload(member.id)).role).toBe("owner")
    expect(await auditRows("user.promote", member.id)).toHaveLength(1)
    expect(await auditRows("user.demote", member.id)).toHaveLength(0)

    const demoted = data(await admin.demoteUser(member.id, actor(owner)))
    expect(demoted.role).toBe("user")
    expect((await reload(member.id)).role).toBe("user")
    expect(await auditRows("user.promote", member.id)).toHaveLength(1)
    expect(await auditRows("user.demote", member.id)).toHaveLength(1)
  })

  it("returns the refreshed §4.6 AdminUserRow, with the invitation as a label only", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()

    const row = data(await admin.promoteUser(member.id, actor(owner)))
    expect(Object.keys(row).sort()).toEqual(
      [
        "apiCount",
        "apiLimitPerDay",
        "createdAt",
        "email",
        "id",
        "invitationId",
        "invitationLabel",
        "lastLoginAt",
        "requestTotal",
        "role",
        "status",
      ].sort()
    )
    expect(row.invitationId).toBeNull()
    expect(row.invitationLabel).toBeNull()
    expect(row.apiCount).toBe(0)
    expect(row.requestTotal).toBe(0)

    const wire = JSON.stringify(row)
    for (const forbiddenKey of ["googleSub", "code_hash", "codeHash", "invitation_code"]) {
      expect(wire).not.toContain(forbiddenKey)
    }
  })

  it("audits nothing when the role already matches (promoting an owner)", async () => {
    const owner = await insertUser({ role: "owner" })
    const other = await insertUser({ role: "owner" })

    const result = data(await admin.promoteUser(other.id, actor(owner)))
    expect(result.role).toBe("owner")
    expect(await allAuditRows()).toHaveLength(0)
  })
})

describe("refusals that must not become an oracle", () => {
  it("answers an unknown id, a non-uuid id and a vanished row with the identical not_found body", async () => {
    const owner = await insertUser({ role: "owner" })
    const unknown = randomUUID()

    const results = [
      errorOf(await admin.setUserStatus(unknown, "disabled", actor(owner))),
      errorOf(await admin.promoteUser(unknown, actor(owner))),
      errorOf(await admin.demoteUser(unknown, actor(owner))),
      errorOf(await admin.deleteUser(unknown, actor(owner))),
      errorOf(await admin.setUserStatus("not-a-uuid", "disabled", actor(owner))),
      errorOf(await admin.promoteUser("", actor(owner))),
      errorOf(await admin.deleteUser("not-a-uuid", actor(owner))),
    ]

    for (const error of results) {
      expect(error.code).toBe("not_found")
      expect(error.category).toBe("not_found")
    }
    // Byte-identical: same key order, same message, no `fields`, so nothing distinguishes them.
    for (const error of results) {
      expect(JSON.stringify(error)).toBe(JSON.stringify(results[0]))
    }
    expect(await allAuditRows()).toHaveLength(0)
  })

  it("refuses a user-role actor with forbidden, in the same shape for all five verbs, and changes nothing", async () => {
    const member = await insertUser()
    const other = await insertUser()
    const target = await insertUser()

    const refusals = [
      errorOf(await admin.setUserStatus(target.id, "disabled", actor(member))),
      errorOf(await admin.setUserStatus(target.id, "active", actor(member))),
      errorOf(await admin.promoteUser(target.id, actor(member))),
      errorOf(await admin.demoteUser(target.id, actor(member))),
      errorOf(await admin.deleteUser(target.id, actor(member))),
    ]
    for (const error of refusals) {
      expect(error.code).toBe("forbidden")
      expect(error.category).toBe("auth")
    }
    expect(JSON.stringify(refusals.map((error) => error.message))).toBe(
      JSON.stringify(refusals.map(() => refusals[0].message))
    )

    // Nothing moved, and nothing was even attempted: the role check runs before any read or write.
    expect((await reload(target.id)).role).toBe("user")
    expect((await reload(target.id)).status).toBe("active")
    expect((await reload(other.id)).status).toBe("active")
    expect(await allAuditRows()).toHaveLength(0)

    // The list read is guarded the same way.
    const listError = errorOf(await admin.listUsers(actor(member)))
    expect(listError.code).toBe("forbidden")
  })

  it("answers a missing session through the guard, not through the verb", async () => {
    expect(await guards.readUser(new Request("http://localhost:3001/admin/users"))).toBeNull()
  })
})

describe("deleteUser", () => {
  it("removes the row, keeps its logs with no owner, and leaves the audit row behind", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()
    await test.insert(apiRequestLogs).values({
      userId: member.id,
      method: "GET",
      path: "/api/v1/anything",
      statusCode: 200,
      durationMs: 5,
    })
    expect(await test.select().from(apiRequestLogs)).toHaveLength(1)

    const removed = data(await admin.deleteUser(member.id, actor(owner)))
    expect(removed).toEqual({ id: member.id })

    // Gone, not disabled: there is no `deleted` status in `users_status_check`.
    expect(await test.select().from(users).where(eq(users.id, member.id))).toHaveLength(0)
    expect((await test.select().from(apiRequestLogs)).map((row) => row.userId)).toEqual([null])

    // History outlives the record: the audit row stays, and it is the only one written.
    const rows = await auditRows("user.delete", member.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toEqual({ from: "active", to: "deleted" })
    expect(rows[0].actorId).toBe(owner.id)
    expect(await allAuditRows()).toHaveLength(1)
  })

  it("kills the deleted account's session on its next request", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()
    const probe = internalRoute.userRoute(async (ctx) => ({ ok: true, data: { id: ctx.user.id } }) as const)
    expect((await probe(requestFor(member))).status).toBe(200)

    data(await admin.deleteUser(member.id, actor(owner)))
    expect((await probe(requestFor(member))).status).toBe(401)
    expect(await guards.readUser(requestFor(member))).toBeNull()
  })

  it("refuses to delete the actor's own account, with the lockout message and no audit row", async () => {
    const owner = await insertUser({ role: "owner" })
    const other = await insertUser({ role: "owner" })

    const error = errorOf(await admin.deleteUser(owner.id, actor(owner)))
    expect(error.code).toBe("validation_failed")
    expect(error.message).toBe(admin.SELF_ACCESS_MESSAGE)
    expect(error.fields).toEqual({ id: admin.SELF_ACCESS_MESSAGE })
    expect(await test.select().from(users).where(eq(users.id, owner.id))).toHaveLength(1)

    // The same guard read from the side: with a second owner present, the OTHER owner is deletable.
    data(await admin.deleteUser(other.id, actor(owner)))
    expect(await test.select().from(users).where(eq(users.id, other.id))).toHaveLength(0)
    expect(await allAuditRows()).toHaveLength(1)
  })

  it("refuses in words an account that minted invitations, instead of a 23503", async () => {
    const owner = await insertUser({ role: "owner" })
    const minter = await insertUser()
    await test.insert(invitations).values({
      id: randomUUID(),
      codeHash: "c".repeat(64),
      label: "keep me",
      maxUses: 1,
      uses: 0,
      createdBy: minter.id,
    })

    const error = errorOf(await admin.deleteUser(minter.id, actor(owner)))
    expect(error.code).toBe("validation_failed")
    expect(error.message).toBe("this account created invitations and cannot be deleted")
    expect(await test.select().from(users).where(eq(users.id, minter.id))).toHaveLength(1)
    expect(await allAuditRows()).toHaveLength(0)
  })
})
