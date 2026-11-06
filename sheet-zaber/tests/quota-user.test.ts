import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { isActionError, type ActionResult } from "@/lib/action-result"
import { MAX_USER_API_LIMIT_PER_DAY } from "@/lib/schemas"
import { auditLogs, users } from "@/server/db/schema"

import {
  TEST_DB_URL_KEY,
  getTestDb,
  getTestDbUrl,
  getTestPool,
  migrateTestDb,
  startTestDb,
  stopTestDb,
  truncateAll,
  type TestDb,
} from "./helpers/db"

/*
 * `users.api_limit_per_day` (`backend-api-contract.md` §1.4's per-user day window, §4.6's admin row,
 * §4.7's verbs) against the real embedded PostgreSQL 16 and the COMMITTED migrations.
 *
 * Two halves, both measured on the database rather than the types:
 *
 * 1. the column exists in the migrations folder and Postgres itself — an INSERT that never names it
 *    lands on 500, `0` is storable (the "unlimited" marker), and the CHECK rejects `-1`. Editing
 *    `schema.ts` alone could not produce any of those three facts, which is the point of this file;
 * 2. `setUserApiLimit` is an admin verb like its siblings — RBAC first, no existence oracle, the
 *    change and its `user.limit` audit row in ONE transaction, `detail` a `{ from, to }` pair with no
 *    email in it, and §4.4 `validation` refusals for anything outside integer 0…10_000_000 (with a
 *    form/query string coerced, exactly like the pagination numbers).
 *
 * The engine-side behaviours (owner bypass, cross-API counting, 429 shape) are in
 * `tests/engine-quota.test.ts`, because they belong to the request path, not to this table.
 */

type AdminModule = typeof import("@/server/admin/users")
type UsersRepo = typeof import("@/server/db/queries/users")
type RouteModule = typeof import("@/app/api/internal/admin/users/[id]/route")
type ListRouteModule = typeof import("@/app/api/internal/admin/users/route")
type SessionModule = typeof import("@/server/auth/session")
type AuthenticatedUser = import("@/server/auth/guards").AuthenticatedUser
type UserRow = typeof users.$inferSelect
type AdminUserRow = import("@/server/admin/users").AdminUserRow

const ADMIN_ROW_KEYS = [
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
]

let test: TestDb
let admin: AdminModule
let repo: UsersRepo
let routes: { byId: RouteModule; list: ListRouteModule }
let session: SessionModule
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
  // The lazy pool reads `env.DATABASE_URL` on the first query, so publish it before importing
  // anything that touches the database.
  process.env.DATABASE_URL = url

  test = await getTestDb()
  const [adminModule, repoModule, sessionModule, byIdRoute, listRoute] = await Promise.all([
    import("@/server/admin/users"),
    import("@/server/db/queries/users"),
    import("@/server/auth/session"),
    import("@/app/api/internal/admin/users/[id]/route"),
    import("@/app/api/internal/admin/users/route"),
  ])
  admin = adminModule
  repo = repoModule
  session = sessionModule
  routes = { byId: byIdRoute, list: listRoute }
  cookieName = session.SESSION_COOKIE
}, 300_000)

beforeEach(async () => {
  await truncateAll()
})

afterAll(async () => {
  await stopTestDb()
})

/* ---------------------------------------------------------------- helpers */

async function insertUser(
  over: Partial<{ role: "user" | "owner"; status: "active" | "disabled"; apiLimitPerDay: number }> = {}
): Promise<UserRow> {
  const id = randomUUID()
  const [row] = await test
    .insert(users)
    .values({
      id,
      googleSub: `quota-sub-${id}`,
      email: `quota-${id}@example.com`,
      role: over.role ?? "user",
      status: over.status ?? "active",
      ...(over.apiLimitPerDay === undefined ? {} : { apiLimitPerDay: over.apiLimitPerDay }),
    })
    .returning()
  return row
}

function actor(row: UserRow): AuthenticatedUser {
  return { id: row.id, email: row.email, role: row.role === "owner" ? "owner" : "user" }
}

function data<T>(result: ActionResult<T>): T {
  if ("data" in result) return result.data
  throw new Error(`expected ok, got ${JSON.stringify(result)}`)
}

async function storedLimit(id: string): Promise<number> {
  const [row] = await test
    .select({ apiLimitPerDay: users.apiLimitPerDay })
    .from(users)
    .where(eq(users.id, id))
  return row?.apiLimitPerDay ?? Number.NaN
}

async function audits(action: string, subjectId: string) {
  return test
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.subjectId, subjectId)))
}

/** A real session cookie for `as`, so `ownerRoute` re-reads the role from the DB like every route does. */
function patchRequest(as: UserRow, id: string, body: string): Request {
  const token = session.signSession({
    uid: as.id,
    role: as.role === "owner" ? "owner" : "user",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  return new Request(`http://localhost:3001/api/internal/admin/users/${id}`, {
    method: "PATCH",
    headers: new Headers({ cookie: `${cookieName}=${token}`, "content-type": "application/json" }),
    body,
  })
}

/* ---------------------------------------------------------------- 1. the migration is real */

describe("users.api_limit_per_day, as migrated", () => {
  it("emits a committed migration and a journal entry, not just a schema edit", async () => {
    const folder = fileURLToPath(new URL("../drizzle", import.meta.url))
    const journal = JSON.parse(await readFile(`${folder}/meta/_journal.json`, "utf8")) as {
      entries: Array<{ tag: string }>
    }
    expect(journal.entries.length).toBeGreaterThan(1)

    const tags = journal.entries.map((entry) => entry.tag)
    const sqlFile = tags.find((tag) => tag.startsWith("0001"))
    expect(sqlFile, `no 0001 migration in ${tags.join(", ")}`).toBeDefined()

    const sqlText = await readFile(`${folder}/${sqlFile}.sql`, "utf8")
    expect(sqlText).toContain('ADD COLUMN "api_limit_per_day" integer DEFAULT 500 NOT NULL')
    expect(sqlText).toContain("users_api_limit_per_day_check")
    expect(sqlText).toContain("CHECK (api_limit_per_day >= 0)")
  })

  it("is an integer NOT NULL column whose Postgres default is 500", async () => {
    const pool = await getTestPool()
    const { rows } = await pool.query(
      `select column_default, is_nullable, data_type
         from information_schema.columns
        where table_name = 'users' and column_name = 'api_limit_per_day'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ column_default: "500", is_nullable: "NO", data_type: "integer" })

    const check = await pool.query(
      `select conname, pg_get_constraintdef(oid) as definition
         from pg_constraint where conname = 'users_api_limit_per_day_check'`
    )
    expect(check.rows).toHaveLength(1)
    expect(check.rows[0].definition).toContain("api_limit_per_day >= 0")
  })

  it("lands on 500 for an INSERT that never names the column", async () => {
    const pool = await getTestPool()
    const id = randomUUID()
    // Raw SQL on purpose: nothing app-side may be supplying the default.
    await pool.query(
      `insert into users (id, google_sub, email) values ($1, $2, $3)`,
      [id, `raw-sub-${id}`, `raw-${id}@example.com`]
    )

    const { rows } = await pool.query(`select api_limit_per_day from users where id = $1`, [id])
    expect(rows[0].api_limit_per_day).toBe(500)

    const created = await repo.createUser({
      googleSub: `repo-sub-${id}`,
      email: `repo-${id}@example.com`,
      role: "user",
    })
    expect(created.apiLimitPerDay).toBe(500)
    expect(await storedLimit(created.id)).toBe(500)
  })

  it("refuses -1 with the CHECK constraint, and stores 0 (the unlimited marker)", async () => {
    const pool = await getTestPool()
    const id = randomUUID()

    await expect(
      pool.query(`insert into users (id, google_sub, email, api_limit_per_day) values ($1, $2, $3, -1)`, [
        id,
        `negative-sub-${id}`,
        `negative-${id}@example.com`,
      ])
    ).rejects.toThrow(/users_api_limit_per_day_check/)

    const zero = await insertUser({ apiLimitPerDay: 0 })
    expect(await storedLimit(zero.id)).toBe(0)

    const big = await insertUser({ apiLimitPerDay: MAX_USER_API_LIMIT_PER_DAY })
    expect(await storedLimit(big.id)).toBe(MAX_USER_API_LIMIT_PER_DAY)
  })

  it("updates through the repository verb and reads back in the admin projection", async () => {
    const member = await insertUser()
    const updated = await repo.setUserApiLimit(member.id, 1234)
    expect(updated?.apiLimitPerDay).toBe(1234)
    expect(await storedLimit(member.id)).toBe(1234)

    const adminRow = await repo.findAdminUserById(member.id)
    expect(adminRow?.apiLimitPerDay).toBe(1234)
    const page = await repo.listUsers({ limit: 50, offset: 0 })
    expect(page.rows.map((row) => [row.id, row.apiLimitPerDay])).toEqual([[member.id, 1234]])
  })
})

/* ---------------------------------------------------------------- 2. the admin verb */

describe("setUserApiLimit", () => {
  it("changes the column and writes ONE user.limit audit row, as a { from, to } pair", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()

    const row = data(await admin.setUserApiLimit(member.id, 1200, actor(owner)))
    expect(row).toMatchObject({ id: member.id, apiLimitPerDay: 1200 })
    expect(await storedLimit(member.id)).toBe(1200)

    const rows = await audits("user.limit", member.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(owner.id)
    expect(rows[0].subjectType).toBe("user")
    expect(rows[0].detail).toEqual({ from: 500, to: 1200 })
  })

  it("never puts an email in the audit detail", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()
    await admin.setUserApiLimit(member.id, 77, actor(owner))

    const [row] = await audits("user.limit", member.id)
    const wire = JSON.stringify(row.detail)
    expect(wire).not.toContain("@")
    expect(wire).not.toContain(member.email)
    expect(wire).not.toContain(owner.email)
  })

  it("accepts 0 as 'unlimited' and coerces a form-style string", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()

    expect(data(await admin.setUserApiLimit(member.id, "0", actor(owner))).apiLimitPerDay).toBe(0)
    expect(await storedLimit(member.id)).toBe(0)

    expect(data(await admin.setUserApiLimit(member.id, "4200", actor(owner))).apiLimitPerDay).toBe(4200)
    expect(await storedLimit(member.id)).toBe(4200)

    expect(data(await admin.setUserApiLimit(member.id, MAX_USER_API_LIMIT_PER_DAY, actor(owner))).apiLimitPerDay).toBe(
      MAX_USER_API_LIMIT_PER_DAY
    )
    expect(await audits("user.limit", member.id)).toHaveLength(3)
  })

  it("refuses anything outside integer 0..10000000 with §4.4 validation, touching nothing", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser({ apiLimitPerDay: 300 })

    for (const bad of [-1, -0.5, MAX_USER_API_LIMIT_PER_DAY + 1, 1.5, NaN, Infinity, "abc", "", " ", "1e999", null, undefined, true, {}, [], "500x"]) {
      const result = await admin.setUserApiLimit(member.id, bad as never, actor(owner))
      expect(isActionError(result), `${JSON.stringify(bad)} must be refused`).toBe(true)
      if (!isActionError(result)) continue
      expect(result.error.code, String(bad)).toBe("validation_failed")
      expect(result.error.category, String(bad)).toBe("validation")
      expect(Object.keys(result.error.fields ?? {}), String(bad)).toEqual(["apiLimitPerDay"])
    }

    expect(await storedLimit(member.id)).toBe(300)
    expect(await audits("user.limit", member.id)).toHaveLength(0)
  })

  it("asks RBAC before it asks the database: a non-owner gets the same answer for every id", async () => {
    const member = await insertUser()
    const stranger = await insertUser({ role: "user" })

    const result = await admin.setUserApiLimit(member.id, 9999, actor(stranger))
    expect(result).toEqual({
      error: { code: "forbidden", message: "You are not allowed to do that.", category: "auth" },
    })
    expect(await storedLimit(member.id)).toBe(500)
    expect(await audits("user.limit", member.id)).toHaveLength(0)
  })

  it("keeps the no-oracle shape: a non-uuid and an unknown uuid answer byte-identically", async () => {
    const owner = await insertUser({ role: "owner" })
    const answers = await Promise.all([
      admin.setUserApiLimit("not-a-uuid", 600, actor(owner)),
      admin.setUserApiLimit(randomUUID(), 600, actor(owner)),
    ])
    expect(answers[0]).toEqual(answers[1])
    expect(answers[0]).toEqual({
      error: { code: "not_found", message: "No user was found with that id.", category: "not_found" },
    })
  })

  it("is idempotent: re-applying the stored number writes no audit row", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser({ apiLimitPerDay: 640 })

    const again = data(await admin.setUserApiLimit(member.id, 640, actor(owner)))
    expect(again.apiLimitPerDay).toBe(640)
    expect(await audits("user.limit", member.id)).toHaveLength(0)
  })

  it("publishes exactly the eleven §4.6 keys, apiLimitPerDay included", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()

    const row = data(await admin.setUserApiLimit(member.id, 501, actor(owner))) as AdminUserRow
    expect(Object.keys(row).sort()).toEqual(ADMIN_ROW_KEYS)
    expect(row.apiLimitPerDay).toBe(501)
    // The stored number only: no quota maths, no usage, and no secret column.
    const wire = JSON.stringify(row)
    for (const forbiddenKey of ["googleSub", "code_hash", "codeHash", "invitation_code"]) {
      expect(wire, forbiddenKey).not.toContain(forbiddenKey)
    }

    const page = data(await admin.listUsers(actor(owner)))
    expect(Object.keys(page.rows[0]).sort()).toEqual(ADMIN_ROW_KEYS)
    expect(page.rows.map((r) => r.apiLimitPerDay).sort()).toEqual([500, 501])
  })

  it("does not treat a lower number as a privilege change for the actor", async () => {
    const owner = await insertUser({ role: "owner" })
    // Setting the ACTOR's own quota is allowed and harmless: the engine's owner bypass is what makes
    // an owner unlimited, and it lives in the engine, not in this verb.
    const row = data(await admin.setUserApiLimit(owner.id, 1, actor(owner)))
    expect(row).toMatchObject({ id: owner.id, role: "owner", apiLimitPerDay: 1 })
    expect(await audits("user.limit", owner.id)).toHaveLength(1)
  })
})

/* ---------------------------------------------------------------- 3. the JSON route */

describe("PATCH /api/internal/admin/users/{id} — apiLimitPerDay", () => {
  it("accepts the field, including a string, and answers the eleven-key row", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()

    const response = await routes.byId.PATCH(patchRequest(owner, member.id, '{"apiLimitPerDay":"1234"}'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: AdminUserRow }
    expect(Object.keys(body.data).sort()).toEqual(ADMIN_ROW_KEYS)
    expect(body.data.apiLimitPerDay).toBe(1234)
    expect(await storedLimit(member.id)).toBe(1234)
    expect(await audits("user.limit", member.id)).toHaveLength(1)
  })

  it("answers 400 with a fields entry for a bad quota and 400 for two fields at once", async () => {
    const owner = await insertUser({ role: "owner" })
    const member = await insertUser()

    const bad = await routes.byId.PATCH(patchRequest(owner, member.id, '{"apiLimitPerDay":-1}'))
    expect(bad.status).toBe(400)
    const badBody = (await bad.json()) as { error: { code: string; category: string; fields: Record<string, string> } }
    expect(badBody.error.code).toBe("validation_failed")
    expect(badBody.error.category).toBe("validation")
    expect(Object.keys(badBody.error.fields)).toEqual(["apiLimitPerDay"])
    expect(await storedLimit(member.id)).toBe(500)

    const mixed = await routes.byId.PATCH(
      patchRequest(owner, member.id, '{"apiLimitPerDay":800,"status":"disabled"}')
    )
    expect(mixed.status).toBe(400)
    expect(((await mixed.json()) as { error: { fields: Record<string, string> } }).error.fields).toEqual({
      body: "send exactly one of status, role or apiLimitPerDay",
    })
  })

  it("is owner-only on the wire too: a member session cannot raise itself", async () => {
    const member = await insertUser()
    const response = await routes.byId.PATCH(patchRequest(member, member.id, '{"apiLimitPerDay":99999}'))
    expect(response.status).toBe(403)
    expect(await storedLimit(member.id)).toBe(500)
    expect(await audits("user.limit", member.id)).toHaveLength(0)
  })
})
