import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import {
  apiConfigurations,
  apiKeys,
  apiRequestLogs,
  auditLogs,
  googleConnections,
  invitationRedemptions,
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
 * The internal logs/analytics + admin JSON surface, driven the way Next drives it: a real signed
 * session cookie on a real Request, through the exported handlers of the route files
 * (`tests/guards.test.ts` mints the cookie the same way). Nothing is mocked, because every claim
 * below is a property of the SQL and of the guard:
 *
 *   - a `user` session cannot read another account's rows, even when it asks for them by id;
 *   - a bad parameter is a 400 carrying `fields`, never a 500 and never a silently widened window;
 *   - the three admin routes are 401 without a session and 403 with a non-owner session;
 *   - a stored `code_hash` appears nowhere in a response body;
 *   - a success body is exactly `{ data: … }`.
 */

type Json = Record<string, unknown>
type UserRow = typeof users.$inferSelect
type Session = "owner" | "alice" | "bob"
type Route = { GET: (req: Request) => Promise<Response>; POST: () => Response }

let test: TestDb
let session: typeof import("@/server/auth/session")
let platform: typeof import("@/server/db/queries/platform-stats")
let routes: Record<
  "logs" | "overview" | "apis" | "adminUsers" | "adminInvitations" | "adminAnalytics",
  Route
>
let cookies: Record<Session, string>
let ids: Record<Session, string>

beforeAll(async () => {
  let url: string
  try {
    url = inject(TEST_DB_URL_KEY)
  } catch {
    await startTestDb()
    await migrateTestDb()
    url = getTestDbUrl()
  }
  // Production's lazy client binds its pool to `env.DATABASE_URL` at first query, so the URL is
  // repointed at the test instance before the modules under test are imported.
  process.env.DATABASE_URL = url
  test = await getTestDb()

  const [sessionModule, platformModule, logsRoute, overviewRoute, apisRoute, usersRoute, invitesRoute, analyticsRoute] =
    await Promise.all([
      import("@/server/auth/session"),
      import("@/server/db/queries/platform-stats"),
      import("@/app/api/internal/logs/route"),
      import("@/app/api/internal/analytics/overview/route"),
      import("@/app/api/internal/analytics/apis/route"),
      import("@/app/api/internal/admin/users/route"),
      import("@/app/api/internal/admin/invitations/route"),
      import("@/app/api/internal/admin/analytics/route"),
    ])
  session = sessionModule
  platform = platformModule
  routes = {
    logs: logsRoute as Route,
    overview: overviewRoute as Route,
    apis: apisRoute as Route,
    adminUsers: usersRoute as Route,
    adminInvitations: invitesRoute as unknown as Route,
    adminAnalytics: analyticsRoute as Route,
  }
}, 300_000)

beforeEach(async () => {
  await truncateAll()
  ids = { owner: "", alice: "", bob: "" } as Record<Session, string>
  const owner = await insertUser("owner")
  const alice = await insertUser("user")
  const bob = await insertUser("user")
  ids = { owner: owner.id, alice: alice.id, bob: bob.id }
  // The signed role is honest here, but the guard re-reads `users.role` anyway (§4.2).
  cookies = {
    owner: signed(owner, "owner"),
    alice: signed(alice, "user"),
    bob: signed(bob, "user"),
  }
})

afterAll(async () => {
  await stopTestDb()
})

/* ------------------------------------------------------------------ harness */

async function insertUser(role: "user" | "owner"): Promise<UserRow> {
  const id = randomUUID()
  const [row] = await test
    .insert(users)
    .values({
      id,
      googleSub: `internal-sub-${id}`,
      email: `internal-${role}-${id}@example.com`,
      role,
      status: "active",
    })
    .returning()
  return row
}

function signed(row: UserRow, role: "user" | "owner"): string {
  return session.signSession({ uid: row.id, role, exp: Math.floor(Date.now() / 1000) + 3600 })
}

function get(path: string, cookie?: string): Request {
  const headers = new Headers()
  if (cookie !== undefined) headers.set("cookie", `${session.SESSION_COOKIE}=${cookie}`)
  return new Request(`http://localhost:3001${path}`, { headers })
}

async function send(route: Route, path: string, who?: Session): Promise<{ status: number; body: Json }> {
  const response = await route.GET(get(path, who === undefined ? undefined : cookies[who]))
  return { status: response.status, body: (await response.json()) as Json }
}

/** A success body is EXACTLY `{ data: … }`; anything else fails here, loudly. */
function dataOf(body: Json): Json {
  expect(Object.keys(body)).toEqual(["data"])
  return json(body.data)
}

function errorOf(body: Json): Json {
  expect(Object.keys(body)).toEqual(["error"])
  return json(body.error)
}

/** The list-shaped success body (`data: [...]`), still asserted to be exactly `{ data: … }`. */
function dataListOf(body: Json): unknown[] {
  expect(Object.keys(body)).toEqual(["data"])
  return list(body.data)
}

function json(value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, got ${JSON.stringify(value)}`)
  }
  return value as Json
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected an array, got ${JSON.stringify(value)}`)
  return value
}

/** A `users` row that owns a connection, a spreadsheet, an API and a key. */
async function seedGraph(userId: string, label: string) {
  const id = randomUUID()
  const [connection] = await test
    .insert(googleConnections)
    .values({
      id: `conn-${id}`,
      userId,
      googleEmail: `internal-${label}@example.com`,
      refreshTokenEnc: "Y2lwaGVyLW5vdC1hLXRva2Vu",
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
  const [api] = await test
    .insert(apiConfigurations)
    .values({
      id,
      userId,
      spreadsheetId: spreadsheet.id,
      name: `Internal API ${label}`,
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
    })
    .returning()
  return { apiId: api.id, apiKeyId: key.id, apiName: api.name }
}

/** Rows are inserted directly so a back-dated one can be placed without a retention hack. */
async function log(input: {
  userId?: string
  apiId?: string
  apiKeyId?: string
  method?: string
  statusCode?: number
  daysAgo?: number
}): Promise<void> {
  const statusCode = input.statusCode ?? 200
  await test.insert(apiRequestLogs).values({
    userId: input.userId ?? null,
    apiId: input.apiId ?? null,
    // What `insertRequestLog` snapshots at write time.
    apiName: input.apiId ? sql`(select name from api_configurations where id = ${input.apiId})` : null,
    apiKeyId: input.apiKeyId ?? null,
    method: input.method ?? "GET",
    path: `/api/v1/${input.apiId ?? "unknown"}`,
    statusCode,
    durationMs: 7,
    requestBytes: null,
    errorCategory: statusCode >= 400 ? "internal" : null,
    origin: "https://sheet.zaber.tech",
    createdAt: new Date(Date.now() - (input.daysAgo ?? 0) * 86_400_000),
  })
}

/** `YYYY-MM-DD` in UTC, `offset` days from today — the shape `from`/`to` accept. */
function utcDay(offset: number): string {
  const shifted = new Date(Date.now() + offset * 86_400_000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0")
  const day = String(shifted.getUTCDate()).padStart(2, "0")
  return `${shifted.getUTCFullYear()}-${month}-${day}`
}

/* -------------------------------------------------------------------- /logs */

describe("GET /api/internal/logs", () => {
  it("gives a user its own rows only, even when it asks for another account by id", async () => {
    const aliceGraph = await seedGraph(ids.alice, "alice")
    const bobGraph = await seedGraph(ids.bob, "bob")
    await log({ userId: ids.alice, apiId: aliceGraph.apiId, apiKeyId: aliceGraph.apiKeyId })
    await log({ userId: ids.bob, apiId: bobGraph.apiId, apiKeyId: bobGraph.apiKeyId })
    await log({ userId: ids.bob, apiId: bobGraph.apiId, statusCode: 500 })

    const own = await send(routes.logs, "/api/internal/logs", "alice")
    expect(own.status).toBe(200)
    const page = dataOf(own.body)
    expect(page.total).toBe(1)
    expect(list(page.rows).map((row) => json(row).userId)).toEqual([ids.alice])

    // The hostile query: same session, Bob's id in the query string. Ignored, not refused, and the
    // answer is byte-identical to the innocent one — so the route is not an oracle over ids.
    const peek = await send(routes.logs, `/api/internal/logs?user_id=${ids.bob}`, "alice")
    expect(peek.status).toBe(200)
    expect(JSON.stringify(peek.body)).toBe(JSON.stringify(own.body))
    expect(JSON.stringify(peek.body)).not.toContain(ids.bob)
  })

  it("shows an owner every account and narrows on request", async () => {
    const aliceGraph = await seedGraph(ids.alice, "alice")
    const bobGraph = await seedGraph(ids.bob, "bob")
    await log({ userId: ids.alice, apiId: aliceGraph.apiId })
    for (let index = 0; index < 3; index += 1) {
      await log({ userId: ids.bob, apiId: bobGraph.apiId, statusCode: index === 2 ? 500 : 200 })
    }
    await log({}) // an anonymous 404-on-unknown-api row belongs to no account

    const all = dataOf((await send(routes.logs, "/api/internal/logs", "owner")).body)
    expect(all.total).toBe(5)
    expect(new Set(list(all.rows).map((row) => json(row).userId))).toEqual(
      new Set([ids.alice, ids.bob, null])
    )

    const narrowed = dataOf(
      (await send(routes.logs, `/api/internal/logs?user_id=${ids.bob}`, "owner")).body
    )
    expect(narrowed.total).toBe(3)
    expect(list(narrowed.rows).every((row) => json(row).userId === ids.bob)).toBe(true)

    const filtered = dataOf(
      (
        await send(
          routes.logs,
          `/api/internal/logs?user_id=${ids.bob}&status=failed&method=GET`,
          "owner"
        )
      ).body
    )
    expect(filtered.total).toBe(1)
    expect(json(list(filtered.rows)[0])).toMatchObject({
      statusCode: 500,
      userId: ids.bob,
      errorCategory: "internal",
      apiName: bobGraph.apiName,
    })
  })

  it("filters by apiId, by an inclusive day window, and by page", async () => {
    const graph = await seedGraph(ids.alice, "paging")
    const other = await seedGraph(ids.alice, "other")
    for (let index = 0; index < 4; index += 1) await log({ userId: ids.alice, apiId: graph.apiId })
    await log({ userId: ids.alice, apiId: other.apiId })

    const byApi = dataOf(
      (await send(routes.logs, `/api/internal/logs?apiId=${graph.apiId}`, "alice")).body
    )
    expect(byApi).toMatchObject({ total: 4, page: 1 })
    expect(list(byApi.rows).every((row) => json(row).apiId === graph.apiId)).toBe(true)
    expect(json(list(byApi.rows)[0]).apiName).toBe(graph.apiName)

    const second = dataOf((await send(routes.logs, "/api/internal/logs?page=2&per_page=2", "alice")).body)
    expect(second).toMatchObject({ total: 5, page: 2, perPage: 2 })
    expect(list(second.rows)).toHaveLength(2)

    const today = utcDay(0)
    expect(
      dataOf((await send(routes.logs, `/api/internal/logs?from=${today}&to=${today}`, "alice")).body).total
    ).toBe(5)

    const future = dataOf(
      (await send(routes.logs, `/api/internal/logs?from=${utcDay(5)}&to=${utcDay(6)}`, "alice")).body
    )
    expect(future).toMatchObject({ total: 0, rows: [] })

    // Bob has none of these rows.
    expect(dataOf((await send(routes.logs, "/api/internal/logs", "bob")).body).total).toBe(0)
  })

  it("answers every bad parameter with a 400 naming the field, never a 500", async () => {
    const cases: [string, string][] = [
      ["page=0", "page"],
      ["page=-3", "page"],
      ["page=1.5", "page"],
      ["page=abc", "page"],
      ["per_page=0", "per_page"],
      ["per_page=201", "per_page"],
      ["per_page=nope", "per_page"],
      ["method=TRACE", "method"],
      ["method=get", "method"],
      ["status=partial", "status"],
      ["from=29days-ago", "from"],
      ["from=2026-02-30", "from"],
      ["to=soon", "to"],
      ["apiId=not-a-uuid", "apiId"],
      ["user_id=nope", "user_id"],
    ]

    for (const [query, field] of cases) {
      const response = await routes.logs.GET(get(`/api/internal/logs?${query}`, cookies.owner))
      expect(response.status, query).toBe(400)
      const failure = errorOf((await response.json()) as Json)
      expect(failure.code, query).toBe("validation_failed")
      expect(failure.category, query).toBe("validation")
      expect(Object.keys(json(failure.fields)), query).toContain(field)
      // A message is user-safe: no SQL, no stack, no other user's data.
      expect(JSON.stringify(failure).toLowerCase(), query).not.toContain("select")
    }

    // An unknown parameter is not an error: the page stays linkable as the UI adds controls.
    const extra = await routes.logs.GET(get("/api/internal/logs?widgets=3", cookies.owner))
    expect(extra.status).toBe(200)
    expect(dataOf((await extra.json()) as Json).total).toBe(0)

    // A filter that simply matches nothing is an empty page, not a refusal.
    const missing = dataOf(
      (await send(routes.logs, `/api/internal/logs?apiId=${randomUUID()}`, "owner")).body
    )
    expect(missing).toMatchObject({ total: 0, rows: [] })
  })

  it("is 405 for a non-GET and 401 without a session", async () => {
    const wrongMethod = routes.logs.POST()
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("GET")

    const anonymous = await routes.logs.GET(get("/api/internal/logs"))
    expect(anonymous.status).toBe(401)
    expect(errorOf((await anonymous.json()) as Json)).toMatchObject({
      code: "unauthenticated",
      category: "auth",
    })
  })
})

/* ------------------------------------------------------- analytics/* */

describe("GET /api/internal/analytics/overview", () => {
  it("defaults to the last 30 days and honors an explicit wider window", async () => {
    const graph = await seedGraph(ids.alice, "window")
    await log({ userId: ids.alice, apiId: graph.apiId })
    await log({ userId: ids.alice, apiId: graph.apiId, statusCode: 500 })
    await log({ userId: ids.alice, apiId: graph.apiId, daysAgo: 40 })

    const wide = dataOf((await send(routes.overview, "/api/internal/analytics/overview", "alice")).body)
    expect(wide).toMatchObject({ requests: 2, success: 1, failed: 1 })
    expect(
      list(wide.byDay).reduce((sum: number, day: unknown) => sum + Number(json(day).count), 0)
    ).toBe(2)

    const explicit = dataOf(
      (
        await send(
          routes.overview,
          `/api/internal/analytics/overview?from=${new Date(Date.now() - 45 * 86_400_000).toISOString()}`,
          "alice"
        )
      ).body
    )
    expect(explicit.requests).toBe(3)

    const narrow = dataOf(
      (await send(routes.overview, `/api/internal/analytics/overview?from=${utcDay(10)}`, "alice")).body
    )
    expect(narrow).toMatchObject({ requests: 0, success: 0, failed: 0, byDay: [] })
  })

  it("keeps an owner's platform-wide totals separate from a narrowed one", async () => {
    const aliceGraph = await seedGraph(ids.alice, "a")
    const bobGraph = await seedGraph(ids.bob, "b")
    await log({ userId: ids.alice, apiId: aliceGraph.apiId })
    await log({ userId: ids.bob, apiId: bobGraph.apiId })
    await log({ userId: ids.bob, apiId: bobGraph.apiId })

    const platformView = dataOf((await send(routes.overview, "/api/internal/analytics/overview", "owner")).body)
    expect(platformView.requests).toBe(3)

    const narrowed = dataOf(
      (await send(routes.overview, `/api/internal/analytics/overview?user_id=${ids.bob}`, "owner")).body
    )
    expect(narrowed.requests).toBe(2)

    // A `user` asking for the platform total still only gets its own.
    const ownView = dataOf(
      (await send(routes.overview, `/api/internal/analytics/overview?user_id=${ids.bob}`, "alice")).body
    )
    expect(ownView.requests).toBe(1)
  })

  it("validates its dates and narrowing id the same way: 400 with fields, never 500", async () => {
    for (const query of ["from=yesterday", "to=2026-13-45", "user_id=3"]) {
      const response = await routes.overview.GET(
        get(`/api/internal/analytics/overview?${query}`, cookies.owner)
      )
      expect(response.status, query).toBe(400)
      expect(errorOf((await response.json()) as Json).code).toBe("validation_failed")
    }
  })
})

describe("GET /api/internal/analytics/apis", () => {
  it("lists exactly apiId/name/count/errors, scoped to the session", async () => {
    const aliceGraph = await seedGraph(ids.alice, "alice")
    const bobGraph = await seedGraph(ids.bob, "bob")
    await log({ userId: ids.alice, apiId: aliceGraph.apiId })
    await log({ userId: ids.alice, apiId: aliceGraph.apiId, statusCode: 503, method: "POST" })
    await log({ userId: ids.bob, apiId: bobGraph.apiId })

    const rows = dataListOf((await send(routes.apis, "/api/internal/analytics/apis", "alice")).body)
    expect(Object.keys(json(rows[0])).sort()).toEqual(["apiId", "count", "errors", "name"])
    expect(json(rows[0])).toMatchObject({
      apiId: aliceGraph.apiId,
      name: aliceGraph.apiName,
      count: 2,
      errors: 1,
    })

    expect(dataListOf((await send(routes.apis, "/api/internal/analytics/apis", "owner")).body)).toHaveLength(2)

    const bobView = dataListOf((await send(routes.apis, "/api/internal/analytics/apis", "bob")).body)
    expect(bobView).toHaveLength(1)
    expect(json(bobView[0]).apiId).toBe(bobGraph.apiId)
  })

  it("returns an empty array rather than a fabricated row when nothing has run", async () => {
    const body = (await send(routes.apis, "/api/internal/analytics/apis", "alice")).body
    expect(Object.keys(body)).toEqual(["data"])
    expect(body.data).toEqual([])
  })
})

/* ---------------------------------------------------------------- admin/* */

describe("the owner-only admin routes", () => {
  function adminRoutes(): [string, Route][] {
    return [
      ["/api/internal/admin/users", routes.adminUsers],
      ["/api/internal/admin/invitations", routes.adminInvitations],
      ["/api/internal/admin/analytics", routes.adminAnalytics],
    ]
  }

  it("answers 401 with no cookie, 403 with a user-role session, 405 with a write method", async () => {
    for (const [path, route] of adminRoutes()) {
      const anonymous = await route.GET(get(path))
      expect(anonymous.status, path).toBe(401)
      expect(errorOf((await anonymous.json()) as Json)).toMatchObject({
        code: "unauthenticated",
        category: "auth",
      })

      const forbidden = await route.GET(get(path, cookies.alice))
      expect(forbidden.status, path).toBe(403)
      expect(errorOf((await forbidden.json()) as Json)).toMatchObject({
        code: "forbidden",
        category: "auth",
      })

      // Admin invitations takes POST (invite by email), so it has no write 405 to assert here.
      if (path.endsWith("/admin/invitations")) continue
      const wrongMethod = route.POST()
      expect(wrongMethod.status, path).toBe(405)
      expect(wrongMethod.headers.get("allow")).toBe("GET")
    }

    // A 401/403 is not a mutation: nothing was written, not even an audit row.
    expect(await test.select().from(auditLogs)).toHaveLength(0)
  })
})

describe("GET /api/internal/admin/users", () => {
  it("pages the §4.6 AdminUserRow projection, with request totals and no google_sub", async () => {
    const graph = await seedGraph(ids.alice, "counts")
    await log({ userId: ids.alice, apiId: graph.apiId })
    await log({ userId: ids.alice, apiId: graph.apiId, statusCode: 404 })

    const page = dataOf((await send(routes.adminUsers, "/api/internal/admin/users", "owner")).body)
    expect(page).toMatchObject({ total: 3, page: 1, perPage: 50 })
    expect(list(page.rows)).toHaveLength(3)

    for (const row of list(page.rows)) {
      expect(Object.keys(json(row)).sort()).toEqual(
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
    }

    const aliceRow = json(list(page.rows).find((row) => json(row).id === ids.alice))
    expect(aliceRow).toMatchObject({ apiCount: 1, requestTotal: 2, role: "user", status: "active" })

    const wire = JSON.stringify(page)
    for (const banned of ["googleSub", "google_sub", "codeHash", "code_hash", "refreshTokenEnc", "internal-sub-"]) {
      expect(wire, banned).not.toContain(banned)
    }

    const second = dataOf(
      (await send(routes.adminUsers, "/api/internal/admin/users?page=2&per_page=2", "owner")).body
    )
    expect(second).toMatchObject({ total: 3, page: 2, perPage: 2 })
    expect(list(second.rows)).toHaveLength(1)
  })

  it("validates its paging parameters as 400s", async () => {
    for (const query of ["page=0", "per_page=0", "per_page=201", "page=two"]) {
      const response = await routes.adminUsers.GET(get(`/api/internal/admin/users?${query}`, cookies.owner))
      expect(response.status, query).toBe(400)
      expect(errorOf((await response.json()) as Json).code).toBe("validation_failed")
    }
  })
})

describe("GET /api/internal/admin/invitations", () => {
  it("lists the invitation rows with neither a plaintext code nor a stored code_hash", async () => {
    // Distinctive 64-hex `code_hash` values, the shape a real SHA-256 digest has.
    const activeHash = "a".repeat(64)
    const revokedHash = "b".repeat(64)

    const [live] = await test
      .insert(invitations)
      .values({
        id: randomUUID(),
        codeHash: activeHash,
        label: "Team onboarding",
        maxUses: 2,
        uses: 1,
        createdBy: ids.owner,
      })
      .returning()
    const [revoked] = await test
      .insert(invitations)
      .values({
        id: randomUUID(),
        codeHash: revokedHash,
        label: null,
        maxUses: 1,
        uses: 0,
        revokedAt: new Date(),
        createdBy: ids.owner,
      })
      .returning()
    await test
      .insert(invitationRedemptions)
      .values({ id: randomUUID(), invitationId: live.id, redeemedBy: ids.alice })

    const response = await send(routes.adminInvitations, "/api/internal/admin/invitations", "owner")
    expect(response.status).toBe(200)
    const wire = JSON.stringify(response.body)

    // The hash the test planted must be nowhere in the body, and no field may be named after a code.
    for (const banned of [activeHash, revokedHash, "codeHash", "code_hash", '"code"']) {
      expect(wire, banned).not.toContain(banned)
    }

    const rows = dataListOf(response.body)
    expect(rows).toHaveLength(2)
    // Rows are ordered by `created_at DESC`, which is a tie for two inserts in the same
    // millisecond, so the claims are made by id, not by position.
    const byId = new Map(rows.map((row) => [json(row).id, json(row)]))
    expect(byId.get(live.id)).toMatchObject({
      label: "Team onboarding",
      maxUses: 2,
      uses: 1,
      createdBy: ids.owner,
    })
    expect(byId.get(revoked.id)?.revokedAt).not.toBeNull()
    // §4.5's admin payload: the eight stored columns plus the two derived members. `status` comes
    // from revoked_at / expires_at / uses vs max_uses, `redemptions` from the
    // `invitation_redemptions` → `users.email` join §2 asks for — the UI cannot derive either.
    const publicKeys = [
      "createdAt",
      "createdBy",
      "expiresAt",
      "id",
      "label",
      "maxUses",
      "redemptions",
      "revokedAt",
      "status",
      "uses",
    ]
    for (const row of rows) expect(Object.keys(json(row)).sort()).toEqual(publicKeys)
    expect(json(byId.get(live.id)).status).toBe("active")
    expect(json(byId.get(revoked.id)).status).toBe("revoked")
    expect(json(byId.get(live.id)).redemptions).toEqual([
      {
        redeemedBy: ids.alice,
        // The seeded alice row is `internal-user-<uuid>@example.com` (`insertUser`, :114).
        email: expect.stringMatching(/^internal-user-/),
        redeemedAt: expect.any(String),
      },
    ])
    expect(json(byId.get(revoked.id)).redemptions).toEqual([])
  })
})

describe("GET /api/internal/admin/analytics", () => {
  it("reads the tile from real counts, with the error rate as failed / total", async () => {
    const graph = await seedGraph(ids.alice, "tile")
    await log({ userId: ids.alice, apiId: graph.apiId })
    await log({ userId: ids.alice, apiId: graph.apiId, statusCode: 500 })
    await log({ userId: ids.alice, apiId: graph.apiId, statusCode: 404 })
    await log({ statusCode: 404 }) // an anonymous 404: nobody's log, everybody's platform total

    const tile = dataOf((await send(routes.adminAnalytics, "/api/internal/admin/analytics", "owner")).body)
    expect(Object.keys(tile).sort()).toEqual(
      [
        "activeUsers",
        "apis",
        "connections",
        "errorRate",
        "failedRequests",
        "requests",
        "spreadsheets",
        "users",
      ].sort()
    )
    expect(tile).toMatchObject({
      users: 3,
      activeUsers: 3,
      connections: 1,
      spreadsheets: 1,
      apis: 1,
      requests: 4,
      failedRequests: 3,
      errorRate: 0.75,
    })
  })

  it("returns zeroes and an error rate of 0 on an empty platform", async () => {
    // The route needs an owner row to answer at all, so the truly-empty case goes through the
    // query module the route calls: `0` divided by `0` must read as 0, not NaN.
    await truncateAll()
    const stats = await platform.getPlatformStats()
    expect(stats).toEqual({
      users: 0,
      activeUsers: 0,
      connections: 0,
      spreadsheets: 0,
      apis: 0,
      requests: 0,
      failedRequests: 0,
      errorRate: 0,
    })
    expect(Number.isFinite(stats.errorRate)).toBe(true)
    // JSON has no NaN: a bad rate would arrive as `null` and break the tile.
    expect(JSON.stringify(stats)).toContain('"errorRate":0')
    expect(JSON.stringify(stats)).not.toContain("null")

    const response = await routes.adminAnalytics.GET(
      // A truncated platform has no owner row left, so a FRESH session is minted for the route
      // check: the tile itself must still read as zeroes.
      get("/api/internal/admin/analytics", signed(await insertUser("owner"), "owner"))
    )
    expect(response.status).toBe(200)
    expect(dataOf((await response.json()) as Json)).toMatchObject({
      users: 1,
      activeUsers: 1,
      connections: 0,
      spreadsheets: 0,
      apis: 0,
      requests: 0,
      failedRequests: 0,
      errorRate: 0,
    })
  })

  it("bounds requests by from/to while the entity counts stay platform-wide", async () => {
    const graph = await seedGraph(ids.alice, "range")
    await log({ userId: ids.alice, apiId: graph.apiId })
    await log({ userId: ids.alice, apiId: graph.apiId, statusCode: 500, daysAgo: 60 })

    const recent = dataOf(
      (await send(routes.adminAnalytics, `/api/internal/admin/analytics?from=${utcDay(-7)}`, "owner")).body
    )
    expect(recent).toMatchObject({ requests: 1, failedRequests: 0, errorRate: 0, apis: 1, users: 3 })

    const whole = dataOf((await send(routes.adminAnalytics, "/api/internal/admin/analytics", "owner")).body)
    expect(whole).toMatchObject({ requests: 2, failedRequests: 1, errorRate: 0.5 })

    const badDate = await routes.adminAnalytics.GET(get("/api/internal/admin/analytics?from=nope", cookies.owner))
    expect(badDate.status).toBe(200) // ignored, not invented: the window simply stays unbounded
  })
})
