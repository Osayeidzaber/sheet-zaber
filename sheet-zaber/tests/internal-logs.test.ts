import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { apiConfigurations, apiRequestLogs, googleConnections, registeredSpreadsheets, users } from "@/server/db/schema"

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
 * Route-level coverage for `GET /api/internal/logs` (`backend-api-contract.md` §2 "Logs &
 * analytics (user: own; owner: all)", §4.4, §4.6) against the real embedded PostgreSQL.
 *
 * The handler is imported and driven with a genuine signed `sz_session`, so the guard, the
 * serializer and the scoped SQL are all the production modules. Prerequisites are raw schema
 * inserts: the sibling services are concurrent work, and a log page needs rows, not behaviours.
 */

type SessionModule = typeof import("@/server/auth/session")
type Routes = { logs: typeof import("@/app/api/internal/logs/route") }

/** §4.6's `LogRow` column-for-column, plus the repository's extra `apiName` join (see the report). */
const LOG_ROW_KEYS = [
  "apiId",
  "apiKeyId",
  "apiName",
  "createdAt",
  "durationMs",
  "errorCategory",
  "id",
  "method",
  "origin",
  "path",
  "requestBytes",
  "statusCode",
  "userEmail",
  "userId",
]

const UNAUTHENTICATED_BODY = {
  error: { code: "unauthenticated", message: "Sign in to continue.", category: "auth" },
} as const

const METHOD_NOT_ALLOWED_BODY = {
  error: { code: "method_not_allowed", message: "Method not allowed.", category: "validation" },
} as const

const DAY_MS = 86_400_000

let test: TestDb
let session: SessionModule
let routes: Routes
let cookieName = "sz_session"

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgoText(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)
}

function stamp(): string {
  return randomUUID()
}

function cookieFor(uid: string, role: "user" | "owner" = "user"): string {
  const token = session.signSession({ uid, role, exp: Math.floor(Date.now() / 1000) + 3600 })
  return `${cookieName}=${token}`
}

function requestFor(path: string, cookie?: string): Request {
  return new Request(`http://localhost:3001${path}`, cookie ? { headers: { cookie } } : undefined)
}

async function get(path: string, cookie?: string) {
  const response = await routes.logs.GET(requestFor(path, cookie))
  return { response, body: await response.json() }
}

async function insertUser(role: "user" | "owner" = "user") {
  const id = randomUUID()
  const [row] = await test
    .insert(users)
    .values({ id, googleSub: `logs-sub-${id}`, email: `logs-${role}-${id}@example.com`, role, status: "active" })
    .returning()
  return row
}

/** The three-table chain a log row's FKs demand: connection → spreadsheet → API. */
async function insertApi(userId: string, name: string): Promise<string> {
  const connectionId = randomUUID()
  await test.insert(googleConnections).values({
    id: connectionId,
    userId,
    googleEmail: `logs-${stamp()}@example.com`,
    refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
    scope: "openid email https://www.googleapis.com/auth/spreadsheets",
  })
  const spreadsheetId = randomUUID()
  await test.insert(registeredSpreadsheets).values({
    id: spreadsheetId,
    userId,
    connectionId,
    googleSheetId: `sheet-${stamp()}`,
    title: `Log sheet ${stamp()}`,
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

/** `createdAt` is explicit so every window assertion is deterministic; oldest first for id order. */
async function insertLog(input: {
  userId: string
  apiId: string
  statusCode: number
  method?: string
  createdAt: Date
}) {
  await test.insert(apiRequestLogs).values({
    userId: input.userId,
    apiId: input.apiId,
    method: input.method ?? "GET",
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
  bob: { id: string }
  bobApi: string
  owner: { id: string }
}

async function buildWorld() {
  const alice = await insertUser()
  const bob = await insertUser()
  const owner = await insertUser("owner")
  const aliceApi = await insertApi(alice.id, "Alice roster")
  const bobApi = await insertApi(bob.id, "Bob roster")
  // Alice: two successes today, one failure outside the default analytics window.
  await insertLog({ userId: alice.id, apiId: aliceApi, statusCode: 200, createdAt: new Date(`${today()}T01:00:00.000Z`) })
  await insertLog({ userId: alice.id, apiId: aliceApi, statusCode: 204, createdAt: new Date(`${today()}T02:00:00.000Z`) })
  await insertLog({ userId: alice.id, apiId: aliceApi, statusCode: 500, createdAt: new Date(`${daysAgoText(40)}T03:00:00.000Z`) })
  await insertLog({ userId: bob.id, apiId: bobApi, statusCode: 404, createdAt: new Date(`${today()}T04:00:00.000Z`) })
  await insertLog({ userId: bob.id, apiId: bobApi, statusCode: 200, method: "POST", createdAt: new Date(`${today()}T05:00:00.000Z`) })
  return { alice, aliceApi, bob, bobApi, owner }
}

describe("GET /api/internal/logs", () => {
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
    routes = { logs: await import("@/app/api/internal/logs/route") }
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    world = await buildWorld()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  describe("session guard", () => {
    it("401 unauthenticated with no cookie, in the §4.4 auth envelope", async () => {
      const { response, body } = await get("/api/internal/logs")
      expect(response.status).toBe(401)
      expect(body).toEqual(UNAUTHENTICATED_BODY)
      expect(body.error.category).toBe("auth")
    })

    it("401 for a session whose row no longer exists", async () => {
      const gone = randomUUID()
      const { response } = await get("/api/internal/logs", cookieFor(gone))
      expect(response.status).toBe(401)
    })

    it("a plain user is accepted — this route is userRoute, not ownerRoute", async () => {
      const { response, body } = await get("/api/internal/logs", cookieFor(world.alice.id))
      expect(response.status).toBe(200)
      expect(Object.keys(body)).toEqual(["data"])
    })
  })

  describe("per-row authorization (§2 user: own; owner: all)", () => {
    it("a plain user's list contains only their own rows", async () => {
      const { body } = await get("/api/internal/logs", cookieFor(world.alice.id))
      expect(body.data.rows).toHaveLength(3)
      expect(body.data.total).toBe(3)
      for (const row of body.data.rows) expect(row.userId).toBe(world.alice.id)
    })

    it("the other user's id and rows never appear in the wire text", async () => {
      const response = await routes.logs.GET(requestFor("/api/internal/logs", cookieFor(world.alice.id)))
      const text = await response.text()
      expect(text).not.toContain(world.bob.id)
      expect(text).not.toContain(world.bobApi)
      expect(text).not.toContain("Bob roster")
    })

    it("a plain user's ?user_id= is ignored, not rejected: byte-identical to no parameter", async () => {
      const own = await routes.logs.GET(requestFor("/api/internal/logs", cookieFor(world.alice.id)))
      const ownText = await own.text()
      const probing = await routes.logs.GET(
        requestFor(`/api/internal/logs?user_id=${world.bob.id}`, cookieFor(world.alice.id))
      )
      expect(probing.status).toBe(200)
      expect(await probing.text()).toBe(ownText)
    })

    it("an owner sees every row and may narrow to one account", async () => {
      const all = await get("/api/internal/logs", cookieFor(world.owner.id, "owner"))
      expect(all.body.data.total).toBe(5)

      const narrowed = await get(
        `/api/internal/logs?user_id=${world.bob.id}`,
        cookieFor(world.owner.id, "owner")
      )
      expect(narrowed.body.data.total).toBe(2)
      for (const row of narrowed.body.data.rows) expect(row.userId).toBe(world.bob.id)
    })
  })

  describe("filters", () => {
    it("status=failed / status=success split on the 400 boundary", async () => {
      const failed = await get(`/api/internal/logs?status=failed`, cookieFor(world.alice.id))
      expect(failed.body.data.rows.map((r: { statusCode: number }) => r.statusCode)).toEqual([500])

      const success = await get(`/api/internal/logs?status=success`, cookieFor(world.alice.id))
      expect(success.body.data.total).toBe(2)
      for (const row of success.body.data.rows) expect(row.statusCode).toBeLessThan(400)
    })

    it("apiId and method narrow, and a foreign apiId answers an empty page", async () => {
      const byApi = await get(`/api/internal/logs?apiId=${world.aliceApi}`, cookieFor(world.alice.id))
      expect(byApi.body.data.total).toBe(3)

      const byMethod = await get(`/api/internal/logs?method=POST`, cookieFor(world.owner.id, "owner"))
      expect(byMethod.body.data.total).toBe(1)
      expect(byMethod.body.data.rows[0].method).toBe("POST")

      const foreign = await get(`/api/internal/logs?apiId=${world.bobApi}`, cookieFor(world.alice.id))
      expect(foreign.body.data).toEqual({ rows: [], total: 0, page: 1, perPage: 50 })
    })

    it("from/to name whole UTC days and both ends are inclusive", async () => {
      const only = await get(
        `/api/internal/logs?from=${today()}&to=${today()}`,
        cookieFor(world.alice.id)
      )
      expect(only.body.data.total).toBe(2)

      const windowed = await get(
        `/api/internal/logs?from=${daysAgoText(45)}&to=${daysAgoText(35)}`,
        cookieFor(world.alice.id)
      )
      expect(windowed.body.data.rows.map((r: { statusCode: number }) => r.statusCode)).toEqual([500])
    })

    it("an undeclared parameter is ignored rather than obeyed", async () => {
      const { response, body } = await get(
        `/api/internal/logs?limit=1&offset=99`,
        cookieFor(world.alice.id)
      )
      expect(response.status).toBe(200)
      expect(body.data.perPage).toBe(50)
      expect(body.data.rows).toHaveLength(3)
    })
  })

  describe("pagination", () => {
    it("page and per_page slice the same filter; total is the whole page count", async () => {
      const first = await get(`/api/internal/logs?page=1&per_page=2`, cookieFor(world.alice.id))
      const second = await get(`/api/internal/logs?page=2&per_page=2`, cookieFor(world.alice.id))
      const third = await get(`/api/internal/logs?page=3&per_page=2`, cookieFor(world.alice.id))

      expect(first.body.data.rows).toHaveLength(2)
      expect(second.body.data.rows).toHaveLength(1)
      expect(third.body.data).toEqual({ rows: [], total: 3, page: 3, perPage: 2 })
      expect(first.body.data.total).toBe(3)
      expect(second.body.data.total).toBe(3)

      const ids = [
        ...first.body.data.rows.map((r: { id: number }) => r.id),
        ...second.body.data.rows.map((r: { id: number }) => r.id),
      ]
      expect(new Set(ids).size).toBe(3)
      expect(first.body.data.page).toBe(1)
      expect(second.body.data.page).toBe(2)
    })

    it("newest first: descending id order is what the pages walk", async () => {
      const { body } = await get(`/api/internal/logs`, cookieFor(world.alice.id))
      const ids = body.data.rows.map((r: { id: number }) => r.id)
      expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a))
    })

    it("every bad parameter is a 400 that names the field, and never a 500", async () => {
      const cases: [string, string][] = [
        ["page=0", "page"],
        ["page=abc", "page"],
        ["page=1.5", "page"],
        ["per_page=0", "per_page"],
        ["per_page=201", "per_page"],
        ["method=TRACE", "method"],
        ["status=maybe", "status"],
        ["apiId=not-a-uuid", "apiId"],
        ["user_id=not-a-uuid", "user_id"],
        ["from=05/06/2024", "from"],
        ["from=2026-02-30", "from"],
        ["to=soon", "to"],
      ]
      for (const [params, field] of cases) {
        const { response, body } = await get(`/api/internal/logs?${params}`, cookieFor(world.alice.id))
        expect(response.status, params).toBe(400)
        expect(body.error.code, params).toBe("validation_failed")
        expect(body.error.category, params).toBe("validation")
        expect(Object.keys(body.error.fields), params).toEqual([field])
      }
    })

    it("a query error returns no rows at all", async () => {
      const { body } = await get(`/api/internal/logs?page=0`, cookieFor(world.alice.id))
      expect(body.data).toBeUndefined()
      expect("data" in body).toBe(false)
    })
  })

  describe("payload shape", () => {
    it("data is exactly { rows, total, page, perPage } and a row is exactly §4.6's LogRow", async () => {
      const { body } = await get("/api/internal/logs", cookieFor(world.alice.id))
      expect(Object.keys(body.data).sort()).toEqual(["page", "perPage", "rows", "total"])
      for (const row of body.data.rows) {
        expect(Object.keys(row).sort()).toEqual(LOG_ROW_KEYS)
      }
      expect(body.data.rows[0]).toMatchObject({
        method: "GET",
        apiId: world.aliceApi,
        requestBytes: null,
        apiKeyId: null,
      })
    })

    it("no key, token or hash material reaches the wire", async () => {
      const response = await routes.logs.GET(requestFor("/api/internal/logs", cookieFor(world.alice.id)))
      const text = await response.text()
      for (const needle of ["keyHash", "codeHash", "refresh_token", "sz_live_", "ZABER-", "c29tZS1j"]) {
        expect(text, needle).not.toContain(needle)
      }
    })
  })

  describe("method switch", () => {
    it("POST, PUT, PATCH and DELETE all answer 405 with Allow: GET", async () => {
      const cases: [string, () => Response][] = [
        ["POST", routes.logs.POST],
        ["PUT", routes.logs.PUT],
        ["PATCH", routes.logs.PATCH],
        ["DELETE", routes.logs.DELETE],
      ]
      for (const [name, handler] of cases) {
        const response = handler()
        expect(response.status, name).toBe(405)
        expect(response.headers.get("allow"), name).toBe("GET")
        expect(await response.json(), name).toEqual(METHOD_NOT_ALLOWED_BODY)
      }
    })
  })
})
