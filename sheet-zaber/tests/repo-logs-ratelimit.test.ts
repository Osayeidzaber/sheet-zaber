import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import {
  apiConfigurations,
  apiKeys,
  googleConnections,
  registeredSpreadsheets,
  users,
} from "@/server/db/schema"

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
 * Real PostgreSQL 16 (embedded-postgres) + the committed drizzle/ migrations: no mocks and
 * no skips. `tests/smoke.test.ts` pins the public contract of these two modules; this file
 * exercises it in isolation so the log/analytics/rate-limit surface can be verified on its
 * own. Prerequisite rows are seeded with RAW schema inserts, because the sibling query
 * modules are concurrent work and importing them would make this suite flaky.
 */

let test: TestDb
let repo: {
  logs: typeof import("@/server/db/queries/logs")
  rateLimit: typeof import("@/server/db/queries/rate-limit")
}

beforeAll(async () => {
  let url: string
  try {
    url = inject(TEST_DB_URL_KEY)
  } catch {
    await startTestDb()
    await migrateTestDb()
    url = getTestDbUrl()
  }
  // Production's lazy client reads env at first query, so the URL must be published
  // before the modules under test are imported.
  process.env.DATABASE_URL = url
  test = await getTestDb()
  repo = {
    logs: await import("@/server/db/queries/logs"),
    rateLimit: await import("@/server/db/queries/rate-limit"),
  }
}, 300_000)

beforeEach(async () => {
  await truncateAll()
})

afterAll(async () => {
  await stopTestDb()
})

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000)
}

async function seedUser(): Promise<{ id: string }> {
  const id = randomUUID()
  await test.insert(users).values({ id, googleSub: `sub-${id}`, email: `logs-${id}@example.com` })
  return { id }
}

type Graph = { apiId: string; apiKeyId: string; apiName: string }

async function seedGraph(userId: string, label: string): Promise<Graph> {
  const id = randomUUID()
  const [connection] = await test
    .insert(googleConnections)
    .values({
      id: `conn-${id}`,
      userId,
      googleEmail: `sheets-${label}@example.com`,
      refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
      scope: "openid email https://www.googleapis.com/auth/spreadsheets",
    })
    .returning()

  const [spreadsheet] = await test
    .insert(registeredSpreadsheets)
    .values({
      id: `sheet-${id}`,
      userId,
      connectionId: connection.id,
      googleSheetId: `google-sheet-${label}`,
      title: "Roster",
      tabs: [{ id: 0, title: "Sheet1", rows: 100, columns: 26 }],
    })
    .returning()

  const apiName = `Roster API ${label}`
  const [api] = await test
    .insert(apiConfigurations)
    .values({
      id,
      userId,
      spreadsheetId: spreadsheet.id,
      name: apiName,
      tabTitle: "Sheet1",
      headerRow: 1,
      permissions: "read",
      allowedOperations: ["GET"],
    })
    .returning()

  const [key] = await test
    .insert(apiKeys)
    .values({
      id: `key-${id}`,
      userId,
      name: `key-${label}`,
      keyHash: `kh-${id}`,
      keyPreview: "sz_live_ab12wxyz",
      scopes: ["read"],
      allowedApiIds: null,
      expiresAt: null,
    })
    .returning()

  return { apiId: api.id, apiKeyId: key.id, apiName: api.name }
}

/** Four 200 GETs plus one 500 POST, exactly the shape the committed contract seeds. */
async function seedFiveLogs(graph: Graph, userId: string) {
  for (let index = 0; index < 5; index += 1) {
    await repo.logs.insertRequestLog({
      apiId: graph.apiId,
      userId,
      apiKeyId: graph.apiKeyId,
      method: index === 4 ? "POST" : "GET",
      path: `/api/v1/${graph.apiId}`,
      statusCode: index === 4 ? 500 : 200,
      durationMs: 10 + index,
      requestBytes: index === 4 ? null : 42,
      errorCategory: index === 4 ? "internal" : null,
      origin: "https://sheet.zaber.tech",
    })
  }
}

async function seedAnonymous404() {
  await repo.logs.insertRequestLog({
    method: "GET",
    path: `/api/v1/${randomUUID()}`,
    statusCode: 404,
    durationMs: 3,
    errorCategory: "not_found",
  })
}

describe("insertRequestLog", () => {
  it("stores only metadata and returns the row with the Postgres identity PK", async () => {
    const userId = (await seedUser()).id
    const graph = await seedGraph(userId, "insert")

    const row = await repo.logs.insertRequestLog({
      apiId: graph.apiId,
      userId,
      apiKeyId: graph.apiKeyId,
      method: "GET",
      path: `/api/v1/${graph.apiId}/rows`,
      statusCode: 200,
      durationMs: 17,
      requestBytes: 42,
      origin: "https://sheet.zaber.tech",
    })

    expect(Number(row.id)).toBeGreaterThan(0)
    expect(row).toMatchObject({
      apiId: graph.apiId,
      userId,
      apiKeyId: graph.apiKeyId,
      method: "GET",
      statusCode: 200,
      durationMs: 17,
      requestBytes: 42,
      errorCategory: null,
      origin: "https://sheet.zaber.tech",
    })
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(Object.keys(row).sort()).toEqual(
      [
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
      ].sort()
    )

    const anonymous = await repo.logs.insertRequestLog({
      method: "GET",
      path: "/api/v1/unknown",
      statusCode: 404,
      durationMs: 3,
      errorCategory: "not_found",
    })
    expect(anonymous).toMatchObject({ apiId: null, userId: null, apiKeyId: null, requestBytes: null })
  })
})

describe("listRequestLogs", () => {
  it("returns newest-first pages with a stable total across every page", async () => {
    const userId = (await seedUser()).id
    const graph = await seedGraph(userId, "paging")
    await seedFiveLogs(graph, userId)
    await seedAnonymous404()

    const firstPage = await repo.logs.listRequestLogs({ userId, page: 1, perPage: 2 })
    expect(firstPage.total).toBe(5)
    expect(firstPage.rows).toHaveLength(2)
    expect(firstPage.rows[0].id).toBeGreaterThan(firstPage.rows[1].id)
    expect(firstPage.rows[0].createdAt).toBeInstanceOf(Date)
    expect(firstPage.rows[0].apiName).toBe(graph.apiName)

    const pages = await Promise.all(
      [1, 2, 3, 4].map((page) => repo.logs.listRequestLogs({ userId, page, perPage: 2 }))
    )
    expect(pages.map((page) => page.rows.length)).toEqual([2, 2, 1, 0])
    expect(new Set(pages.flatMap((page) => page.rows.map((row) => row.id))).size).toBe(5)
    expect(pages.every((page) => page.total === 5)).toBe(true)

    const ids = pages.flatMap((page) => page.rows.map((row) => row.id))
    expect(ids).toEqual([...ids].sort((a, b) => b - a))
  })

  it("filters by method, status, apiId and created_at range", async () => {
    const userId = (await seedUser()).id
    const graph = await seedGraph(userId, "filters")
    await seedFiveLogs(graph, userId)
    await seedAnonymous404()

    const posted = await repo.logs.listRequestLogs({ userId, method: "POST", page: 1, perPage: 10 })
    expect(posted.rows).toHaveLength(1)
    expect(posted.rows[0].statusCode).toBe(500)
    expect(posted.rows[0].errorCategory).toBe("internal")

    const failed = await repo.logs.listRequestLogs({ userId, status: "failed", page: 1, perPage: 10 })
    expect(failed.total).toBe(1)
    const success = await repo.logs.listRequestLogs({ userId, status: "success", page: 1, perPage: 10 })
    expect(success.total).toBe(4)

    const scoped = await repo.logs.listRequestLogs({
      userId,
      apiId: graph.apiId,
      status: "success",
      from: daysFromNow(-1),
      to: daysFromNow(1),
      page: 1,
      perPage: 10,
    })
    expect(scoped).toMatchObject({ total: 4 })
    expect(scoped.rows).toHaveLength(4)

    expect(
      (await repo.logs.listRequestLogs({ userId, apiId: randomUUID(), page: 1, perPage: 10 })).total
    ).toBe(0)
    expect(
      (await repo.logs.listRequestLogs({ userId, from: daysFromNow(1), to: daysFromNow(2), page: 1, perPage: 10 }))
        .rows
    ).toHaveLength(0)
    expect((await repo.logs.listRequestLogs({ userId, method: "DELETE", page: 1, perPage: 10 })).rows).toHaveLength(0)
  })

  it("keeps an unscoped page readable and marks a log whose API is unknown as apiName null", async () => {
    const userId = (await seedUser()).id
    const graph = await seedGraph(userId, "joined")
    await seedFiveLogs(graph, userId)
    const anonymous = await repo.logs.insertRequestLog({
      method: "GET",
      path: "/api/v1/none",
      statusCode: 404,
      durationMs: 3,
      errorCategory: "not_found",
    })

    const all = await repo.logs.listRequestLogs({ page: 1, perPage: 20 })
    expect(all.total).toBe(6)
    const missing = all.rows.find((row) => row.id === anonymous.id)
    expect(missing).toMatchObject({ apiName: null, userId: null })
  })
})

describe("analyticsOverview", () => {
  it("agrees with the rows it wrote and with analyticsByApi", async () => {
    const alice = await seedUser()
    const bob = await seedUser()
    const graph = await seedGraph(alice.id, "analytics")
    await seedFiveLogs(graph, alice.id)
    await seedAnonymous404()

    const overview = await repo.logs.analyticsOverview(alice.id, daysFromNow(-1), daysFromNow(1))
    expect(overview).toMatchObject({ requests: 5, success: 4, failed: 1 })
    expect(overview.success + overview.failed).toBe(overview.requests)
    expect(overview.byDay.length).toBeGreaterThan(0)
    expect(overview.byDay.reduce((sum, day) => sum + day.count, 0)).toBe(overview.requests)
    for (const day of overview.byDay) expect(day.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(overview.byDay.map((day) => day.day)).toEqual([...overview.byDay.map((day) => day.day)].sort())

    const [byApi] = await repo.logs.analyticsByApi(alice.id)
    expect(byApi).toMatchObject({ count: overview.requests, errors: overview.failed })

    expect(
      (await repo.logs.analyticsOverview(alice.id, daysFromNow(1), daysFromNow(2))).requests
    ).toBe(0)
    expect((await repo.logs.analyticsOverview(bob.id, daysFromNow(-1), daysFromNow(1))).requests).toBe(0)
  })

  it("scopes every aggregate to the user and the requested range", async () => {
    const alice = await seedUser()
    const bob = await seedUser()
    const graph = await seedGraph(alice.id, "scoped")
    await seedFiveLogs(graph, alice.id)
    for (let index = 0; index < 3; index += 1) {
      await repo.logs.insertRequestLog({
        apiId: graph.apiId,
        userId: bob.id,
        method: "GET",
        path: `/api/v1/${graph.apiId}`,
        statusCode: index === 2 ? 429 : 200,
        durationMs: 4,
      })
    }

    const aliceView = await repo.logs.analyticsOverview(alice.id, daysFromNow(-1), daysFromNow(1))
    const bobView = await repo.logs.analyticsOverview(bob.id, daysFromNow(-1), daysFromNow(1))
    expect(aliceView.requests).toBe(5)
    expect(bobView).toMatchObject({ requests: 3, success: 2, failed: 1 })

    const narrow = await repo.logs.analyticsOverview(alice.id, daysFromNow(-0.5), new Date())
    expect(narrow.requests).toBe(5)
    expect(narrow.byDay.reduce((sum, day) => sum + day.count, 0)).toBe(narrow.requests)
  })
})

describe("analyticsByApi", () => {
  it("returns exactly apiId/name/count/errors per API with logs", async () => {
    const alice = await seedUser()
    const graph = await seedGraph(alice.id, "analytics")
    await seedFiveLogs(graph, alice.id)
    await seedAnonymous404()

    expect(await repo.logs.analyticsByApi(alice.id)).toEqual([
      { apiId: graph.apiId, name: "Roster API analytics", count: 5, errors: 1 },
    ])

    const bob = await seedUser()
    expect(await repo.logs.analyticsByApi(bob.id)).toEqual([])

    const second = await seedGraph(alice.id, "second")
    await repo.logs.insertRequestLog({
      apiId: second.apiId,
      userId: alice.id,
      method: "GET",
      path: `/api/v1/${second.apiId}`,
      statusCode: 200,
      durationMs: 2,
    })
    const rows = await repo.logs.analyticsByApi(alice.id)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.count)).toEqual([5, 1])
    expect(rows.map((row) => row.errors)).toEqual([1, 0])
  })
})

describe("pruneOldLogs", () => {
  it("deletes only rows past the retention window", async () => {
    const alice = await seedUser()
    const graph = await seedGraph(alice.id, "retention")
    await seedFiveLogs(graph, alice.id)
    await seedAnonymous404()

    const pool = await getTestPool()
    await pool.query(
      `INSERT INTO api_request_logs (method, path, status_code, duration_ms, user_id, created_at)
       VALUES ('GET', '/api/v1/ancient', 200, 1, $1, now() - interval '200 days')`,
      [alice.id]
    )
    // The range-bounded view never saw the ancient row; the unbounded list did (5 + 1).
    expect(
      (await repo.logs.analyticsOverview(alice.id, daysFromNow(-30), daysFromNow(1))).requests
    ).toBe(5)
    expect((await repo.logs.listRequestLogs({ userId: alice.id, page: 1, perPage: 50 })).total).toBe(6)

    expect(await repo.logs.pruneOldLogs(90)).toBe(1)
    expect((await repo.logs.listRequestLogs({ userId: alice.id, page: 1, perPage: 50 })).total).toBe(5)
    expect((await repo.logs.listRequestLogs({ page: 1, perPage: 50 })).total).toBe(6)

    const ancient = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM api_request_logs WHERE created_at < now() - interval '90 days'`
    )
    expect(ancient.rows[0].n).toBe(0)
  })
})

describe("consumeRateBucket", () => {
  it("allows N per window, then denies with a bounded retry-after", async () => {
    const bucketKey = `key:${randomUUID()}:h`

    expect(await repo.rateLimit.consumeRateBucket(bucketKey, 60, 2)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 0,
    })
    const second = await repo.rateLimit.consumeRateBucket(bucketKey, 60, 2)
    expect(second).toMatchObject({ allowed: true, remaining: 0, retryAfterSeconds: 0 })

    const third = await repo.rateLimit.consumeRateBucket(bucketKey, 60, 2)
    expect(third.allowed).toBe(false)
    expect(third.remaining).toBe(0)
    expect(third.retryAfterSeconds).toBeGreaterThan(0)
    expect(third.retryAfterSeconds).toBeLessThanOrEqual(60)

    expect((await repo.rateLimit.consumeRateBucket(`api:${randomUUID()}:d`, 60, 1)).allowed).toBe(true)
  })

  it("keeps counting while denied and never reports a negative remaining", async () => {
    const bucketKey = `ip:${randomUUID()}:m`
    for (let index = 0; index < 4; index += 1) {
      const result = await repo.rateLimit.consumeRateBucket(bucketKey, 60, 1)
      expect(result.allowed).toBe(index === 0)
      expect(result.remaining).toBe(0)
    }

    const pool = await getTestPool()
    const bucket = await pool.query<{ count: number }>(
      `SELECT count FROM rate_limit_buckets WHERE bucket_key = $1`,
      [bucketKey]
    )
    expect(bucket.rows[0].count).toBe(4)
  })

  it("resets the window once it has elapsed", async () => {
    const rolling = `key:${randomUUID()}:s`
    expect((await repo.rateLimit.consumeRateBucket(rolling, 1, 1)).allowed).toBe(true)
    expect((await repo.rateLimit.consumeRateBucket(rolling, 1, 1)).allowed).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(await repo.rateLimit.consumeRateBucket(rolling, 1, 1)).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 0,
    })
  })

  it("serialises concurrent consumes on one key and keeps fresh keys independent", async () => {
    const bucketKey = `key:${randomUUID()}:h`
    const results = await Promise.all(
      Array.from({ length: 6 }, () => repo.rateLimit.consumeRateBucket(bucketKey, 60, 2))
    )
    expect(results.filter((result) => result.allowed)).toHaveLength(2)

    const other = await Promise.all(
      Array.from({ length: 3 }, () => repo.rateLimit.consumeRateBucket(`api:${randomUUID()}:h`, 60, 2))
    )
    expect(other.every((result) => result.allowed)).toBe(true)
  })
})

describe("optional transaction client", () => {
  it("runs both modules through a caller's transaction, commit and rollback", async () => {
    const alice = await seedUser()
    const graph = await seedGraph(alice.id, "transaction")

    await test.transaction(async (tx) => {
      await repo.logs.insertRequestLog(
        {
          apiId: graph.apiId,
          userId: alice.id,
          apiKeyId: graph.apiKeyId,
          method: "GET",
          path: `/api/v1/${graph.apiId}`,
          statusCode: 200,
          durationMs: 8,
        },
        tx
      )
      expect((await repo.logs.listRequestLogs({ userId: alice.id, page: 1, perPage: 10 }, tx)).total).toBe(1)
      expect((await repo.logs.analyticsOverview(alice.id, daysFromNow(-1), daysFromNow(1), tx)).requests).toBe(1)
      expect((await repo.rateLimit.consumeRateBucket(`key:${randomUUID()}:h`, 60, 1, tx)).allowed).toBe(true)
      expect(await repo.logs.pruneOldLogs(90, tx)).toBe(0)
    })

    expect((await repo.logs.listRequestLogs({ userId: alice.id, page: 1, perPage: 10 })).total).toBe(1)

    await expect(
      test.transaction(async (tx) => {
        await repo.logs.insertRequestLog(
          {
            apiId: graph.apiId,
            userId: alice.id,
            method: "GET",
            path: `/api/v1/${graph.apiId}`,
            statusCode: 500,
            durationMs: 9,
            errorCategory: "internal",
          },
          tx
        )
        throw new Error("rollback")
      })
    ).rejects.toThrow("rollback")

    expect((await repo.logs.listRequestLogs({ userId: alice.id, page: 1, perPage: 10 })).total).toBe(1)
  })
})
