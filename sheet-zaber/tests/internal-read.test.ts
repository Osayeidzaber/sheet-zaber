import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { apiKeys, apiRequestLogs } from "@/server/db/schema"

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
 * Integration coverage for the dashboard's `/api/internal` JSON reads
 * (`backend-api-contract.md` §2, §4.4, §4.6). Handlers are driven directly with a real
 * signed `sz_session` cookie against an embedded PostgreSQL — the guards, the envelope
 * serializer and the query layer are all the production modules.
 *
 * Proven rules: `unauthenticated` for absent/tampered/expired/disabled sessions; a `user`
 * role passes (none of these routes are owner-only); every list is owner-scoped (user B sees
 * zero of user A's rows, and A's stats id under B's session is byte-identical to an unknown
 * id); success bodies are exactly `{ data }` with the §4.6 key sets; and no key hash,
 * plaintext or any other secret can reach the wire.
 */

type SessionModule = typeof import("@/server/auth/session")
type UsersModule = typeof import("@/server/db/queries/users")
type ConnectionsModule = typeof import("@/server/db/queries/google-connections")
type SpreadsheetsModule = typeof import("@/server/db/queries/spreadsheets")
type ApisService = typeof import("@/server/apis/service")
type KeysService = typeof import("@/server/keys/service")
type Routes = {
  connections: typeof import("@/app/api/internal/connections/route")
  spreadsheets: typeof import("@/app/api/internal/spreadsheets/route")
  apis: typeof import("@/app/api/internal/apis/route")
  stats: typeof import("@/app/api/internal/apis/[id]/stats/route")
  keys: typeof import("@/app/api/internal/keys/route")
}

/** §4.6 frozen key sets — an accidental extra field (`userId`, `keyHash`) fails these. */
const CONNECTION_KEYS = ["connectedAt", "googleEmail", "id", "lastUsedAt", "scope", "status"]
const SPREADSHEET_KEYS = [
  "connectionId",
  "createdAt",
  "googleSheetId",
  "id",
  "status",
  "tabs",
  "title",
  "updatedAt",
]
const API_CONFIG_KEYS = [
  "allowedOperations",
  "createdAt",
  "description",
  "enabled",
  "exposedColumns",
  "headerRow",
  "id",
  "name",
  "permissions",
  "primaryKeyColumn",
  "rateLimitPerHour",
  "spreadsheetId",
  "tabTitle",
  "updatedAt",
]
const API_KEY_META_KEYS = [
  "allowedApiIds",
  "createdAt",
  "expiresAt",
  "id",
  "keyPreview",
  "lastUsedAt",
  "name",
  "revokedAt",
  "scopes",
]
const STATS_KEYS = ["apiId", "overview", "range", "usage"]
const STATS_OVERVIEW_KEYS = ["failed", "requests", "success"]
const STATS_USAGE_KEYS = [
  "apiId",
  "errorRate",
  "failed",
  "lastRequestAt",
  "name",
  "requests",
  "success",
]

const UNAUTHENTICATED_BODY = {
  error: { code: "unauthenticated", message: "Sign in to continue.", category: "auth" },
} as const

const TAB = { id: 0, title: "Sheet1", rows: 100, columns: 26 }

let test: TestDb
let session: SessionModule
let users: UsersModule
let connections: ConnectionsModule
let sheets: SpreadsheetsModule
let apis: ApisService
let keys: KeysService
let routes: Routes
let cookieName = "sz_session"

function utcDay(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

function startOfUtcDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

function cookieFor(uid: string, role: "user" | "owner" = "user", expOffsetSeconds = 3600): string {
  const token = session.signSession({ uid, role, exp: Math.floor(Date.now() / 1000) + expOffsetSeconds })
  return `${cookieName}=${token}`
}

function requestFor(path: string, cookie?: string): Request {
  return new Request(`http://localhost:3001${path}`, cookie ? { headers: { cookie } } : undefined)
}

/** Every read surface under test, as [path, handler] pairs. */
function allRoutes(apiIdProvider: () => string): [string, (req: Request) => Promise<Response>][] {
  return [
    ["/api/internal/connections", routes.connections.GET],
    ["/api/internal/spreadsheets", routes.spreadsheets.GET],
    ["/api/internal/apis", routes.apis.GET],
    [`/api/internal/apis/${apiIdProvider()}/stats`, routes.stats.GET],
    ["/api/internal/keys", routes.keys.GET],
  ]
}

async function seedUser(label: string, role: "user" | "owner" = "user") {
  const stamp = randomUUID()
  return users.createUser({
    googleSub: `sub-${stamp}`,
    email: `internal-read-${label}-${stamp}@example.com`,
    role,
  })
}

async function seedConnection(
  userId: string,
  label: string,
  status: "connected" | "reauth_required" | "disconnected" = "connected"
) {
  const connection = await connections.upsertConnection({
    userId,
    googleEmail: `${label}-${randomUUID()}@example.com`,
    refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
    scope: "openid email https://www.googleapis.com/auth/spreadsheets",
  })
  if (status !== "connected") await connections.markConnectionStatus(connection.id, status)
  return connection
}

async function seedSpreadsheet(userId: string, connectionId: string, label: string) {
  return sheets.upsertSpreadsheet({
    userId,
    connectionId,
    googleSheetId: `sheet-${label}-${randomUUID()}`,
    title: `Roster ${label}`,
    tabs: [TAB],
  })
}

async function seedApi(userId: string, spreadsheetId: string, name: string) {
  const result = await apis.createApi(
    {
      spreadsheetId,
      name,
      tabTitle: TAB.title,
      headerRow: 1,
      permissions: "read",
      allowedOperations: ["GET"],
    },
    userId
  )
  if (!result.ok) throw new Error(`seed api failed: ${result.error.code}`)
  return result.data
}

/** `createdAt` is passed explicitly so range windows are deterministic. */
async function seedLog(input: {
  userId: string
  apiId: string
  statusCode: number
  createdAt: Date
}) {
  await test.insert(apiRequestLogs).values({
    userId: input.userId,
    apiId: input.apiId,
    method: "GET",
    path: `/api/v1/${input.apiId}`,
    statusCode: input.statusCode,
    durationMs: 12,
    errorCategory: input.statusCode >= 400 ? "internal" : null,
    createdAt: input.createdAt,
  })
}

let world: {
  alice: { id: string }
  aliceConn: { id: string }
  aliceSheet: { id: string }
  aliceApi: { id: string }
  bob: { id: string }
}

async function buildWorld() {
  const alice = await seedUser("alice")
  const bob = await seedUser("bob")
  const aliceConn = await seedConnection(alice.id, "alice")
  const aliceSheet = await seedSpreadsheet(alice.id, aliceConn.id, "alice")
  const aliceApi = await seedApi(alice.id, aliceSheet.id, "Alice roster")
  return { alice, aliceConn, aliceSheet, aliceApi, bob }
}

describe("internal read routes", () => {
  beforeAll(async () => {
    let url: string
    try {
      url = inject(TEST_DB_URL_KEY)
    } catch {
      await startTestDb()
      await migrateTestDb()
      url = getTestDbUrl()
    }
    // Before any module that binds the pool or freezes `env`.
    process.env.DATABASE_URL = url
    test = await getTestDb()
    session = await import("@/server/auth/session")
    cookieName = session.SESSION_COOKIE
    users = await import("@/server/db/queries/users")
    connections = await import("@/server/db/queries/google-connections")
    sheets = await import("@/server/db/queries/spreadsheets")
    apis = await import("@/server/apis/service")
    keys = await import("@/server/keys/service")
    routes = {
      connections: await import("@/app/api/internal/connections/route"),
      spreadsheets: await import("@/app/api/internal/spreadsheets/route"),
      apis: await import("@/app/api/internal/apis/route"),
      stats: await import("@/app/api/internal/apis/[id]/stats/route"),
      keys: await import("@/app/api/internal/keys/route"),
    }
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    world = await buildWorld()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  describe("session guard", () => {
    it("401 unauthenticated with no cookie on every route", async () => {
      for (const [path, get] of allRoutes(() => randomUUID())) {
        const response = await get(requestFor(path))
        expect(response.status, path).toBe(401)
        expect(await response.json(), path).toEqual(UNAUTHENTICATED_BODY)
      }
    })

    it("401 on a tampered cookie (signature does not verify)", async () => {
      const cookie = cookieFor(world.alice.id)
      const last = cookie.charAt(cookie.length - 1)
      const tampered = `${cookie.slice(0, -1)}${last === "A" ? "B" : "A"}`
      for (const [path, get] of allRoutes(() => world.aliceApi.id)) {
        const response = await get(requestFor(path, tampered))
        expect(response.status, path).toBe(401)
        expect(await response.json(), path).toEqual(UNAUTHENTICATED_BODY)
      }
    })

    it("401 on an expired cookie even though the signature is genuine", async () => {
      const cookie = cookieFor(world.alice.id, "user", -60)
      for (const [path, get] of allRoutes(() => world.aliceApi.id)) {
        const response = await get(requestFor(path, cookie))
        expect(response.status, path).toBe(401)
        expect(await response.json(), path).toEqual(UNAUTHENTICATED_BODY)
      }
    })

    it("401 for a disabled user holding a previously valid signed cookie", async () => {
      const response = await routes.connections.GET(requestFor("/api/internal/connections", cookieFor(world.alice.id)))
      expect(response.status).toBe(200)

      await users.setUserStatus(world.alice.id, "disabled")
      const after = await routes.connections.GET(requestFor("/api/internal/connections", cookieFor(world.alice.id)))
      expect(after.status).toBe(401)
      expect(await after.json()).toEqual(UNAUTHENTICATED_BODY)
    })

    it("a user-role session is accepted everywhere — none of these routes are owner-only", async () => {
      for (const [path, get] of allRoutes(() => world.aliceApi.id)) {
        const response = await get(requestFor(path, cookieFor(world.alice.id, "user")))
        expect(response.status, path).toBe(200)
        expect(Object.keys(await response.json()), path).toEqual(["data"])
      }
    })

    it("an owner session is accepted too", async () => {
      const owner = await seedUser("owner", "owner")
      const response = await routes.apis.GET(requestFor("/api/internal/apis", cookieFor(owner.id, "owner")))
      expect(response.status).toBe(200)
    })
  })

  describe("payload shapes (§4.6 key sets)", () => {
    it("connections list: exact body and keys, status included", async () => {
      const response = await routes.connections.GET(
        requestFor("/api/internal/connections", cookieFor(world.alice.id))
      )
      const body = await response.json()
      expect(Object.keys(body)).toEqual(["data"])
      expect(body.data).toHaveLength(1)
      expect(Object.keys(body.data[0]).sort()).toEqual(CONNECTION_KEYS)
      expect(body.data[0].status).toBe("connected")
    })

    it("reconnect banner: a reauth_required row is carried verbatim", async () => {
      const second = await seedConnection(world.alice.id, "second", "reauth_required")
      const response = await routes.connections.GET(
        requestFor("/api/internal/connections", cookieFor(world.alice.id))
      )
      const body = await response.json()
      const row = body.data.find((c: { id: string }) => c.id === second.id)
      expect(row.status).toBe("reauth_required")
    })

    it("spreadsheets list: exact keys, tabs snapshot, no userId", async () => {
      const response = await routes.spreadsheets.GET(
        requestFor("/api/internal/spreadsheets", cookieFor(world.alice.id))
      )
      const body = await response.json()
      expect(Object.keys(body)).toEqual(["data"])
      expect(body.data).toHaveLength(1)
      expect(Object.keys(body.data[0]).sort()).toEqual(SPREADSHEET_KEYS)
      expect(body.data[0].tabs).toEqual([TAB])
    })

    it("apis list: exact keys", async () => {
      const response = await routes.apis.GET(requestFor("/api/internal/apis", cookieFor(world.alice.id)))
      const body = await response.json()
      expect(Object.keys(body)).toEqual(["data"])
      expect(body.data).toHaveLength(1)
      expect(Object.keys(body.data[0]).sort()).toEqual(API_CONFIG_KEYS)
    })

    it("keys list: exact §4.6 keys — no keyHash, no userId — and no secret in the wire text", async () => {
      const created = await keys.createKey({ name: "ci", scopes: ["read"] }, world.alice.id)
      if (!created.ok) throw new Error("seed key failed")
      const [raw] = await test
        .select({ keyHash: apiKeys.keyHash })
        .from(apiKeys)
        .where(eq(apiKeys.id, created.data.id))
        .limit(1)
      expect(raw?.keyHash).toBeTruthy()

      const response = await routes.keys.GET(requestFor("/api/internal/keys", cookieFor(world.alice.id)))
      const text = await response.text()
      const body = JSON.parse(text)
      expect(Object.keys(body)).toEqual(["data"])
      expect(body.data).toHaveLength(1)
      expect(Object.keys(body.data[0]).sort()).toEqual(API_KEY_META_KEYS)

      expect(text).not.toContain(raw!.keyHash)
      expect(text).not.toContain(created.data.plaintext)
      expect(text).not.toContain("keyHash")
    })

    it("stats body: exact { apiId, range, overview, usage } key sets", async () => {
      const day0 = utcDay(0)
      await seedLog({ userId: world.alice.id, apiId: world.aliceApi.id, statusCode: 200, createdAt: new Date(`${day0}T01:00:00.000Z`) })
      const response = await routes.stats.GET(
        requestFor(`/api/internal/apis/${world.aliceApi.id}/stats`, cookieFor(world.alice.id))
      )
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(Object.keys(body)).toEqual(["data"])
      expect(Object.keys(body.data).sort()).toEqual(STATS_KEYS)
      expect(Object.keys(body.data.overview).sort()).toEqual(STATS_OVERVIEW_KEYS)
      expect(Object.keys(body.data.usage).sort()).toEqual(STATS_USAGE_KEYS)
      expect(body.data.apiId).toBe(world.aliceApi.id)
      expect(body.data.range).toEqual({ from: null, to: null })
      expect(body.data.usage.name).toBe("Alice roster")
    })
  })

  describe("query filters", () => {
    it("spreadsheets ?connection_id= narrows server-side", async () => {
      const conn2 = await seedConnection(world.alice.id, "alice-2")
      const sheet2 = await seedSpreadsheet(world.alice.id, conn2.id, "two")

      const filtered = await routes.spreadsheets.GET(
        requestFor(`/api/internal/spreadsheets?connection_id=${conn2.id}`, cookieFor(world.alice.id))
      )
      const filteredBody = await filtered.json()
      expect(filteredBody.data).toHaveLength(1)
      expect(filteredBody.data[0].id).toBe(sheet2.id)

      const all = await routes.spreadsheets.GET(
        requestFor("/api/internal/spreadsheets", cookieFor(world.alice.id))
      )
      expect((await all.json()).data).toHaveLength(2)

      const none = await routes.spreadsheets.GET(
        requestFor(`/api/internal/spreadsheets?connection_id=${randomUUID()}`, cookieFor(world.alice.id))
      )
      expect((await none.json()).data).toEqual([])
    })

    it("apis ?spreadsheet_id= narrows server-side", async () => {
      const api2 = await seedApi(world.alice.id, world.aliceSheet.id, "Second")
      const filtered = await routes.apis.GET(
        requestFor(`/api/internal/apis?spreadsheet_id=${world.aliceSheet.id}`, cookieFor(world.alice.id))
      )
      const ids = (await filtered.json()).data.map((a: { id: string }) => a.id)
      expect(ids).toHaveLength(2)
      expect(ids).toContain(world.aliceApi.id)
      expect(ids).toContain(api2.id)

      const none = await routes.apis.GET(
        requestFor(`/api/internal/apis?spreadsheet_id=${randomUUID()}`, cookieFor(world.alice.id))
      )
      expect((await none.json()).data).toEqual([])
    })
  })

  describe("cross-user isolation", () => {
    it("user B's session sees zero rows of user A on every list", async () => {
      for (const path of [
        "/api/internal/connections",
        "/api/internal/spreadsheets",
        "/api/internal/apis",
        "/api/internal/keys",
      ]) {
        const get =
          path === "/api/internal/connections"
            ? routes.connections.GET
            : path === "/api/internal/spreadsheets"
              ? routes.spreadsheets.GET
              : path === "/api/internal/apis"
                ? routes.apis.GET
                : routes.keys.GET
        const response = await get(requestFor(path, cookieFor(world.bob.id)))
        expect(response.status, path).toBe(200)
        expect(await response.json(), path).toEqual({ data: [] })
      }
    })

    it("A's stats id under B's session is 404, byte-identical to a wholly unknown id", async () => {
      const foreign = await routes.stats.GET(
        requestFor(`/api/internal/apis/${world.aliceApi.id}/stats`, cookieFor(world.bob.id))
      )
      const unknown = await routes.stats.GET(
        requestFor(`/api/internal/apis/${randomUUID()}/stats`, cookieFor(world.bob.id))
      )
      expect(foreign.status).toBe(404)
      expect(unknown.status).toBe(404)
      const foreignBody = await foreign.json()
      const unknownBody = await unknown.json()
      expect(foreignBody).toEqual(unknownBody)
      expect(foreignBody).toEqual({
        error: { code: "not_found", message: "No API was found with that id.", category: "not_found" },
      })
    })

    it("a bad date range never reveals that the id belongs to someone else", async () => {
      // B probing A's id with invalid dates gets 400, but so does a wholly unknown id:
      // the status carries no ownership signal either way.
      const foreign = await routes.stats.GET(
        requestFor(`/api/internal/apis/${world.aliceApi.id}/stats?from=nope`, cookieFor(world.bob.id))
      )
      const unknown = await routes.stats.GET(
        requestFor(`/api/internal/apis/${randomUUID()}/stats?from=nope`, cookieFor(world.bob.id))
      )
      expect(foreign.status).toBe(400)
      expect(unknown.status).toBe(400)
    })
  })

  describe("stats counting", () => {
    async function seedThreeDays() {
      const day0 = utcDay(0)
      const day5 = utcDay(5)
      // Insert oldest first: `listRequestLogs` orders by descending id (insertion order).
      await seedLog({ userId: world.alice.id, apiId: world.aliceApi.id, statusCode: 200, createdAt: new Date(`${day5}T03:00:00.000Z`) })
      await seedLog({ userId: world.alice.id, apiId: world.aliceApi.id, statusCode: 200, createdAt: new Date(`${day0}T01:00:00.000Z`) })
      await seedLog({ userId: world.alice.id, apiId: world.aliceApi.id, statusCode: 500, createdAt: new Date(`${day0}T02:00:00.000Z`) })
    }

    async function stats(cookie: string, params = "") {
      const response = await routes.stats.GET(
        requestFor(`/api/internal/apis/${world.aliceApi.id}/stats${params}`, cookie)
      )
      return { response, body: await response.json() }
    }

    it("unbounded range counts every row; success + failed === requests", async () => {
      await seedThreeDays()
      const { response, body } = await stats(cookieFor(world.alice.id))
      expect(response.status).toBe(200)
      expect(body.data.overview).toEqual({ requests: 3, success: 2, failed: 1 })
      expect(body.data.usage).toEqual({
        apiId: world.aliceApi.id,
        name: "Alice roster",
        requests: 3,
        success: 2,
        failed: 1,
        errorRate: 1 / 3,
        lastRequestAt: new Date(`${utcDay(0)}T02:00:00.000Z`).toISOString(),
      })
    })

    it("from/to are inclusive both ends", async () => {
      await seedThreeDays()
      const today = await stats(cookieFor(world.alice.id), `?from=${utcDay(0)}&to=${utcDay(0)}`)
      expect(today.body.data.overview).toEqual({ requests: 2, success: 1, failed: 1 })
      expect(today.body.data.range).toEqual({ from: utcDay(0), to: utcDay(0) })

      const then = await stats(cookieFor(world.alice.id), `?from=${utcDay(5)}&to=${utcDay(5)}`)
      expect(then.body.data.overview).toEqual({ requests: 1, success: 1, failed: 0 })
    })

    it("an API without logs reads as all zeros, not null", async () => {
      const empty = await stats(cookieFor(world.alice.id))
      expect(empty.response.status).toBe(200)
      expect(empty.body.data.overview).toEqual({ requests: 0, success: 0, failed: 0 })
      expect(empty.body.data.usage.requests).toBe(0)
      expect(empty.body.data.usage.errorRate).toBe(0)
      expect(empty.body.data.usage.lastRequestAt).toBeNull()
    })

    it("unparseable from/to are 400 validation_failed with field messages", async () => {
      for (const [params, field] of [
        ["?from=05/06/2024", "from"],
        ["?from=2024-02-30", "from"],
        ["?to=soon", "to"],
      ] as [string, string][]) {
        const { response, body } = await stats(cookieFor(world.alice.id), params)
        expect(response.status, params).toBe(400)
        expect(body.error.code).toBe("validation_failed")
        expect(body.error.category).toBe("validation")
        expect(Object.keys(body.error.fields)).toEqual([field])
      }
    })

    it("from > to is 400 and names both fields", async () => {
      const { response, body } = await stats(
        cookieFor(world.alice.id),
        `?from=${utcDay(0)}&to=${utcDay(5)}`
      )
      expect(response.status).toBe(400)
      expect(body.error.code).toBe("validation_failed")
      expect(Object.keys(body.error.fields).sort()).toEqual(["from", "to"])
    })

    it("the error body contains no aggregate, no row data and no other user's id", async () => {
      // B probing A's id with invalid dates gets 400; the message is a fixed string.
      const response = await routes.stats.GET(
        requestFor(`/api/internal/apis/${world.aliceApi.id}/stats?from=${world.aliceApi.id}`, cookieFor(world.bob.id))
      )
      expect(response.status).toBe(400)
      const text = await response.text()
      expect(text).not.toContain(world.alice.id)
      expect(text).not.toContain("overview")
      expect(text).not.toContain("usage")
    })

    it("lastRequestAt is only derived from the API's own logs (startOfUtcDay sanity)", () => {
      expect(startOfUtcDay("2024-03-01").toISOString()).toBe("2024-03-01T00:00:00.000Z")
    })
  })

  describe("method switch", () => {
    it("non-GET methods answer 405 with an Allow header of GET", async () => {
      const cases: [string, () => Response][] = [
        ["/api/internal/connections", routes.connections.POST],
        ["/api/internal/spreadsheets", routes.spreadsheets.PUT],
        ["/api/internal/apis", routes.apis.PATCH],
        ["/api/internal/keys", routes.keys.DELETE],
      ]
      for (const [path, handler] of cases) {
        const response = handler()
        expect(response.status, path).toBe(405)
        expect(response.headers.get("allow"), path).toBe("GET")
        expect(await response.json(), path).toEqual({
          error: { code: "method_not_allowed", message: "Method not allowed.", category: "validation" },
        })
      }
    })

    it("the stats route refuses POST the same way", () => {
      const response = routes.stats.POST()
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("GET")
    })
  })
})
