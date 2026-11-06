import { randomUUID } from "node:crypto"

import { and, eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { sha256 } from "@/lib/crypto"
import {
  apiRequestLogs,
  auditLogs,
  googleConnections,
  invitations,
  userProfiles,
  users,
} from "@/server/db/schema"

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
 * Route-level coverage for the owner-only admin surface (`backend-api-contract.md` §2 "Admin", §4.6):
 * `GET /api/internal/admin/users`, `PATCH|DELETE /api/internal/admin/users/{id}`, plus the invitation
 * verbs and the audit scrubber they depend on. Driven with a genuine signed `sz_session` against the
 * real embedded PostgreSQL 16, because every claim here is about the guard, the projection or the
 * `audit_logs` row — not about a mock.
 *
 * Two claims are worth naming before the code says them:
 *   - the admin row is ten keys and no more. `google_sub`, `updated_at`, the profile display name,
 *     an invitation plaintext and `invitations.code_hash` are searched for on the WIRE TEXT, so a
 *     column cannot join the response by accident;
 *   - a refusal writes no audit row here (`src/server/admin/users.ts`), while the invitation service
 *     does audit a denial. Both behaviors are asserted, because they are deliberately different.
 */

type SessionModule = typeof import("@/server/auth/session")
type AdminModule = typeof import("@/server/admin/users")
type AuditModule = typeof import("@/server/admin/audit")
type InvitationModule = typeof import("@/server/invitations/service")
type Routes = {
  list: typeof import("@/app/api/internal/admin/users/route")
  byId: typeof import("@/app/api/internal/admin/users/[id]/route")
}
type UserRow = typeof users.$inferSelect
type AuthenticatedUser = import("@/server/auth/guards").AuthenticatedUser

/** §4.6 `AdminUserRow` — sorted, so a new key is a failing test and not a silent extra column. */
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

const UNAUTHENTICATED_BODY = {
  error: { code: "unauthenticated", message: "Sign in to continue.", category: "auth" },
} as const

const FORBIDDEN_BODY = {
  error: { code: "forbidden", message: "This area is for platform owners.", category: "auth" },
} as const

const METHOD_NOT_ALLOWED_BODY = {
  error: { code: "method_not_allowed", message: "Method not allowed.", category: "validation" },
} as const

const NOT_FOUND_BODY = {
  error: { code: "not_found", message: "No user was found with that id.", category: "not_found" },
} as const

const SELF_ACCESS_MESSAGE = "you cannot revoke your own access"
const LAST_OWNER_MESSAGE = "at least one owner must remain"
const DELETE_BLOCKED_MESSAGE = "this account created invitations and cannot be deleted"

/** The `[id]` route's own ceiling (`MAX_BODY_BYTES` there); over it `readTextBody` says `null`. */
const MAX_BODY_BYTES = 8_192
const MISSING_UUID = "00000000-0000-4000-8000-000000000000"
const INVITATION_CODE_RE = /^ZABER-[0-9A-Z]{4}-[0-9A-Z]{4}$/

let test: TestDb
let session: SessionModule
let admin: AdminModule
let audit: AuditModule
let invite: InvitationModule
let routes: Routes
let cookieName = "sz_session"

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000)
}

function cookieFor(uid: string, role: "user" | "owner" = "user"): string {
  const token = session.signSession({ uid, role, exp: Math.floor(Date.now() / 1000) + 3600 })
  return `${cookieName}=${token}`
}

function urlFor(path: string): string {
  return `http://localhost:3001/api/internal${path}`
}

function requestFor(path: string, cookie?: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  if (cookie) headers.set("cookie", cookie)
  return new Request(urlFor(path), { ...init, headers })
}

async function insertUser(input: {
  role?: "user" | "owner"
  status?: "active" | "disabled"
  createdAt?: Date
  invitationId?: string | null
} = {}): Promise<UserRow> {
  const id = randomUUID()
  const role = input.role ?? "user"
  const [row] = await test
    .insert(users)
    .values({
      id,
      googleSub: `admin-secret-sub-${role}-${id}`,
      email: `admin-${role}-${id}@example.com`,
      role,
      status: input.status ?? "active",
      invitationId: input.invitationId ?? null,
      createdAt: input.createdAt ?? new Date(),
    })
    .returning()
  return row
}

/** `api_request_logs.api_id` is nullable, so traffic can be seeded without the whole API chain. */
async function insertLogRows(userId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await test.insert(apiRequestLogs).values({
      userId,
      apiId: null,
      method: "GET",
      path: "/api/v1/admin-probe",
      statusCode: 200,
      durationMs: 9,
      createdAt: minutesAgo(i),
    })
  }
}

async function audits(action: string, subjectId?: string) {
  return test
    .select()
    .from(auditLogs)
    .where(
      subjectId === undefined
        ? eq(auditLogs.action, action)
        : and(eq(auditLogs.action, action), eq(auditLogs.subjectId, subjectId))
    )
}

async function userRow(id: string): Promise<UserRow | undefined> {
  const [row] = await test.select().from(users).where(eq(users.id, id)).limit(1)
  return row
}

let world: {
  owner: UserRow
  /** newest first — `listUsers` orders `createdAt desc`, so this is also the expected page order */
  plain: UserRow[]
  target: UserRow
  invited: UserRow
  invitation: { id: string; label: string; codeHash: string; plaintext: string }
}

async function buildWorld() {
  const owner = await insertUser({ role: "owner", createdAt: minutesAgo(10) })

  const plaintext = "ZABER-ABCD-EFGH"
  const codeHash = sha256(plaintext)
  const invitationId = randomUUID()
  await test.insert(invitations).values({
    id: invitationId,
    codeHash,
    label: "Beta cohort",
    maxUses: 5,
    createdBy: owner.id,
  })

  const plain: UserRow[] = []
  for (let i = 0; i < 5; i++) {
    // plain[0] is the newest seeded account and therefore the first row of the list.
    plain.push(
      await insertUser({ createdAt: minutesAgo(i + 1), invitationId: i === 4 ? invitationId : null })
    )
  }

  await test.insert(userProfiles).values({
    userId: plain[0].id,
    displayName: "Ada Target",
    pictureUrl: null,
    timezone: null,
  })
  await insertLogRows(plain[0].id, 3)

  return {
    owner,
    plain,
    target: plain[0],
    invited: plain[4],
    invitation: { id: invitationId, label: "Beta cohort", codeHash, plaintext },
  }
}

describe("admin routes", () => {
  beforeAll(async () => {
    let url: string
    try {
      url = inject(TEST_DB_URL_KEY)
    } catch {
      await startTestDb()
      await migrateTestDb()
      url = getTestDbUrl()
    }
    process.env.DATABASE_URL = url
    test = await getTestDb()
    session = await import("@/server/auth/session")
    admin = await import("@/server/admin/users")
    audit = await import("@/server/admin/audit")
    invite = await import("@/server/invitations/service")
    routes = {
      list: await import("@/app/api/internal/admin/users/route"),
      byId: await import("@/app/api/internal/admin/users/[id]/route"),
    }
    cookieName = session.SESSION_COOKIE
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    world = await buildWorld()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  /** `text` is read once and parsed locally, so the wire bytes stay comparable. */
  async function readJson(response: Response) {
    const text = await response.text()
    return { response, text, body: text === "" ? null : JSON.parse(text) }
  }

  async function list(path = "/admin/users", cookie?: string) {
    return readJson(
      await routes.list.GET(requestFor(path, cookie ?? cookieFor(world.owner.id, "owner")))
    )
  }

  function ownerSession() {
    return cookieFor(world.owner.id, "owner")
  }

  async function patch(id: string, payload: string, cookie?: string) {
    return readJson(
      await routes.byId.PATCH(
        requestFor(`/admin/users/${id}`, cookie ?? ownerSession(), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: payload,
        })
      )
    )
  }

  async function remove(id: string, cookie?: string) {
    return readJson(
      await routes.byId.DELETE(requestFor(`/admin/users/${id}`, cookie ?? ownerSession(), { method: "DELETE" }))
    )
  }

  function actor(row: UserRow): AuthenticatedUser {
    return { id: row.id, email: row.email, role: row.role === "owner" ? "owner" : "user" }
  }

  describe("route files", () => {
    it("export force-dynamic plus one handler per verb, and nothing else", () => {
      for (const route of [routes.list, routes.byId]) {
        expect(route.dynamic).toBe("force-dynamic")
        expect(Object.keys(route).sort()).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT", "dynamic"])
      }
    })
  })

  describe("session and role guards", () => {
    it("401 unauthenticated with no cookie on the list, the patch and the delete", async () => {
      const cases = [
        [await routes.list.GET(requestFor("/admin/users")), "GET list"],
        [
          await routes.byId.PATCH(
            requestFor(`/admin/users/${world.target.id}`, undefined, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "disabled" }),
            })
          ),
          "PATCH",
        ],
        [await routes.byId.DELETE(requestFor(`/admin/users/${world.target.id}`, undefined, { method: "DELETE" })), "DELETE"],
      ] as const
      for (const [response, label] of cases) {
        expect(response.status, label).toBe(401)
        expect(await response.json(), label).toEqual(UNAUTHENTICATED_BODY)
      }
    })

    it("a valid non-owner session is 403 forbidden on every admin verb", async () => {
      const intruder = cookieFor(world.target.id)
      const cases = [
        [await routes.list.GET(requestFor("/admin/users", intruder)), "GET list"],
        [
          await routes.byId.PATCH(
            requestFor(`/admin/users/${world.plain[1].id}`, intruder, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "disabled" }),
            })
          ),
          "PATCH",
        ],
        [
          await routes.byId.DELETE(requestFor(`/admin/users/${world.plain[1].id}`, intruder, { method: "DELETE" })),
          "DELETE",
        ],
      ] as const
      for (const [response, label] of cases) {
        expect(response.status, label).toBe(403)
        expect(await response.json(), label).toEqual(FORBIDDEN_BODY)
      }
    })

    it("a 403 is not an audit event here, and the guarded row is untouched", async () => {
      await routes.list.GET(requestFor("/admin/users", cookieFor(world.target.id)))
      await patch(world.plain[1].id, JSON.stringify({ status: "disabled" }), cookieFor(world.target.id))
      expect(await audits("user.disable")).toEqual([])
      const untouched = await userRow(world.plain[1].id)
      expect(untouched?.status).toBe("active")
      expect(untouched?.role).toBe("user")
    })

    it("a role that only the cookie claims is the DB role: no admin access", async () => {
      // Signed as `owner`, but `users.role` says `user` — the DB wins (`security.md` §3 item 5).
      const escalated = cookieFor(world.target.id, "owner")
      const response = await routes.list.GET(requestFor("/admin/users", escalated))
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(FORBIDDEN_BODY)
    })

    it("a disabled owner's session is 401, not 403", async () => {
      await test.update(users).set({ status: "disabled" }).where(eq(users.id, world.owner.id))
      const response = await routes.list.GET(requestFor("/admin/users", ownerSession()))
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual(UNAUTHENTICATED_BODY)
    })
  })

  describe("GET /api/internal/admin/users", () => {
    it("success is exactly { data: { rows, total, page, perPage } }", async () => {
      const { body } = await list()
      expect(Object.keys(body).sort()).toEqual(["data"])
      expect(Object.keys(body.data).sort()).toEqual(["page", "perPage", "rows", "total"])
      expect(body.data.total).toBe(6)
      expect(body.data).toMatchObject({ page: 1, perPage: 50 })
    })

    it("a row is the §4.6 AdminUserRow: ten keys, no googleSub, no code, no hash", async () => {
      const response = await routes.list.GET(requestFor("/admin/users", ownerSession()))
      const text = await response.text()
      const body = JSON.parse(text)

      for (const row of body.data.rows) expect(Object.keys(row).sort()).toEqual(ADMIN_ROW_KEYS)

      // Explicit projection, checked on the wire rather than in the type.
      for (const needle of [
        "googleSub",
        "google_sub",
        "updatedAt",
        "updated_at",
        "codeHash",
        "code_hash",
        "Ada Target",
        world.invitation.plaintext,
        world.invitation.codeHash,
        `admin-secret-sub-owner-${world.owner.id}`,
        `admin-secret-sub-user-${world.target.id}`,
      ]) {
        expect(text, needle).not.toContain(needle)
      }
    })

    it("the joined invite memo and per-user counters ride along, unscoped counts do not", async () => {
      const { body } = await list()
      const target = body.data.rows.find((row: { id: string }) => row.id === world.target.id)
      const invited = body.data.rows.find((row: { id: string }) => row.id === world.invited.id)

      expect(target).toMatchObject({
        apiCount: 0,
        invitationId: null,
        invitationLabel: null,
        lastLoginAt: null,
        requestTotal: 3,
        role: "user",
        status: "active",
      })
      expect(invited).toMatchObject({ invitationId: world.invitation.id, invitationLabel: "Beta cohort" })
    })

    it("rows are newest first, so paging slices are predictable", async () => {
      const { body } = await list()
      const ids = body.data.rows.map((row: { id: string }) => row.id)
      expect(ids).toEqual([...world.plain.map((row) => row.id), world.owner.id].slice(0, 6))
    })

    it("page and per_page slice, and a page past the end is an empty array not an error", async () => {
      const page1 = await list("/admin/users?page=1&per_page=2")
      expect(page1.body.data.rows.map((row: { id: string }) => row.id)).toEqual([
        world.plain[0].id,
        world.plain[1].id,
      ])
      expect(page1.body.data).toMatchObject({ page: 1, perPage: 2, total: 6 })

      const page3 = await list("/admin/users?page=3&per_page=2")
      expect(page3.body.data.rows.map((row: { id: string }) => row.id)).toEqual([
        world.plain[4].id,
        world.owner.id,
      ])

      const past = await list("/admin/users?page=4&per_page=2")
      expect(past.body.data).toEqual({ rows: [], total: 6, page: 4, perPage: 2 })
    })

    it("out-of-range and non-numeric paging params are 400 with the field named", async () => {
      for (const [query, field] of [
        ["page=0", "page"],
        ["page=-1", "page"],
        ["page=abc", "page"],
        ["page=1.5", "page"],
        ["per_page=0", "per_page"],
        ["per_page=201", "per_page"],
        ["per_page=-3", "per_page"],
        ["per_page=all", "per_page"],
      ] as [string, string][]) {
        const { response, body } = await list(`/admin/users?${query}`)
        expect(response.status, query).toBe(400)
        expect(body.error.code, query).toBe("validation_failed")
        expect(body.error.category, query).toBe("validation")
        expect(Object.keys(body.error.fields), query).toEqual([field])
        expect("data" in body, query).toBe(false)
      }
    })

    it("an unknown query key is ignored, not echoed back as a filter", async () => {
      const wide = await list("/admin/users?limit=1&offset=1&search=Ada")
      expect(wide.response.status).toBe(200)
      expect(wide.body.data.rows).toHaveLength(6)
    })

    it("POST, PUT, PATCH and DELETE on the collection answer 405 with Allow: GET", () => {
      for (const handler of [routes.list.POST, routes.list.PUT, routes.list.PATCH, routes.list.DELETE]) {
        const response = handler()
        expect(response.status).toBe(405)
        expect(response.headers.get("allow")).toBe("GET")
      }
    })
  })

  describe("PATCH /api/internal/admin/users/{id}", () => {
    it("a disable returns the refreshed row, changes the column and audits the actor", async () => {
      const { response, body } = await patch(world.target.id, JSON.stringify({ status: "disabled" }))
      expect(response.status).toBe(200)
      expect(Object.keys(body).sort()).toEqual(["data"])
      expect(Object.keys(body.data).sort()).toEqual(ADMIN_ROW_KEYS)
      expect(body.data).toMatchObject({ id: world.target.id, status: "disabled" })
      expect((await userRow(world.target.id))?.status).toBe("disabled")

      const rows = await audits("user.disable", world.target.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].actorId).toBe(world.owner.id)
      expect(rows[0].subjectType).toBe("user")
      expect(rows[0].detail).toEqual({ from: "active", to: "disabled" })
    })

    it("the disable takes effect on the target's very next request", async () => {
      await patch(world.target.id, JSON.stringify({ status: "disabled" }))
      const response = await routes.list.GET(requestFor("/admin/users", cookieFor(world.target.id)))
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual(UNAUTHENTICATED_BODY)
    })

    it("a promote and a demote audit as user.promote and user.demote", async () => {
      const promoted = await patch(world.plain[1].id, JSON.stringify({ role: "owner" }))
      expect(promoted.body.data).toMatchObject({ id: world.plain[1].id, role: "owner" })
      const promoteRows = await audits("user.promote", world.plain[1].id)
      expect(promoteRows).toHaveLength(1)
      expect(promoteRows[0].actorId).toBe(world.owner.id)
      expect(promoteRows[0].detail).toEqual({ from: "user", to: "owner" })

      const demoted = await patch(world.plain[1].id, JSON.stringify({ role: "user" }))
      expect(demoted.body.data).toMatchObject({ role: "user" })
      const demoteRows = await audits("user.demote", world.plain[1].id)
      expect(demoteRows).toHaveLength(1)
      expect(demoteRows[0].detail).toEqual({ from: "owner", to: "user" })
    })

    it("an already-satisfied request is an idempotent 200 that writes no audit row", async () => {
      await patch(world.plain[2].id, JSON.stringify({ status: "disabled" }))
      const again = await patch(world.plain[2].id, JSON.stringify({ status: "disabled" }))
      expect(again.response.status).toBe(200)
      expect(again.body.data).toMatchObject({ status: "disabled" })
      expect(await audits("user.disable", world.plain[2].id)).toHaveLength(1)
    })

    it("an owner may not revoke their own access: 400 under the verb's field, no audit row", async () => {
      const disable = await patch(world.owner.id, JSON.stringify({ status: "disabled" }))
      expect(disable.response.status).toBe(400)
      expect(disable.body.error.code).toBe("validation_failed")
      expect(disable.body.error.message).toBe(SELF_ACCESS_MESSAGE)
      expect(Object.keys(disable.body.error.fields)).toEqual(["id"])
      expect(await audits("user.disable", world.owner.id)).toEqual([])

      const demote = await patch(world.owner.id, JSON.stringify({ role: "user" }))
      expect(demote.response.status).toBe(400)
      expect(Object.keys(demote.body.error.fields)).toEqual(["role"])
      expect((await userRow(world.owner.id))?.role).toBe("owner")
    })

    it("the last-owner floor counts only owners who could still sign in", async () => {
      // `ownerRoute` guarantees a routed actor is an ACTIVE DB owner, so `countActiveOwners()` is
      // ≥ 1 for any routed demote; the census is what a direct/service caller is measured against.
      const ghost = { id: randomUUID(), email: "ghost@example.com", role: "owner" as const }
      const result = await admin.demoteUser(world.owner.id, ghost)
      expect(result).toEqual({
        error: {
          code: "validation_failed",
          message: LAST_OWNER_MESSAGE,
          category: "validation",
          fields: { role: LAST_OWNER_MESSAGE },
        },
      })
      expect((await userRow(world.owner.id))?.role).toBe("owner")
      expect(await audits("user.demote", world.owner.id)).toEqual([])

      // A `disabled` owner cannot administer anything, so it must not satisfy the floor either:
      // with one active and one disabled owner left, demoting the active one is still refused.
      const sleeping = await insertUser({ role: "owner", status: "disabled", createdAt: minutesAgo(20) })
      const stillRefused = await admin.demoteUser(world.owner.id, {
        id: sleeping.id,
        email: sleeping.email,
        role: "owner",
      })
      expect(stillRefused).toMatchObject({ error: { message: LAST_OWNER_MESSAGE } })

      // Once a second ACTIVE owner exists, the same demote is allowed.
      const colleague = await insertUser({ role: "owner", createdAt: minutesAgo(21) })
      const allowed = await admin.demoteUser(world.owner.id, actor(colleague))
      expect("data" in allowed).toBe(true)
      expect((await userRow(world.owner.id))?.role).toBe("user")
    })

    it("a secret-shaped extra key in the body is stripped, not stored or audited", async () => {
      const { response, body } = await patch(
        world.plain[3].id,
        JSON.stringify({ status: "disabled", code: world.invitation.plaintext, codeHash: world.invitation.codeHash })
      )
      expect(response.status).toBe(200)
      expect(body.data).toMatchObject({ status: "disabled" })
      const rows = await audits("user.disable", world.plain[3].id)
      expect(rows).toHaveLength(1)
      expect(Object.keys(rows[0].detail as Record<string, unknown>).sort()).toEqual(["from", "to"])
      expect(JSON.stringify(rows[0].detail)).not.toContain("ZABER-")
    })

    it("a malformed body is 400 with fields, and nothing is written", async () => {
      const cases = [
        ["not json at all", "body"],
        [JSON.stringify({}), "body"],
        [JSON.stringify({ status: "disabled", role: "owner" }), "body"],
        [JSON.stringify({ status: "bogus" }), "status"],
        [JSON.stringify({ role: "admin" }), "role"],
        [JSON.stringify("a string"), "body"],
        [JSON.stringify({ note: "x".repeat(MAX_BODY_BYTES) }), "body"],
      ] as [string, string][]
      for (const [payload, field] of cases) {
        const { response, body } = await patch(world.plain[1].id, payload)
        expect(response.status, payload.slice(0, 40)).toBe(400)
        expect(body.error.code, payload.slice(0, 40)).toBe("validation_failed")
        expect(Object.keys(body.error.fields), payload.slice(0, 40)).toEqual([field])
      }
      expect(await audits("user.disable", world.plain[1].id)).toEqual([])
      expect((await userRow(world.plain[1].id))?.status).toBe("active")
    })

    it("a non-uuid and a missing uuid answer the identical 404, so the id space is not readable", async () => {
      const notAUuid = await patch("zzz-not-a-uuid", JSON.stringify({ status: "disabled" }))
      const missing = await patch(MISSING_UUID, JSON.stringify({ status: "disabled" }))
      expect(notAUuid.response.status).toBe(404)
      expect(missing.response.status).toBe(404)
      expect(notAUuid.text).toEqual(missing.text)
      expect(notAUuid.body.error).toEqual(NOT_FOUND_BODY.error)
      expect(await audits("user.disable")).toEqual([])
      expect(await audits("user.delete")).toEqual([])
    })

    it("POST and PUT on one user answer 405 with Allow: GET, PATCH, DELETE", async () => {
      for (const handler of [routes.byId.POST, routes.byId.PUT]) {
        const response = handler()
        expect(response.status).toBe(405)
        expect(response.headers.get("allow")).toBe("GET, PATCH, DELETE")
        expect(await response.json()).toEqual(METHOD_NOT_ALLOWED_BODY)
      }
    })
  })

  describe("DELETE /api/internal/admin/users/{id}", () => {
    it("removes the account and its dependants, keeps the audit trail with a null-safe actor", async () => {
      await test.insert(googleConnections).values({
        id: randomUUID(),
        userId: world.plain[1].id,
        googleEmail: "cascade@example.com",
        refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
        scope: "openid",
      })
      await insertLogRows(world.plain[1].id, 2)

      const { response, body } = await remove(world.plain[1].id)
      expect(response.status).toBe(200)
      expect(body).toEqual({ data: { id: world.plain[1].id } })
      expect(await userRow(world.plain[1].id)).toBeUndefined()

      const connections = await test
        .select()
        .from(googleConnections)
        .where(eq(googleConnections.userId, world.plain[1].id))
      expect(connections).toHaveLength(0)
      const logs = await test.select().from(apiRequestLogs).where(eq(apiRequestLogs.userId, world.plain[1].id))
      expect(logs).toHaveLength(0)

      // `audit_logs.actor_id` is SET NULL: the delete itself is recorded against the surviving owner.
      const rows = await audits("user.delete", world.plain[1].id)
      expect(rows).toHaveLength(1)
      expect(rows[0].actorId).toBe(world.owner.id)
      expect(rows[0].detail).toEqual({ from: "active", to: "deleted" })
    })

    it("refuses to delete the actor's own account and an account that minted codes", async () => {
      const self = await remove(world.owner.id)
      expect(self.response.status).toBe(400)
      expect(self.body.error.message).toBe(SELF_ACCESS_MESSAGE)
      expect(Object.keys(self.body.error.fields)).toEqual(["id"])

      const minter = await insertUser({ createdAt: minutesAgo(30) })
      await test.insert(invitations).values({
        id: randomUUID(),
        codeHash: sha256("ZABER-CODE-SECO"),
        label: null,
        maxUses: 1,
        createdBy: minter.id,
      })
      const blocked = await remove(minter.id)
      expect(blocked.response.status).toBe(400)
      expect(blocked.body.error.message).toBe(DELETE_BLOCKED_MESSAGE)
      expect(Object.keys(blocked.body.error.fields)).toEqual(["id"])
      expect(await userRow(minter.id)).toBeDefined()
      expect(await audits("user.delete", minter.id)).toEqual([])
    })

    it("a DELETE ignores any body and answers the identical 404 for every unreadable id", async () => {
      const notAUuid = await remove("nope")
      const missing = await remove(MISSING_UUID)
      expect(notAUuid.response.status).toBe(404)
      expect(notAUuid.text).toEqual(missing.text)
      expect(notAUuid.text).toEqual(JSON.stringify(NOT_FOUND_BODY))

      // A body on a DELETE is not read, so it cannot change the outcome (`§1.3`).
      const withBody = await routes.byId.DELETE(
        requestFor(`/admin/users/${world.plain[1].id}`, ownerSession(), {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "active" }),
        })
      )
      expect(withBody.status).toBe(200)
      expect(await userRow(world.plain[1].id)).toBeUndefined()
    })
  })

  describe("invitations (§4.5, service surface)", () => {
    it("create returns each plaintext exactly once and stores only its hash", async () => {
      const created = await invite.createInvitations({ count: 2, label: "Beta cohort", maxUses: 3 }, world.owner.id)
      if (!("data" in created)) throw new Error("invitation creation failed")
      const payload = created.data
      expect(Object.keys(payload).sort()).toEqual(["codes", "invitations", "plaintext"])
      expect(payload.codes).toHaveLength(2)
      expect(payload.plaintext).toEqual(payload.codes)
      for (const code of payload.codes) expect(code).toMatch(INVITATION_CODE_RE)

      for (const row of payload.invitations) {
        expect(Object.keys(row).sort()).toEqual([
          "createdAt",
          "createdBy",
          "expiresAt",
          "id",
          "label",
          "maxUses",
          "revokedAt",
          "uses",
        ])
        expect(row.createdBy).toBe(world.owner.id)
      }

      const wireText = JSON.stringify(payload)
      const ids = payload.invitations.map((row) => row.id)
      const stored = await test.select().from(invitations).where(inArray(invitations.id, ids))
      expect(stored).toHaveLength(2)
      const hashes = stored.map((row) => row.codeHash)
      for (const code of payload.codes) expect(hashes).toContain(sha256(code))
      expect(wireText).not.toContain("codeHash")
      for (const hash of hashes) expect(wireText).not.toContain(hash)

      const rows = await audits("invitation.create")
      expect(rows).toHaveLength(1)
      expect(rows[0].actorId).toBe(world.owner.id)
      expect(JSON.stringify(rows[0].detail)).not.toContain("ZABER-")
      for (const hash of hashes) expect(JSON.stringify(rows[0].detail)).not.toContain(hash)
    })

    it("the owner-facing list never repeats a plaintext code", async () => {
      const created = await invite.createInvitations({ count: 1 }, world.owner.id)
      if (!("data" in created)) throw new Error("invitation creation failed")
      const code = created.data.codes[0]

      const listed = await invite.listInvitationsForOwner()
      expect("data" in listed).toBe(true)
      const text = JSON.stringify(listed)
      expect(text).not.toContain(code)
      expect(text).not.toContain(sha256(code))
      expect(text).not.toContain("codeHash")
    })

    it("revoking is idempotent and keeps the first revoked_at", async () => {
      const created = await invite.createInvitations({ count: 1, label: "Once only" }, world.owner.id)
      if (!("data" in created)) throw new Error("invitation creation failed")
      const id = created.data.invitations[0].id

      const first = await invite.revokeInvitation(id, world.owner.id)
      expect(first).toEqual({ ok: true, data: { id } })
      const afterFirst = await test.select().from(invitations).where(eq(invitations.id, id))
      expect(afterFirst[0].revokedAt).not.toBeNull()

      const second = await invite.revokeInvitation(id, world.owner.id)
      expect(second).toEqual({ ok: true, data: { id } })
      const afterSecond = await test.select().from(invitations).where(eq(invitations.id, id))
      expect(afterSecond[0].revokedAt).toEqual(afterFirst[0].revokedAt)

      expect(await audits("invitation.revoke", id)).toHaveLength(2)
    })

    it("a non-owner may not revoke, and that refusal IS audited", async () => {
      const created = await invite.createInvitations({ count: 1 }, world.owner.id)
      if (!("data" in created)) throw new Error("invitation creation failed")
      const id = created.data.invitations[0].id

      const refused = await invite.revokeInvitation(id, world.target.id)
      expect(refused).toEqual({
        error: { code: "forbidden", message: "You are not allowed to do that.", category: "auth" },
      })
      const stored = await test.select().from(invitations).where(eq(invitations.id, id))
      expect(stored[0].revokedAt).toBeNull()

      const denied = await audits("invitation.revoke")
      expect(denied).toHaveLength(1)
      expect(denied[0].actorId).toBe(world.target.id)
      expect(denied[0].detail).toEqual({ outcome: "denied" })
    })

    it("an invitation id that is not a uuid is a validation failure, not a lookup", async () => {
      const result = await invite.revokeInvitation("not-a-uuid", world.owner.id)
      expect(result).toMatchObject({
        error: { code: "validation_failed", category: "validation", fields: { id: "must be a uuid" } },
      })
    })
  })

  describe("audit scrubbing (src/server/admin/audit.ts)", () => {
    it("secret-NAMED keys are dropped and secret-SHAPED values are replaced", async () => {
      const code = "ZABER-QRST-UVWX"
      const digest = sha256(code)
      const blob = "T".repeat(48)
      await audit.recordAudit({
        actorId: world.owner.id,
        action: "settings.update",
        subjectType: "platform",
        detail: {
          outcome: "granted",
          ZABER: code,
          digest,
          blob,
          code,
          codeHash: digest,
          refreshToken: blob,
          nested: { api_key: digest, visible: "kept" },
        },
      })

      const rows = await audits("settings.update")
      expect(rows).toHaveLength(1)
      const detail = rows[0].detail as Record<string, unknown>
      const nested = detail.nested as Record<string, unknown>

      expect(detail.outcome).toBe("granted")
      expect(nested.visible).toBe("kept")
      expect(Object.keys(detail)).not.toContain("code")
      expect(Object.keys(detail)).not.toContain("codeHash")
      expect(Object.keys(detail)).not.toContain("refreshToken")
      expect(Object.keys(nested)).not.toContain("api_key")
      expect(detail.ZABER).toBe("[redacted]")
      expect(detail.digest).toBe("[redacted]")
      expect(detail.blob).toBe("[redacted]")

      const text = JSON.stringify(rows[0])
      expect(text).not.toContain("ZABER-")
      expect(text).not.toContain(digest)
      expect(text).not.toContain(blob)
    })

    it("an actor that no longer exists still leaves a row with actor_id set null", async () => {
      const doomed = await insertUser({ createdAt: minutesAgo(1) })
      await audit.recordAudit({ actorId: doomed.id, action: "user.disable", subjectId: doomed.id })
      await remove(doomed.id)

      const rows = await audits("user.disable", doomed.id)
      expect(rows.length).toBeGreaterThan(0)
      const remaining = await test.select().from(auditLogs).where(eq(auditLogs.subjectId, doomed.id))
      expect(remaining.some((row) => row.actorId === null)).toBe(true)
    })
  })

  describe("service-level projection", () => {
    it("listUsers re-checks RBAC even when it is called without a route", async () => {
      const page = await admin.listUsers(actor(world.target))
      expect(page).toEqual({
        error: { code: "forbidden", message: "You are not allowed to do that.", category: "auth" },
      })
      const allowed = await admin.listUsers(actor(world.owner))
      expect("data" in allowed).toBe(true)
    })

    it("the exported status enum is the only thing a verb accepts", async () => {
      const bogus = "deleted" as Parameters<typeof admin.setUserStatus>[1]
      const rejected = await admin.setUserStatus(world.target.id, bogus, actor(world.owner))
      expect(rejected).toEqual({
        error: {
          code: "validation_failed",
          message: "The status is not valid.",
          category: "validation",
          fields: { status: "must be 'active' or 'disabled'" },
        },
      })
      expect(await userRow(world.target.id)).toMatchObject({ status: "active" })
    })

    it("the service's AdminUserRow has no googleSub key at all", async () => {
      const result = await admin.setUserStatus(world.target.id, "disabled", actor(world.owner))
      if (!("data" in result)) throw new Error("status change failed")
      expect(Object.keys(result.data).sort()).toEqual(ADMIN_ROW_KEYS)
      expect(result.data).not.toHaveProperty("googleSub")
      expect(result.data.id).toBe(world.target.id)
    })
  })
})
