import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import {
  apiConfigurations,
  apiRequestLogs,
  googleConnections,
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
 * Route-level coverage for `GET /api/internal/analytics/overview` and
 * `GET /api/internal/analytics/apis` (`backend-api-contract.md` §2 "Logs & analytics", §4.4, §4.6).
 *
 * Key names are asserted literally: this is the contract the dashboard renders against. Both routes
 * answer the repository's aggregate shape (`AnalyticsOverview` / `ApiAnalyticsRow`), which is what
 * `src/server/logs/service.ts` binds to and what `(app)/analytics` renders — §4.6's `Overview`
 * `must`/`nice` and `ApiUsageRow` `errorRate`/`lastRequestAt` are reported as a doc divergence.
 */

type SessionModule = typeof import("@/server/auth/session")
type Routes = {
  overview: typeof import("@/app/api/internal/analytics/overview/route")
  apis: typeof import("@/app/api/internal/analytics/apis/route")
}

const OVERVIEW_KEYS = ["byDay", "failed", "requests", "success"]
const OVERVIEW_DAY_KEYS = ["count", "day"]
const API_USAGE_KEYS = ["apiId", "count", "errors", "name"]
const DEFAULT_WINDOW_DAYS = 30

const UNAUTHENTICATED_BODY = {
  error: { code: "unauthenticated", message: "Sign in to continue.", category: "auth" },
} as const

const DAY_MS = 86_400_000

let test: TestDb
let session: SessionModule
let routes: Routes
let cookieName = "sz_session"

function utcDay(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10)
}

/** Midday UTC: far enough from either midnight that the DB session timezone cannot move the day. */
function at(day: string, hour: number): Date {
  return new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`)
}

function cookieFor(uid: string, role: "user" | "owner" = "user"): string {
  const token = session.signSession({ uid, role, exp: Math.floor(Date.now() / 1000) + 3600 })
  return `${cookieName}=${token}`
}

function requestFor(path: string, cookie?: string): Request {
  return new Request(`http://localhost:3001${path}`, cookie ? { headers: { cookie } } : undefined)
}

async function insertUser(role: "user" | "owner" = "user") {
  const id = randomUUID()
  const [row] = await test
    .insert(users)
    .values({
      id,
      googleSub: `analytics-sub-${id}`,
      email: `analytics-${role}-${id}@example.com`,
      role,
      status: "active",
    })
    .returning()
  return row
}

async function insertApi(userId: string, name: string): Promise<string> {
  const connectionId = randomUUID()
  await test.insert(googleConnections).values({
    id: connectionId,
    userId,
    googleEmail: `analytics-${randomUUID()}@example.com`,
    refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
    scope: "openid email https://www.googleapis.com/auth/spreadsheets",
  })
  const spreadsheetId = randomUUID()
  await test.insert(registeredSpreadsheets).values({
    id: spreadsheetId,
    userId,
    connectionId,
    googleSheetId: `sheet-${randomUUID()}`,
    title: `Analytics sheet ${randomUUID()}`,
    tabs: [{ id: 0, title: "Sheet1", rows: 100, columns: 26 }],
  })
  const apiId = randomUUID()
  await test.insert(apiConfigurations).values({
    id: apiId,
    userId,
    spreadsheetId,
    name,
    tabTitle: "Sheet1",
    allowedOperations: ["GET"],
  })
  return apiId
}

async function insertLog(input: { userId: string; apiId: string; statusCode: number; createdAt: Date }) {
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
  aliceApi: string
  aliceQuietApi: string
  bob: { id: string }
  bobApi: string
  owner: { id: string }
}

async function buildWorld() {
  const alice = await insertUser()
  const bob = await insertUser()
  const owner = await insertUser("owner")
  const aliceApi = await insertApi(alice.id, "Alice roster")
  const aliceQuietApi = await insertApi(alice.id, "Alice quiet")
  const bobApi = await insertApi(bob.id, "Bob roster")

  const today = utcDay(0)
  const twoAgo = utcDay(2)
  // Alice: three rows today (two ok, one failed), one ok two days back, one far outside the window.
  await insertLog({ userId: alice.id, apiId: aliceApi, statusCode: 200, createdAt: at(today, 10) })
  await insertLog({ userId: alice.id, apiId: aliceApi, statusCode: 201, createdAt: at(today, 11) })
  await insertLog({ userId: alice.id, apiId: aliceApi, statusCode: 503, createdAt: at(today, 12) })
  await insertLog({ userId: alice.id, apiId: aliceApi, statusCode: 200, createdAt: at(twoAgo, 9) })
  await insertLog({ userId: alice.id, apiId: aliceApi, statusCode: 200, createdAt: at(utcDay(45), 9) })
  await insertLog({ userId: bob.id, apiId: bobApi, statusCode: 404, createdAt: at(today, 13) })
  await insertLog({ userId: owner.id, apiId: bobApi, statusCode: 200, createdAt: at(today, 14) })
  return { alice, aliceApi, aliceQuietApi, bob, bobApi, owner }
}

describe("analytics routes", () => {
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
    cookieName = session.SESSION_COOKIE
    routes = {
      overview: await import("@/app/api/internal/analytics/overview/route"),
      apis: await import("@/app/api/internal/analytics/apis/route"),
    }
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    world = await buildWorld()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  async function overview(path: string, cookie?: string) {
    const response = await routes.overview.GET(requestFor(path, cookie))
    return { response, body: await response.json() }
  }

  async function apis(path: string, cookie?: string) {
    const response = await routes.apis.GET(requestFor(path, cookie))
    return { response, body: await response.json() }
  }

  describe("guards", () => {
    it("401 unauthenticated with no cookie on both routes", async () => {
      const cases = [
        [routes.overview.GET, "/api/internal/analytics/overview"],
        [routes.apis.GET, "/api/internal/analytics/apis"],
      ] as const
      for (const [handler, path] of cases) {
        const response = await handler(requestFor(path))
        expect(response.status, path).toBe(401)
        expect(await response.json(), path).toEqual(UNAUTHENTICATED_BODY)
      }
    })

    it("both routes are userRoute: a plain session is accepted, not 403", async () => {
      for (const [handler, path] of [
        [routes.overview.GET, "/api/internal/analytics/overview"],
        [routes.apis.GET, "/api/internal/analytics/apis"],
      ] as const) {
        const response = await handler(requestFor(path, cookieFor(world.alice.id)))
        expect(response.status, path).toBe(200)
        expect(Object.keys(await response.json()), path).toEqual(["data"])
      }
    })
  })

  describe("GET /api/internal/analytics/overview", () => {
    it("body is exactly { requests, success, failed, byDay } with { day, count } buckets", async () => {
      const { body } = await overview("/api/internal/analytics/overview", cookieFor(world.alice.id))
      expect(Object.keys(body.data).sort()).toEqual(OVERVIEW_KEYS)
      for (const bucket of body.data.byDay) expect(Object.keys(bucket).sort()).toEqual(OVERVIEW_DAY_KEYS)
      expect(body.data).toMatchObject({ requests: 4, success: 3, failed: 1 })
    })

    it("success + failed === requests and the day series sums to requests", async () => {
      for (const cookie of [cookieFor(world.alice.id), cookieFor(world.owner.id, "owner")]) {
        const { body } = await overview("/api/internal/analytics/overview", cookie)
        const totals = body.data
        expect(totals.success + totals.failed).toBe(totals.requests)
        expect(totals.byDay.reduce((sum: number, d: { count: number }) => sum + d.count, 0)).toBe(
          totals.requests
        )
      }
    })

    it("the default window is the last 30 days, so the 45-day row is outside it", async () => {
      const { body } = await overview("/api/internal/analytics/overview", cookieFor(world.alice.id))
      expect(body.data.requests).toBe(4)

      const widened = await overview(
        `/api/internal/analytics/overview?from=${utcDay(DEFAULT_WINDOW_DAYS * 2)}&to=${utcDay(0)}`,
        cookieFor(world.alice.id)
      )
      expect(widened.body.data.requests).toBe(5)
    })

    it("byDay is ascending by day and every label is YYYY-MM-DD", async () => {
      const { body } = await overview(
        `/api/internal/analytics/overview?from=${utcDay(3)}&to=${utcDay(0)}`,
        cookieFor(world.alice.id)
      )
      const days = body.data.byDay.map((d: { day: string }) => d.day)
      expect(days).toEqual([...days].sort())
      for (const day of days) expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(body.data.byDay.at(-1)).toEqual({ day: utcDay(0), count: 3 })
    })

    it("an empty window is zeros and an empty series, never null", async () => {
      const { body } = await overview(
        `/api/internal/analytics/overview?from=${utcDay(20)}&to=${utcDay(19)}`,
        cookieFor(world.alice.id)
      )
      expect(body.data).toEqual({ requests: 0, success: 0, failed: 0, byDay: [] })
    })

    it("a plain user's totals are their own; an owner's are the platform's", async () => {
      const alice = await overview("/api/internal/analytics/overview", cookieFor(world.alice.id))
      const owner = await overview("/api/internal/analytics/overview", cookieFor(world.owner.id, "owner"))
      expect(alice.body.data.requests).toBe(4)
      // 4 (alice) + 1 (bob) + 1 (owner) inside the default window: alice's 45-day row is still out.
      expect(owner.body.data.requests).toBe(6)
    })

    it("an owner may narrow to one account; a plain user's user_id is ignored", async () => {
      const narrowed = await overview(
        `/api/internal/analytics/overview?user_id=${world.bob.id}`,
        cookieFor(world.owner.id, "owner")
      )
      expect(narrowed.body.data.requests).toBe(1)

      const plain = await overview("/api/internal/analytics/overview", cookieFor(world.alice.id))
      const probing = await overview(
        `/api/internal/analytics/overview?user_id=${world.bob.id}`,
        cookieFor(world.alice.id)
      )
      expect(probing.body).toEqual(plain.body)
      expect(probing.body.data.requests).toBe(4)
    })

    it("bad from/to are 400 with the field named, and an empty range is not an error", async () => {
      for (const [params, field] of [
        ["from=05/06/2024", "from"],
        ["from=2026-02-30", "from"],
        ["to=later", "to"],
        ["user_id=not-a-uuid", "user_id"],
      ] as [string, string][]) {
        const { response, body } = await overview(
          `/api/internal/analytics/overview?${params}`,
          cookieFor(world.alice.id)
        )
        expect(response.status, params).toBe(400)
        expect(body.error.code, params).toBe("validation_failed")
        expect(body.error.category, params).toBe("validation")
        expect(Object.keys(body.error.fields), params).toEqual([field])
      }
    })

    it("a DEFAULT_OVERVIEW_DAYS window is applied only when neither bound is given", async () => {
      const fromOnly = await overview(
        `/api/internal/analytics/overview?from=${utcDay(400)}`,
        cookieFor(world.alice.id)
      )
      expect(fromOnly.response.status).toBe(200)
      expect(fromOnly.body.data.requests).toBe(5)
    })
  })

  describe("GET /api/internal/analytics/apis", () => {
    it("body is the §2 per-API list with exactly { apiId, name, count, errors }", async () => {
      const { body } = await apis("/api/internal/analytics/apis", cookieFor(world.alice.id))
      expect(Array.isArray(body.data)).toBe(true)
      expect(body.data).toHaveLength(1)
      expect(Object.keys(body.data[0]).sort()).toEqual(API_USAGE_KEYS)
      expect(body.data[0]).toEqual({
        apiId: world.aliceApi,
        name: "Alice roster",
        count: 5,
        errors: 1,
      })
    })

    it("an API with no logs at all is absent, not a zero row", async () => {
      const { body } = await apis("/api/internal/analytics/apis", cookieFor(world.alice.id))
      expect(body.data.map((r: { apiId: string }) => r.apiId)).not.toContain(world.aliceQuietApi)
    })

    it("a plain user gets only their own APIs; an owner gets every API with traffic", async () => {
      const alice = await apis("/api/internal/analytics/apis", cookieFor(world.alice.id))
      expect(alice.body.data.map((r: { name: string }) => r.name)).toEqual(["Alice roster"])

      const all = await apis("/api/internal/analytics/apis", cookieFor(world.owner.id, "owner"))
      expect(all.body.data).toHaveLength(2)
      // Ordered by count desc: Alice roster has 5 rows, Bob roster 2.
      expect(all.body.data[0]).toMatchObject({ name: "Alice roster", count: 5, errors: 1 })
      expect(all.body.data[1]).toMatchObject({ name: "Bob roster", count: 2, errors: 1 })
    })

    it("the error count is the >=400 subset of the same rows", async () => {
      const { body } = await apis("/api/internal/analytics/apis", cookieFor(world.owner.id, "owner"))
      for (const row of body.data) {
        expect(row.errors).toBeLessThanOrEqual(row.count)
        expect(Number.isSafeInteger(row.errors)).toBe(true)
      }
    })

    it("no key, token or invitation material is in the wire text", async () => {
      const response = await routes.apis.GET(requestFor("/api/internal/analytics/apis", cookieFor(world.alice.id)))
      const text = await response.text()
      for (const needle of ["keyHash", "codeHash", "refresh_token", "sz_live_", "ZABER-", world.bob.id]) {
        expect(text, needle).not.toContain(needle)
      }
    })
  })

  describe("method switch", () => {
    it("POST, PUT, PATCH and DELETE answer 405 with Allow: GET on both routes", async () => {
      for (const route of [routes.overview, routes.apis]) {
        for (const handler of [route.POST, route.PUT, route.PATCH, route.DELETE]) {
          const response = handler()
          expect(response.status).toBe(405)
          expect(response.headers.get("allow")).toBe("GET")
          expect(await response.json()).toEqual({
            error: { code: "method_not_allowed", message: "Method not allowed.", category: "validation" },
          })
        }
      }
    })
  })
})
