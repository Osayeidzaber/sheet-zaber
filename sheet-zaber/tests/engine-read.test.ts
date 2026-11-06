import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import type { SnippetMethod } from "@/lib/snippets"

import {
  TEST_DB_URL_KEY,
  getTestDb,
  getTestDbUrl,
  migrateTestDb,
  startTestDb,
  stopTestDb,
  truncateAll,
} from "./helpers/db"
import { fakeSheets, type SheetsStub } from "./helpers/fake-sheets"

/*
 * The engine's READ plane (`backend-api-contract.md` §1.2, §1.3, §1.5) against an embedded
 * PostgreSQL and an injected fake Sheets client — no network, no `googleapis`.
 *
 * Proven here: every read shape (list with `limit`/`offset` bounds and `page`/`per_page`, single
 * record by primary key, `search`, `range`), the §1.2 success `meta` key set, the §1.3 query grammar
 * refusals, PK resolution (0 → 404, >1 → 409), the reserved-word grammar, Google's failure kinds
 * mapped to the §1.2 statuses (never re-mapped to 200 or 500), and that `gridRow` never crosses the
 * wire.
 */

type EngineModule = typeof import("@/server/engine")
type UsersModule = typeof import("@/server/db/queries/users")
type ConnectionsModule = typeof import("@/server/db/queries/google-connections")
type SpreadsheetsModule = typeof import("@/server/db/queries/spreadsheets")
type ApisService = typeof import("@/server/apis/service")
type KeysService = typeof import("@/server/keys/service")
type EngineCall = Parameters<EngineModule["handleEngineCall"]>[0]

type Envelope = {
  data?: unknown
  meta?: { api_id: string; count: number; limit: number | null; offset: number; duration_ms: number }
  error?: { code: string; message: string; category: string; fields?: Record<string, string> }
}

type Record_ = Record<string, string>

const META_KEYS = ["api_id", "count", "limit", "offset", "duration_ms"]
const TAB = { id: 0, title: "Sheet1", rows: 100, columns: 26 }
const GRID = [
  ["id", "name", "email", "score"],
  ["1", "Ada", "ada@example.com", "10"],
  ["2", "Grace", "grace@example.com", "9"],
  ["3", "Alan", "alan@example.com", "100"],
]
const ALL_ROWS = [
  { id: "1", name: "Ada", email: "ada@example.com", score: "10" },
  { id: "2", name: "Grace", email: "grace@example.com", score: "9" },
  { id: "3", name: "Alan", email: "alan@example.com", score: "100" },
]

let engine: EngineModule
let users: UsersModule
let connections: ConnectionsModule
let sheets: SpreadsheetsModule
let apis: ApisService
let keys: KeysService

let world: {
  userId: string
  apiId: string
  noPkApiId: string
  apiKey: string
  stub: SheetsStub
}

async function seedUser(): Promise<string> {
  const stamp = randomUUID()
  const row = await users.createUser({
    googleSub: `engine-read-${stamp}`,
    email: `engine-read-${stamp}@example.com`,
    role: "user",
  })
  // `users.api_limit_per_day` (`§1.4`'s per-OWNER day window) is unlimited here so this file's
  // `X-RateLimit-*` assertions describe the per-API/per-key windows §1.4 names, not the owner's quota.
  await users.setUserApiLimit(row.id, 0)
  return row.id
}

/** `createApi` refuses a tab the snapshot does not hold, so the snapshot is seeded first. */
async function seedSpreadsheet(userId: string): Promise<string> {
  const connection = await connections.upsertConnection({
    userId,
    googleEmail: `engine-read-${randomUUID()}@example.com`,
    refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
    scope: "openid email https://www.googleapis.com/auth/spreadsheets",
  })
  const sheet = await sheets.upsertSpreadsheet({
    userId,
    connectionId: connection.id,
    googleSheetId: `sheet-${randomUUID()}`,
    title: "Roster",
    tabs: [TAB],
  })
  return sheet.id
}

async function seedApi(
  userId: string,
  spreadsheetId: string,
  input: {
    name: string
    permissions: "read" | "read_write"
    allowedOperations: SnippetMethod[]
    primaryKeyColumn?: string | null
  }
): Promise<string> {
  const result = await apis.createApi(
    {
      spreadsheetId,
      tabTitle: TAB.title,
      headerRow: 1,
      primaryKeyColumn: null,
      ...input,
    },
    userId
  )
  if (!result.ok) throw new Error(`seed api failed: ${JSON.stringify(result.error)}`)
  return result.data.id
}

async function seedKey(userId: string, scopes: ("read" | "write")[]): Promise<string> {
  const result = await keys.createKey({ name: "engine read key", scopes, allowedApiIds: null }, userId)
  if (!result.ok) throw new Error(`seed key failed: ${JSON.stringify(result.error)}`)
  return result.data.plaintext
}

function makeCall(input: {
  path: string[]
  method?: SnippetMethod
  query?: Record<string, string>
  body?: string | null
  token?: string
  ip?: string | null
}): EngineCall {
  return {
    auth: { kind: "bearer", token: input.token ?? world.apiKey },
    method: input.method ?? "GET",
    pathSegments: input.path,
    searchParams: new URLSearchParams(input.query ?? {}),
    bodyText: input.body ?? null,
    ip: input.ip ?? "203.0.113.7",
  }
}

/** THE SEAM: `handleEngineCall`'s second argument, so no engine test opens a socket (§4.8). */
function depsFor(stub: SheetsStub) {
  return { sheetsFor: async () => stub }
}

async function run(
  input: Parameters<typeof makeCall>[0]
): Promise<{ status: number; body: Envelope; raw: string; headers: Record<string, string> }> {
  const outcome = await engine.handleEngineCall(makeCall(input), depsFor(world.stub))
  return { status: outcome.status, body: JSON.parse(outcome.body) as Envelope, raw: outcome.body, headers: outcome.headers }
}

function rowsOf(body: Envelope): Record_[] {
  return body.data as Record_[]
}

describe("engine read plane", () => {
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
    // The pool this file's engine calls share; the handle itself is not needed — every assertion is
    // made against `handleEngineCall`'s answer, and `truncateAll` owns the rows between cases.
    await getTestDb()
    engine = await import("@/server/engine")
    users = await import("@/server/db/queries/users")
    connections = await import("@/server/db/queries/google-connections")
    sheets = await import("@/server/db/queries/spreadsheets")
    apis = await import("@/server/apis/service")
    keys = await import("@/server/keys/service")
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    const userId = await seedUser()
    const spreadsheetId = await seedSpreadsheet(userId)
    world = {
      userId,
      apiId: await seedApi(userId, spreadsheetId, {
        name: "Roster read",
        permissions: "read",
        allowedOperations: ["GET"],
        primaryKeyColumn: "id",
      }),
      noPkApiId: await seedApi(userId, spreadsheetId, {
        name: "Roster unkeyed",
        permissions: "read",
        allowedOperations: ["GET"],
      }),
      apiKey: await seedKey(userId, ["read"]),
      stub: fakeSheets({ grids: { [TAB.title]: GRID } }),
    }
  })

  afterAll(async () => {
    await stopTestDb()
  })

  describe("list — GET /{api}", () => {
    it("answers every row with the §1.2 meta key set", async () => {
      const { status, body } = await run({ path: [world.apiId] })

      expect(status).toBe(200)
      expect(rowsOf(body)).toEqual(ALL_ROWS)
      expect(Object.keys(body.meta ?? {})).toEqual(META_KEYS)
      expect(body.meta).toMatchObject({ api_id: world.apiId, count: 3, limit: null, offset: 0 })
      expect(body.meta?.duration_ms).toEqual(expect.any(Number))
      expect(Number(body.meta?.duration_ms)).toBeGreaterThanOrEqual(0)
    })

    it("sends content-type and the rate-limit headers a bucket consumed", async () => {
      const { headers } = await run({ path: [world.apiId] })
      expect(headers["content-type"]).toContain("application/json")
      expect(headers["X-RateLimit-Limit"]).toBe("1000")
      expect(Number(headers["X-RateLimit-Remaining"])).toBe(999)
    })

    it("pages with limit and offset, counting the page not the table", async () => {
      const first = await run({ path: [world.apiId], query: { limit: "2" } })
      expect(rowsOf(first.body)).toEqual(ALL_ROWS.slice(0, 2))
      expect(first.body.meta).toMatchObject({ count: 2, limit: 2, offset: 0 })

      const second = await run({ path: [world.apiId], query: { limit: "2", offset: "2" } })
      expect(rowsOf(second.body)).toEqual(ALL_ROWS.slice(2))
      expect(second.body.meta).toMatchObject({ count: 1, limit: 2, offset: 2 })
    })

    it("rejects a limit outside 1…1000 and a negative offset with 400 validation_failed", async () => {
      for (const query of [{ limit: "0" }, { limit: "1001" }, { offset: "-1" }, { limit: "1.5" }] as Record<string, string>[]) {
        const { status, body } = await run({ path: [world.apiId], query })
        expect(status, JSON.stringify(query)).toBe(400)
        expect(body.error?.code).toBe("validation_failed")
        expect(body.error?.category).toBe("validation")
      }
    })

    it("refuses to mix offset with page, or limit with per_page", async () => {
      const mixed = await run({ path: [world.apiId], query: { offset: "1", page: "2", per_page: "1" } })
      expect(mixed.status).toBe(400)
      expect(mixed.body.error?.code).toBe("validation_failed")

      const combined = await run({ path: [world.apiId], query: { limit: "2", per_page: "2" } })
      expect(combined.status).toBe(400)

      const paged = await run({ path: [world.apiId], query: { page: "2", per_page: "2" } })
      expect(paged.status).toBe(200)
      expect(rowsOf(paged.body)).toEqual(ALL_ROWS.slice(2))
      expect(paged.body.meta).toMatchObject({ count: 1, limit: 2, offset: 2 })
    })

    it("sorts ascending and descending, numerically when both cells are numbers", async () => {
      const asc = await run({ path: [world.apiId], query: { sort: "score" } })
      // "10" vs "9" vs "100": numeric comparison, so 9 < 10 < 100 (`query.ts#compareCells`).
      expect(rowsOf(asc.body).map((row) => row.id)).toEqual(["2", "1", "3"])

      const desc = await run({ path: [world.apiId], query: { sort: "-name" } })
      expect(rowsOf(desc.body).map((row) => row.name)).toEqual(["Grace", "Alan", "Ada"])
    })

    it("projects fields after filtering, in the order sent", async () => {
      const { body } = await run({ path: [world.apiId], query: { fields: "name,id", "score__gt": "8" } })
      expect(rowsOf(body)).toEqual([{ name: "Ada", id: "1" }, { name: "Grace", id: "2" }, { name: "Alan", id: "3" }])
    })

    it("filters with equality and the operator suffixes", async () => {
      const eq = await run({ path: [world.apiId], query: { name: "Ada" } })
      expect(rowsOf(eq.body)).toEqual([ALL_ROWS[0]])

      const contains = await run({ path: [world.apiId], query: { email__contains: "example.com" } })
      expect(contains.body.meta).toMatchObject({ count: 3 })

      const gte = await run({ path: [world.apiId], query: { score__gte: "10" } })
      expect(rowsOf(gte.body).map((row) => row.id)).toEqual(["1", "3"])

      const lt = await run({ path: [world.apiId], query: { score__lt: "10" } })
      expect(rowsOf(lt.body).map((row) => row.id)).toEqual(["2"])
    })

    it("names an unknown column in a filter, sort or projection with 400", async () => {
      for (const query of [{ nope: "1" }, { sort: "nope" }, { fields: "nope" }] as Record<string, string>[]) {
        const { status, body } = await run({ path: [world.apiId], query })
        expect(status, JSON.stringify(query)).toBe(400)
        expect(body.error?.code).toBe("validation_failed")
      }
    })

    it("never puts a grid row number on the wire (§1.5)", async () => {
      const { raw } = await run({ path: [world.apiId] })
      expect(raw).not.toContain("gridRow")
      expect(raw).not.toContain("row_number")
    })
  })

  describe("single record — GET /{api}/{record}", () => {
    it("resolves by primary-key value and answers one object", async () => {
      const { status, body } = await run({ path: [world.apiId, "2"] })
      expect(status).toBe(200)
      expect(body.data).toEqual(ALL_ROWS[1])
      expect(body.meta).toMatchObject({ count: 1, limit: null, offset: 0 })
    })

    it("answers 404 record_not_found for no match, with the contract's message", async () => {
      const { status, body, raw } = await run({ path: [world.apiId, "42"] })
      expect(status).toBe(404)
      expect(raw).toBe(JSON.stringify({ error: { code: "record_not_found", message: "No record with id=42", category: "not_found" } }))
      expect(body.error?.category).toBe("not_found")
    })

    it("answers 409 ambiguous_record when the primary key matches twice (§1.5)", async () => {
      world.stub = fakeSheets({
        grids: {
          [TAB.title]: [
            ["id", "name"],
            ["1", "Ada"],
            ["1", "Grace"],
          ],
        },
      })
      const { status, body } = await run({ path: [world.apiId, "1"] })
      expect(status).toBe(409)
      expect(body.error?.code).toBe("ambiguous_record")
      expect(body.error?.category).toBe("validation")
    })

    it("answers 403 operation_not_allowed when the API has no primary key column", async () => {
      const { status, body } = await run({ path: [world.noPkApiId, "1"] })
      expect(status).toBe(403)
      expect(body.error?.code).toBe("operation_not_allowed")
    })

    it("projects fields but still refuses an unknown filter column", async () => {
      const projected = await run({ path: [world.apiId, "1"], query: { fields: "name" } })
      expect(projected.body.data).toEqual({ name: "Ada" })

      const filtered = await run({ path: [world.apiId, "1"], query: { nope: "1" } })
      expect(filtered.status).toBe(400)
    })
  })

  describe("search — GET /{api}/search", () => {
    it("matches case-insensitively across every column", async () => {
      const { status, body } = await run({ path: [world.apiId, "search"], query: { q: "grace" } })
      expect(status).toBe(200)
      expect(rowsOf(body)).toEqual([ALL_ROWS[1]])
    })

    it("takes the same limit/offset/sort/fields as the list route", async () => {
      const { body } = await run({ path: [world.apiId, "search"], query: { q: "a", sort: "-score", fields: "id" } })
      // Every row holds an "a"; `-score` is numeric descending, so 100, 10, 9.
      expect(rowsOf(body)).toEqual([{ id: "3" }, { id: "1" }, { id: "2" }])
    })

    it("refuses an empty term with 400 (§1.3)", async () => {
      const { status, body } = await run({ path: [world.apiId, "search"], query: { q: "" } })
      expect(status).toBe(400)
      expect(body.error?.code).toBe("validation_failed")

      const missing = await run({ path: [world.apiId, "search"] })
      expect(missing.status).toBe(400)
      expect(missing.body.error?.fields).toMatchObject({ q: expect.any(String) })
    })

    it("is also reachable as ?q= on the list route", async () => {
      const { body } = await run({ path: [world.apiId], query: { q: "ada@example.com" } })
      expect(rowsOf(body)).toEqual([ALL_ROWS[0]])
    })
  })

  describe("range — GET /{api}/range/{A1}", () => {
    it("returns the raw rectangle under data.rows with data.headers", async () => {
      const { status, body } = await run({ path: [world.apiId, "range", "A1:B3"] })
      expect(status).toBe(200)
      expect(body.data).toEqual({
        rows: [
          ["id", "name"],
          ["1", "Ada"],
          ["2", "Grace"],
        ],
        headers: ["id", "name"],
      })
      expect(body.meta).toMatchObject({ count: 3, limit: null, offset: 0 })
    })

    it("accepts a sheet prefix that matches the configured tab", async () => {
      const { status } = await run({ path: [world.apiId, "range", `${TAB.title}!A1:B2`] })
      expect(status).toBe(200)
    })

    it("refuses a range that names another tab", async () => {
      const { status, body } = await run({ path: [world.apiId, "range", "Other!A1:B2"] })
      expect(status).toBe(400)
      expect(body.error?.code).toBe("invalid_range")
    })

    it("refuses nonsense notation and an out-of-bounds rectangle", async () => {
      for (const a1 of ["nonsense", "A1:B500"]) {
        const { status, body } = await run({ path: [world.apiId, "range", a1] })
        expect(status, a1).toBe(400)
        expect(body.error?.code, a1).toBe("invalid_range")
      }
    })

    it("is GET-only: a write verb is refused by authorization before the grammar is read", async () => {
      // This API allows GET alone, so `authorizeKeyCall` answers first — the same 403 a write would
      // get on any path of this API (`keys/service.ts`'s frozen order, §1.1).
      const { status, body } = await run({ path: [world.apiId, "range", "A1:B2"], method: "POST", body: "{}" })
      expect(status).toBe(403)
      expect(body.error?.code).toBe("operation_not_allowed")
    })
  })

  describe("reserved words and grammar", () => {
    it("reads /search as the search route, never as a record id", async () => {
      // A record whose primary key literally reads `search` is unreachable by id: the grammar is
      // fixed, so `?id=search` on the list route is the documented answer (§1.3).
      const asSearch = await run({ path: [world.apiId, "search"] })
      expect(asSearch.status).toBe(400)
      expect(asSearch.body.error?.code).toBe("validation_failed")

      world.stub = fakeSheets({ grids: { [TAB.title]: [["id", "name"], ["search", "Ada"], ["2", "Grace"]] } })
      const byFilter = await run({ path: [world.apiId], query: { id: "search" } })
      expect(byFilter.body.data).toEqual([{ id: "search", name: "Ada" }])
    })

    it("reads /range as the range route, never as a record id", async () => {
      const { status, body } = await run({ path: [world.apiId, "range"] })
      expect(status).toBe(404)
      expect(body.error?.code).toBe("api_not_found")
    })

    it("answers 404 api_not_found — not a verb error — for a path no operation serves", async () => {
      const { status, body } = await run({ path: [world.apiId, "1", "extra"] })
      expect(status).toBe(404)
      expect(body.error?.code).toBe("api_not_found")
    })

    it("answers 404 for an unknown api id with no Google round trip spent", async () => {
      const { status, body } = await run({ path: [randomUUID()] })
      expect(status).toBe(404)
      expect(body.error?.code).toBe("api_not_found")
    })
  })

  describe("Google failures mapped by §1.2 and §1.5", () => {
    it("refreshes once and succeeds when the retry works (§1.5)", async () => {
      const stub = fakeSheets({ grids: { [TAB.title]: GRID }, failNextWith: "401" })
      const outcome = await engine.handleEngineCall(makeCall({ path: [world.apiId] }), depsFor(stub))
      expect(outcome.status).toBe(200)
      expect(JSON.parse(outcome.body).data).toEqual(ALL_ROWS)
    })

    it("answers 503 google_reauth_required when every attempt fails on the token", async () => {
      let calls = 0
      const outcome = await engine.handleEngineCall(makeCall({ path: [world.apiId] }), {
        sheetsFor: async () => {
          calls += 1
          return fakeSheets({ grids: { [TAB.title]: GRID }, failNextWith: "401" })
        },
      })
      expect(outcome.status).toBe(503)
      expect(JSON.parse(outcome.body).error).toMatchObject({ code: "google_reauth_required", category: "google" })
      // One attempt, one refresh, one retry — never a loop (§1.5).
      expect(calls).toBe(2)
    })

    it("answers 422 google_sheet_inaccessible for a Google 403/404", async () => {
      for (const status of ["403", "404"] as const) {
        const stub = fakeSheets({ grids: { [TAB.title]: GRID }, failNextWith: status })
        const outcome = await engine.handleEngineCall(makeCall({ path: [world.apiId] }), depsFor(stub))
        expect(outcome.status, status).toBe(422)
        expect(JSON.parse(outcome.body).error).toMatchObject({ code: "google_sheet_inaccessible", category: "google" })
      }
    })

    it("answers 503 google_quota_exceeded for a Google 429 (§1.5)", async () => {
      const stub = fakeSheets({ grids: { [TAB.title]: GRID }, failNextWith: "429" })
      const outcome = await engine.handleEngineCall(makeCall({ path: [world.apiId] }), depsFor(stub))
      expect(outcome.status).toBe(503)
      expect(JSON.parse(outcome.body).error).toMatchObject({ code: "google_quota_exceeded", category: "google" })
    })

    it("answers 500 internal_error without echoing the cause", async () => {
      const outcome = await engine.handleEngineCall(makeCall({ path: [world.apiId] }), {
        sheetsFor: async () => {
          throw new Error("a bug inside the engine must not look like Google")
        },
      })
      expect(outcome.status).toBe(500)
      expect(JSON.parse(outcome.body).error).toEqual({
        code: "internal_error",
        message: "The request could not be completed.",
        category: "internal",
      })
    })
  })
})
