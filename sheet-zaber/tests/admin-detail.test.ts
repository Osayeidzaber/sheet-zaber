import { randomUUID } from "node:crypto"

import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { generateApiKey, sha256 } from "@/lib/crypto"
import {
  apiKeys,
  apiRequestLogs,
  googleConnections,
  invitations,
  registeredSpreadsheets,
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
 * The owner-only READ surface over one account — `GET /api/internal/admin/users/{id}` and
 * `GET /api/internal/admin/users/{id}/keys` — driven through the real route files against the
 * committed embedded PostgreSQL 16. Every claim here is a wire claim: the exact key set, the exact
 * status per actor, the byte-for-byte shape of a `not_found`, and what must never appear in a
 * serialized body.
 *
 * The two claims worth naming before the code says them:
 *   - NO SECRET ON THE WIRE. `api_keys.key_hash` is secret-equivalent and the `sz_live_…` plaintext
 *     was never stored, so the key list is scanned for a 64-hex digest and for every planted hash and
 *     plaintext — not merely for a declared key name. The scan would catch a projection that grew a
 *     `keyHash`, and it is only meaningful because the planted rows DO carry those digests in the
 *     database, which is asserted first.
 *   - ONE MISS, ONE BODY. A non-uuid, an absent account and a path that addresses no user answer the
 *     identical 404 — byte-identical to the one the already-shipped PATCH/DELETE verbs answer
 *     (`src/server/admin/users.ts`).
 *
 * `requestsToday` is pinned to the UTC day boundary rather than the host clock: rows are planted at
 * `midnight`, `midnight + …` and `midnight − …`, so the assertion holds whether the suite runs at
 * 00:00 or 23:59 local, and the service's injected clock proves the floor is the only thing moving.
 */

type SessionModule = typeof import("@/server/auth/session")
type DetailModule = typeof import("@/server/admin/user-detail")
type AdminUserDetail = import("@/server/admin/user-detail").AdminUserDetail
type AdminUserKeyPage = import("@/server/admin/user-detail").AdminUserKeyPage
type AdminUserKeyRow = import("@/server/admin/user-detail").AdminUserKeyRow
type Routes = {
  byId: typeof import("@/app/api/internal/admin/users/[id]/route")
  keys: typeof import("@/app/api/internal/admin/users/[id]/keys/route")
}
type UserRow = typeof users.$inferSelect
type AuthenticatedUser = import("@/server/auth/guards").AuthenticatedUser
type DetailBody = { data?: AdminUserDetail; error?: { code: string; message: string; category: string } }
type KeysBody = { data?: AdminUserKeyPage; error?: { code: string; message: string; category: string } }
type ErrorBody = { error: { code: string; message: string; category: string } }

/** The §4.6 admin row: ten keys, sorted, so a new column is a failing test and not a silent leak. */
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

/** … plus exactly the three counters this surface adds. */
const DETAIL_KEYS = [...ADMIN_ROW_KEYS, "activeKeyCount", "requestsToday", "spreadsheetCount"].sort()

/** The admin key row: what the owner may see of a credential, and nothing more. */
const KEY_ROW_KEYS = [
  "allowedApiIds",
  "createdAt",
  "expiresAt",
  "id",
  "lastUsedAt",
  "name",
  "preview",
  "requestCount",
  "revokedAt",
  "scopes",
]

const NOT_FOUND_BODY = {
  error: { code: "not_found", message: "No user was found with that id.", category: "not_found" },
} as const
const UNAUTHENTICATED_BODY = {
  error: { code: "unauthenticated", message: "Sign in to continue.", category: "auth" },
} as const
const FORBIDDEN_BODY = {
  error: { code: "forbidden", message: "This area is for platform owners.", category: "auth" },
} as const
const SERVICE_FORBIDDEN_BODY = {
  error: { code: "forbidden", message: "You are not allowed to do that.", category: "auth" },
} as const

const MISSING_UUID = "00000000-0000-4000-8000-000000000000"
const NOT_A_UUID = "zzz-not-a-uuid"
/** 64 consecutive hex characters: the shape of every SHA-256 digest this platform stores. */
const DIGEST_RE = /[0-9a-f]{64}/i
const PREVIEW_RE = /^sz_live_[0-9a-f]{4}…[0-9a-f]{4}$/

const MS_PER_DAY = 86_400_000

let test: TestDb
let session: SessionModule
let detail: DetailModule
let routes: Routes
let cookieName = "sz_session"

function utcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function cookieFor(uid: string, role: "user" | "owner" = "user"): string {
  return `${cookieName}=${session.signSession({
    uid,
    role,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`
}

function requestFor(path: string, cookie?: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  if (cookie) headers.set("cookie", cookie)
  return new Request(`http://localhost:3001/api/internal${path}`, { ...init, headers })
}

async function insertUser(
  input: { role?: "user" | "owner"; invitationId?: string | null } = {}
): Promise<UserRow> {
  const id = randomUUID()
  const [row] = await test
    .insert(users)
    .values({
      id,
      googleSub: `detail-secret-sub-${id}`,
      email: `detail-${input.role ?? "user"}-${id}@example.com`,
      role: input.role ?? "user",
      status: "active",
      invitationId: input.invitationId ?? null,
    })
    .returning()
  return row
}

/** A real credential: only the digest is stored, so the wire scan has something to exclude. */
async function insertKey(
  userId: string,
  over: Partial<{
    name: string
    expiresAt: Date | null
    revokedAt: Date | null
    createdAt: Date
  }> = {}
): Promise<{ id: string; plaintext: string; hash: string; preview: string }> {
  const key = generateApiKey()
  const id = randomUUID()
  await test.insert(apiKeys).values({
    id,
    userId,
    name: over.name ?? `key-${id.slice(0, 8)}`,
    keyHash: key.hash,
    keyPreview: key.preview,
    scopes: ["read", "write"],
    allowedApiIds: null,
    expiresAt: over.expiresAt ?? null,
    revokedAt: over.revokedAt ?? null,
    createdAt: over.createdAt ?? new Date(),
  })
  return { id, plaintext: key.plaintext, hash: key.hash, preview: key.preview }
}

async function insertSpreadsheet(userId: string, status: "active" | "inaccessible"): Promise<string> {
  const id = randomUUID()
  const [connection] = await test
    .insert(googleConnections)
    .values({
      id: randomUUID(),
      userId,
      googleEmail: `sheets-${id}@example.com`,
      refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
      scope: "spreadsheets",
    })
    .returning()
  await test.insert(registeredSpreadsheets).values({
    id,
    userId,
    connectionId: connection.id,
    googleSheetId: `sheet-${id}`,
    title: `Sheet ${id}`,
    tabs: [],
    status,
  })
  return id
}

async function insertLog(input: {
  userId: string | null
  apiKeyId?: string | null
  createdAt: Date
}): Promise<void> {
  await test.insert(apiRequestLogs).values({
    userId: input.userId,
    apiId: null,
    apiKeyId: input.apiKeyId ?? null,
    method: "GET",
    path: "/api/v1/detail-probe",
    statusCode: 200,
    durationMs: 7,
    createdAt: input.createdAt,
  })
}

async function readJson<T>(response: Response): Promise<{ status: number; text: string; body: T }> {
  const text = await response.text()
  return { status: response.status, text, body: JSON.parse(text) as T }
}

async function getDetail(path: string, cookie?: string) {
  return readJson<DetailBody>(await routes.byId.GET(requestFor(path, cookie ?? ownerCookie())))
}

async function getKeys(path: string, cookie?: string) {
  return readJson<KeysBody>(await routes.keys.GET(requestFor(path, cookie ?? ownerCookie())))
}

/** The secret scan every payload in this file goes through. */
function expectNoSecrets(text: string, secrets: readonly string[]) {
  expect(DIGEST_RE.test(text), text).toBe(false)
  for (const needle of [
    "keyHash",
    "key_hash",
    "codeHash",
    "code_hash",
    "plaintext",
    "googleSub",
    "google_sub",
    "displayName",
    "display_name",
  ]) {
    expect(text, needle).not.toContain(needle)
  }
  for (const secret of secrets) expect(text, secret).not.toContain(secret)
}

let world: {
  owner: UserRow
  target: UserRow
  other: UserRow
  invitation: { id: string; codeHash: string; plaintext: string; label: string }
  midnight: Date
  /** the target's six keys, newest first by construction */
  keys: { id: string; plaintext: string; hash: string; preview: string }[]
  /** the owner's own key: must never appear in the target's list */
  ownerKey: { id: string; plaintext: string; hash: string; preview: string }
}

function ownerCookie() {
  return cookieFor(world.owner.id, "owner")
}

async function buildWorld() {
  const ownerRow = await insertUser({ role: "owner" })

  const plaintext = "ZABER-ABCD-EFGH"
  const codeHash = sha256(plaintext)
  const label = "Beta cohort"
  const invitationId = randomUUID()
  await test.insert(invitations).values({
    id: invitationId,
    codeHash,
    label,
    maxUses: 5,
    createdBy: ownerRow.id,
  })

  const target = await insertUser({ invitationId })
  const other = await insertUser()

  const midnight = utcMidnight()
  const yesterday = new Date(midnight.getTime() - MS_PER_DAY)

  // requestsToday: three on or after the UTC floor, two strictly before it, and two that belong to
  // somebody else — one of them to no account at all.
  await insertLog({ userId: target.id, createdAt: midnight })
  await insertLog({ userId: target.id, createdAt: new Date(midnight.getTime() + 1_000) })
  await insertLog({ userId: target.id, createdAt: new Date(midnight.getTime() + 3_600_000) })
  await insertLog({ userId: target.id, createdAt: new Date(midnight.getTime() - 1) })
  await insertLog({ userId: target.id, createdAt: yesterday })
  await insertLog({ userId: other.id, createdAt: midnight })
  await insertLog({ userId: null, createdAt: midnight })

  await insertSpreadsheet(target.id, "active")
  await insertSpreadsheet(target.id, "inaccessible")
  await insertSpreadsheet(other.id, "active")

  const createdAt = (minutes: number) => new Date(midnight.getTime() + minutes * 60_000)
  const keys = [
    await insertKey(target.id, { name: "live", createdAt: createdAt(5) }),
    await insertKey(target.id, {
      name: "future-expiry",
      expiresAt: new Date(Date.now() + 30 * MS_PER_DAY),
      createdAt: createdAt(4),
    }),
    await insertKey(target.id, {
      name: "revoked",
      revokedAt: createdAt(6),
      createdAt: createdAt(3),
    }),
    await insertKey(target.id, {
      name: "expired-unrevoked",
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: createdAt(2),
    }),
    await insertKey(target.id, { name: "no-traffic", createdAt: createdAt(1) }),
    // oldest of the six, so the expected newest-first order is unambiguous
    await insertKey(target.id, { name: "oldest", createdAt: new Date(midnight.getTime() - MS_PER_DAY) }),
  ]
  const ownerKey = await insertKey(ownerRow.id, { name: "owner-own" })

  // requestCount is per credential: a revoked key keeps counting the traffic made with it, and a row
  // with a NULL `api_key_id` belongs to no credential at all. All of it is dated YESTERDAY, so the
  // day-boundary assertions above are about the boundary and nothing else.
  for (let i = 0; i < 3; i++) {
    await insertLog({
      userId: target.id,
      apiKeyId: keys[0].id,
      createdAt: new Date(yesterday.getTime() + i),
    })
  }
  await insertLog({ userId: other.id, apiKeyId: keys[2].id, createdAt: yesterday })
  await insertLog({ userId: target.id, apiKeyId: keys[2].id, createdAt: yesterday })
  await insertLog({ userId: target.id, apiKeyId: ownerKey.id, createdAt: yesterday })
  await insertLog({ userId: target.id, apiKeyId: null, createdAt: yesterday })

  return {
    owner: ownerRow,
    target,
    other,
    invitation: { id: invitationId, codeHash, plaintext, label },
    midnight,
    keys,
    ownerKey,
  }
}

describe("admin user detail + admin key list", () => {
  beforeAll(async () => {
    let url: string
    try {
      url = inject(TEST_DB_URL_KEY)
    } catch {
      await startTestDb()
      await migrateTestDb()
      url = getTestDbUrl()
    }
    // The lazy pool resolves `env.DATABASE_URL` on the first query, so the URL is published before
    // the modules under test are imported.
    process.env.DATABASE_URL = url
    test = await getTestDb()
    session = await import("@/server/auth/session")
    detail = await import("@/server/admin/user-detail")
    routes = {
      byId: await import("@/app/api/internal/admin/users/[id]/route"),
      keys: await import("@/app/api/internal/admin/users/[id]/keys/route"),
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

  function actor(row: UserRow): AuthenticatedUser {
    return { id: row.id, email: row.email, role: row.role === "owner" ? "owner" : "user" }
  }

  /** Every plaintext and digest planted for this file's world. */
  function secrets() {
    return [
      world.invitation.plaintext,
      world.invitation.codeHash,
      ...world.keys.flatMap((key) => [key.plaintext, key.hash]),
      world.ownerKey.plaintext,
      world.ownerKey.hash,
    ]
  }

  describe("route files", () => {
    it("the keys route is GET-only and the detail route keeps PATCH/DELETE intact", async () => {
      expect(routes.keys.dynamic).toBe("force-dynamic")
      for (const route of [routes.byId, routes.keys]) {
        expect(Object.keys(route).sort()).toEqual([
          "DELETE",
          "GET",
          "PATCH",
          "POST",
          "PUT",
          "dynamic",
        ])
      }
      for (const handler of [
        routes.keys.POST,
        routes.keys.PUT,
        routes.keys.PATCH,
        routes.keys.DELETE,
      ]) {
        const response = handler()
        expect(response.status).toBe(405)
        expect(response.headers.get("allow")).toBe("GET")
      }

      // The shipped verbs still behave: a patch returns the ten-key §4.6 row and nothing else.
      const patched = await readJson<{ data?: Record<string, unknown> }>(
        await routes.byId.PATCH(
          requestFor(`/admin/users/${world.target.id}`, ownerCookie(), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "disabled" }),
          })
        )
      )
      expect(patched.status).toBe(200)
      // A CONTAINMENT check, not an exact set: `AdminUserRow` is `admin/users.ts`'s contract and a
      // sibling lane is extending it right now. The ten §4.6 keys must be there; the exact count of
      // that row is not this surface's to freeze. (The DETAIL row's thirteen keys are asserted
      // exactly below — that projection is this file's.)
      const patchedKeys = Object.keys(patched.body.data ?? {}).sort()
      for (const key of ADMIN_ROW_KEYS) expect(patchedKeys, key).toContain(key)
      expect(patched.body.data).toMatchObject({ id: world.target.id, status: "disabled" })
    })
  })

  describe("GET /api/internal/admin/users/{id}", () => {
    it("the owner gets exactly the §4.6 row plus the three counters, and no secret", async () => {
      const { status, body, text } = await getDetail(`/admin/users/${world.target.id}`)
      expect(status).toBe(200)
      expect(Object.keys(body).sort()).toEqual(["data"])
      expect(Object.keys(body.data ?? {}).sort()).toEqual(DETAIL_KEYS)

      expect(body.data).toMatchObject({
        id: world.target.id,
        email: world.target.email,
        role: "user",
        status: "active",
        invitationId: world.invitation.id,
        invitationLabel: world.invitation.label,
        apiCount: 0,
        requestTotal: 11,
        lastLoginAt: null,
        requestsToday: 3,
        spreadsheetCount: 2,
        activeKeyCount: 4,
      })
      expectNoSecrets(text, secrets())

      // The invite is a row id and a memo ONLY: the code and its hash stay in `invitations`.
      expect(text).not.toContain(world.invitation.plaintext)
      expect(text).not.toContain(world.invitation.codeHash)
    })

    it("requestsToday counts this user's rows from UTC midnight and nothing else", async () => {
      const { body } = await getDetail(`/admin/users/${world.target.id}`)
      // 3 planted on or after the floor …
      expect(body.data?.requestsToday).toBe(3)
      // … out of 11 for this account all-time: the eight before the floor (2 day-boundary rows and
      // the 6 credential-traffic rows) are counted by `requestTotal` and by nothing else.
      expect(body.data?.requestTotal).toBe(11)

      // Another account's rows — and the anonymous (NULL `user_id`) row — are not this number's business.
      const otherView = await getDetail(`/admin/users/${world.other.id}`)
      expect(otherView.body.data).toMatchObject({
        requestsToday: 1,
        requestTotal: 2,
        spreadsheetCount: 1,
        activeKeyCount: 0,
      })
    })

    it("the UTC floor is the only thing deciding: yesterday 23:59:59.999 is out, midnight is in", async () => {
      expect(detail.utcDayStart(new Date("2026-11-06T13:45:12.345Z"))).toEqual(
        new Date("2026-11-06T00:00:00.000Z")
      )
      expect(detail.utcDayStart(new Date("2026-11-06T00:00:00.000Z"))).toEqual(
        new Date("2026-11-06T00:00:00.000Z")
      )

      // The same rows read with the clock one millisecond back into yesterday: the floor moves with
      // the clock, so every one of this account's eleven rows is inside that day. The exclusion is
      // `>=`, not a second filter.
      const rewound = await detail.getUserDetail(
        world.target.id,
        actor(world.owner),
        new Date(world.midnight.getTime() - 1)
      )
      if (!("data" in rewound)) throw new Error("detail read failed")
      expect(rewound.data.requestsToday).toBe(11)
      expect(rewound.data.requestTotal).toBe(11)

      // And read a year ahead: none of today's rows are in that day.
      const ahead = await detail.getUserDetail(
        world.target.id,
        actor(world.owner),
        new Date(Date.now() + 366 * MS_PER_DAY)
      )
      if (!("data" in ahead)) throw new Error("detail read failed")
      expect(ahead.data.requestsToday).toBe(0)
    })

    it("activeKeyCount drops revoked and lapsed credentials; spreadsheetCount takes both statuses", async () => {
      const { body } = await getDetail(`/admin/users/${world.target.id}`)
      // live, future-expiry, no-traffic and oldest count; `revoked` and `expired-unrevoked` do not.
      expect(body.data?.activeKeyCount).toBe(4)
      expect(body.data?.spreadsheetCount).toBe(2)

      // Revoking the last live key moves the counter; the row list still shows it.
      await test
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(inArray(apiKeys.name, ["live", "no-traffic", "oldest"]))
      const after = await getDetail(`/admin/users/${world.target.id}`)
      expect(after.body.data?.activeKeyCount).toBe(1)
      expect(after.body.data?.requestTotal).toBe(11)
    })

    it("a ?user_id= is never the scope: the path segment alone decides, byte for byte", async () => {
      const plain = await getDetail(`/admin/users/${world.target.id}`)
      const hijacked = await getDetail(`/admin/users/${world.target.id}?user_id=${world.other.id}`)
      expect(hijacked.status).toBe(200)
      expect(hijacked.text).toEqual(plain.text)
      expect(hijacked.body.data?.id).toBe(world.target.id)
    })
  })

  describe("GET /api/internal/admin/users/{id}/keys", () => {
    it("the owner gets every credential of that account, newest first, with the exact key set", async () => {
      const { status, body } = await getKeys(`/admin/users/${world.target.id}/keys`)
      expect(status).toBe(200)
      expect(Object.keys(body).sort()).toEqual(["data"])
      expect(Object.keys(body.data ?? {}).sort()).toEqual(["rows"])

      const rows = body.data?.rows ?? []
      expect(rows).toHaveLength(6)
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(KEY_ROW_KEYS)

      // Newest first, revoked included, and only this account's.
      expect(rows.map((row) => row.name)).toEqual([
        "live",
        "future-expiry",
        "revoked",
        "expired-unrevoked",
        "no-traffic",
        "oldest",
      ])
      expect(rows.map((row) => row.id)).toEqual(world.keys.map((key) => key.id))
      expect(rows.some((row) => row.id === world.ownerKey.id)).toBe(false)
    })

    it("requestCount is that credential's traffic and preview is the only value-shaped field", async () => {
      const { body } = await getKeys(`/admin/users/${world.target.id}/keys`)
      const rows = body.data?.rows ?? []
      const byName = new Map<string, AdminUserKeyRow>(rows.map((row) => [row.name, row] as const))

      expect(byName.get("live")?.requestCount).toBe(3)
      // A revoked key keeps counting the traffic made with it, from either account's session rows.
      expect(byName.get("revoked")?.requestCount).toBe(2)
      expect(byName.get("no-traffic")?.requestCount).toBe(0)
      expect(byName.get("oldest")?.requestCount).toBe(0)

      expect(byName.get("live")?.scopes).toEqual(["read", "write"])
      expect(byName.get("live")?.allowedApiIds).toBeNull()
      expect(byName.get("future-expiry")?.expiresAt).not.toBeNull()
      expect(byName.get("live")?.expiresAt).toBeNull()
      expect(byName.get("revoked")?.revokedAt).not.toBeNull()
      expect(byName.get("expired-unrevoked")?.revokedAt).toBeNull()
      for (const row of rows) {
        // `preview` is the display-safe head/tail — the ONLY field shaped like a key value.
        expect(row.preview).toMatch(PREVIEW_RE)
      }
    })

    it("NOTHING secret-shaped reaches the wire: no keyHash, no code_hash, no 64-hex digest", async () => {
      // The scan is only meaningful because the digests really are stored — prove that first.
      const stored = await test
        .select({ keyHash: apiKeys.keyHash })
        .from(apiKeys)
        .where(inArray(apiKeys.userId, [world.target.id, world.owner.id]))
      expect(stored).toHaveLength(7)
      for (const row of stored) expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/)

      const keysResponse = await getKeys(`/admin/users/${world.target.id}/keys`)
      // Proof the scan below is of a real payload, not of an error body that happens to be short.
      expect(keysResponse.status).toBe(200)
      expect(keysResponse.body.data?.rows).toHaveLength(6)
      expectNoSecrets(keysResponse.text, secrets())

      // The detail route reads the same tables, so it is scanned the same way — and it, too, is a
      // real 200 payload before the scan.
      const detailResponse = await getDetail(`/admin/users/${world.target.id}`)
      expect(detailResponse.status).toBe(200)
      expect(detailResponse.body.data?.invitationLabel).toBe("Beta cohort")
      expectNoSecrets(detailResponse.text, secrets())

      // The target's `google_sub` really exists and really does not appear.
      const [row] = await test.select().from(users).where(eq(users.id, world.target.id))
      expect(row.googleSub).toBe(`detail-secret-sub-${world.target.id}`)
      expect(detailResponse.text).not.toContain(row.googleSub)
    })

    it("an account with no credentials answers { rows: [] }, not a 404", async () => {
      const keyless = await insertUser()
      const { status, body } = await getKeys(`/admin/users/${keyless.id}/keys`)
      expect(status).toBe(200)
      expect(body.data).toEqual({ rows: [] })
    })

    it("a ?user_id= cannot move the scope of someone else's key list", async () => {
      const plain = await getKeys(`/admin/users/${world.target.id}/keys`)
      const hijacked = await getKeys(`/admin/users/${world.target.id}/keys?user_id=${world.other.id}`)
      expect(hijacked.text).toEqual(plain.text)
      expect(hijacked.body.data?.rows.map((row) => row.id)).toEqual(
        world.keys.map((key) => key.id)
      )
    })
  })

  describe("guards: the route is the first line, not the only line", () => {
    it("a missing session is 401 on both routes", async () => {
      for (const path of [
        `/admin/users/${world.target.id}`,
        `/admin/users/${world.target.id}/keys`,
      ]) {
        const viaDetail = await readJson<ErrorBody>(await routes.byId.GET(requestFor(path)))
        const viaKeys = await readJson<ErrorBody>(await routes.keys.GET(requestFor(path)))
        expect(viaDetail.status, path).toBe(401)
        expect(viaDetail.body, path).toEqual(UNAUTHENTICATED_BODY)
        expect(viaKeys.status, path).toBe(401)
        expect(viaKeys.body, path).toEqual(UNAUTHENTICATED_BODY)
      }
    })

    it("a valid non-owner session is 403 on both routes, and says nothing about the id", async () => {
      const intruder = cookieFor(world.target.id)
      const realKeys = await getKeys(`/admin/users/${world.other.id}/keys`, intruder)
      const guessedKeys = await getKeys(`/admin/users/${MISSING_UUID}/keys`, intruder)
      const realDetail = await getDetail(`/admin/users/${world.other.id}`, intruder)
      const guessedDetail = await getDetail(`/admin/users/${MISSING_UUID}`, intruder)

      for (const [label, probe] of [
        ["keys/real", realKeys],
        ["keys/guess", guessedKeys],
        ["detail/real", realDetail],
        ["detail/guess", guessedDetail],
      ] as const) {
        expect(probe.status, label).toBe(403)
        expect(probe.body, label).toEqual(FORBIDDEN_BODY)
      }
      // A guessed id is not distinguishable from a real one by a non-owner: the role check is first.
      expect(guessedKeys.text).toEqual(realKeys.text)
      expect(guessedDetail.text).toEqual(realDetail.text)
    })

    it("a cookie that only claims owner is still a 403 — the DB role wins", async () => {
      const escalated = cookieFor(world.target.id, "owner")
      expect((await getDetail(`/admin/users/${world.other.id}`, escalated)).status).toBe(403)
      expect((await getKeys(`/admin/users/${world.other.id}/keys`, escalated)).status).toBe(403)
    })

    it("called WITHOUT a route, both services re-check can(role, \"user.read\") themselves", async () => {
      expect(await detail.getUserDetail(world.target.id, actor(world.target))).toEqual(
        SERVICE_FORBIDDEN_BODY
      )
      expect(await detail.listAdminUserKeys(world.target.id, actor(world.target))).toEqual(
        SERVICE_FORBIDDEN_BODY
      )
      // `user.read` is owner-only in `src/server/auth/rbac.ts`, so the owner is the only way in.
      expect(await detail.getUserDetail(world.target.id, actor(world.owner))).toMatchObject({
        ok: true,
      })
      expect(await detail.listAdminUserKeys(world.target.id, actor(world.owner))).toMatchObject({
        ok: true,
      })
    })

    it("a non-owner never reaches a read at all: the id is not even looked at", async () => {
      const refused = await detail.listAdminUserKeys(NOT_A_UUID, actor(world.target))
      expect(refused).toEqual(SERVICE_FORBIDDEN_BODY)
      const refusedDetail = await detail.getUserDetail(NOT_A_UUID, actor(world.target))
      expect(refusedDetail).toEqual(SERVICE_FORBIDDEN_BODY)
    })
  })

  describe("one miss, one body: no existence oracle", () => {
    it("a non-uuid, an absent account and a path with no id answer byte-identical 404s", async () => {
      const notFoundText = JSON.stringify(NOT_FOUND_BODY)
      for (const [path, handler] of [
        [`/admin/users/${NOT_A_UUID}`, routes.byId.GET],
        [`/admin/users/${MISSING_UUID}`, routes.byId.GET],
        ["/admin/users/", routes.byId.GET],
        [`/admin/users/${NOT_A_UUID}/keys`, routes.keys.GET],
        [`/admin/users/${MISSING_UUID}/keys`, routes.keys.GET],
        [`/admin/users/${MISSING_UUID}/keys?user_id=${world.target.id}`, routes.keys.GET],
      ] as const) {
        const response = await readJson<ErrorBody>(await handler(requestFor(path, ownerCookie())))
        expect(response.status, path).toBe(404)
        expect(response.text, path).toEqual(notFoundText)
      }
    })

    it("the detail 404 is byte-for-byte the 404 the shipped PATCH and DELETE verbs answer", async () => {
      const viaGet = await getDetail(`/admin/users/${MISSING_UUID}`)
      const viaDelete = await readJson<ErrorBody>(
        await routes.byId.DELETE(
          requestFor(`/admin/users/${MISSING_UUID}`, ownerCookie(), { method: "DELETE" })
        )
      )
      const viaPatch = await readJson<ErrorBody>(
        await routes.byId.PATCH(
          requestFor(`/admin/users/${MISSING_UUID}`, ownerCookie(), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "disabled" }),
          })
        )
      )
      expect(viaGet.text).toEqual(viaDelete.text)
      expect(viaGet.text).toEqual(viaPatch.text)
      expect(viaGet.body).toEqual(NOT_FOUND_BODY)
    })
  })

  it("the counters stay scoped when only the other account grows", async () => {
    const before = await getDetail(`/admin/users/${world.target.id}`)
    await insertLog({ userId: world.other.id, createdAt: new Date() })
    await insertSpreadsheet(world.other.id, "active")
    await insertKey(world.other.id, { name: "other-key" })
    await insertKey(world.target.id, { name: "revoked-later", revokedAt: new Date() })

    const after = await getDetail(`/admin/users/${world.target.id}`)
    expect(after.body.data).toMatchObject({
      requestsToday: 3,
      requestTotal: 11,
      spreadsheetCount: 2,
      activeKeyCount: 4,
    })
    expect(after.body.data?.id).toBe(before.body.data?.id)
  })
})
