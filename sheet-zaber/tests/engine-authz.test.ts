import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import type { SnippetMethod } from "@/lib/snippets"
import { apiConfigurations, apiKeys, apiRequestLogs, rateLimitBuckets } from "@/server/db/schema"

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
import { fakeSheets, type SheetsStub } from "./helpers/fake-sheets"

/*
 * The engine's authentication, authorization, rate-limit and logging contract
 * (`backend-api-contract.md` §1.1, §1.4, §1.5, §4.8; `security.md` §2 and §4).
 *
 * Proven here: unknown/revoked/expired/wrong keys and a foreign or missing `keyId` all answer the
 * SAME 401 bytes as each other; the bearer and `keyId` arms are byte-identical for one and the same
 * request; a cross-user api id answers 404 exactly like an unknown one; the frozen authorization
 * order produces `key_restricted` / `operation_not_allowed` / `key_scope_insufficient`; a disabled
 * API and a disabled OWNER both stop serving; the per-API hour bucket produces a 429 with
 * `Retry-After` and `fields.retry_after`; every call including 401 and 429 writes exactly one
 * `api_request_logs` row that carries NO secret; and no raw key, api id or IP ever reaches
 * `rate_limit_buckets.bucket_key`.
 */

type EngineModule = typeof import("@/server/engine")
type UsersModule = typeof import("@/server/db/queries/users")
type ConnectionsModule = typeof import("@/server/db/queries/google-connections")
type SpreadsheetsModule = typeof import("@/server/db/queries/spreadsheets")
type ApisService = typeof import("@/server/apis/service")
type KeysService = typeof import("@/server/keys/service")
type EngineCall = Parameters<EngineModule["handleEngineCall"]>[0]
type EngineAuth = EngineCall["auth"]

type Envelope = {
  data?: unknown
  meta?: { api_id: string; count: number; limit: number | null; offset: number; duration_ms: number }
  error?: { code: string; message: string; category: string; fields?: Record<string, string> }
}

const TAB = { id: 0, title: "Sheet1", rows: 100, columns: 26 }
const GRID = [
  ["id", "name"],
  ["1", "Ada"],
  ["2", "Grace"],
]

/** §1.2's 401 body, byte for byte — every dead credential must produce exactly this. */
const INVALID_KEY_BODY = '{"error":{"code":"invalid_key","message":"That API key is not valid.","category":"auth"}}'

let test: TestDb
let engine: EngineModule
let users: UsersModule
let connections: ConnectionsModule
let sheets: SpreadsheetsModule
let apis: ApisService
let keys: KeysService
let route: typeof import("@/app/api/v1/[...path]/route")

let world: {
  alice: string
  bob: string
  aliceApi: string
  aliceReadApi: string
  bobApi: string
  aliceKeyId: string
  aliceKey: string
  readOnlyKey: string
  restrictedKey: string
  stub: SheetsStub
}

async function seedUser(): Promise<string> {
  const stamp = randomUUID()
  const row = await users.createUser({
    googleSub: `engine-authz-${stamp}`,
    email: `engine-authz-${stamp}@example.com`,
    role: "user",
  })
  return row.id
}

async function seedSpreadsheet(userId: string): Promise<string> {
  const connection = await connections.upsertConnection({
    userId,
    googleEmail: `engine-authz-${randomUUID()}@example.com`,
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
    rateLimitPerHour?: number | null
  }
): Promise<string> {
  const result = await apis.createApi(
    { spreadsheetId, tabTitle: TAB.title, headerRow: 1, primaryKeyColumn: null, ...input },
    userId
  )
  if (!result.ok) throw new Error(`seed api failed: ${JSON.stringify(result.error)}`)
  return result.data.id
}

async function seedKey(
  userId: string,
  scopes: ("read" | "write")[],
  allowedApiIds: string[] | null = null
): Promise<{ id: string; plaintext: string }> {
  const result = await keys.createKey({ name: "engine authz key", scopes, allowedApiIds }, userId)
  if (!result.ok) throw new Error(`seed key failed: ${JSON.stringify(result.error)}`)
  return { id: result.data.id, plaintext: result.data.plaintext }
}

function makeCall(auth: EngineAuth, input: { path: string[]; method?: SnippetMethod; body?: string | null; query?: Record<string, string>; ip?: string | null }): EngineCall {
  return {
    auth,
    method: input.method ?? "GET",
    pathSegments: input.path,
    searchParams: new URLSearchParams(input.query ?? {}),
    bodyText: input.body ?? null,
    ip: input.ip ?? "198.51.100.23",
  }
}

function bearer(token: string): EngineAuth {
  return { kind: "bearer", token }
}

function depsFor(stub: SheetsStub) {
  return { sheetsFor: async () => stub }
}

async function call(auth: EngineAuth, input: Parameters<typeof makeCall>[1]) {
  const outcome = await engine.handleEngineCall(makeCall(auth, input), depsFor(world.stub))
  return { status: outcome.status, raw: outcome.body, body: JSON.parse(outcome.body) as Envelope, headers: outcome.headers }
}

async function logRows(): Promise<Array<Record<string, unknown>>> {
  return test.select().from(apiRequestLogs)
}

async function bucketKeys(): Promise<string[]> {
  const rows = await test.select({ bucketKey: rateLimitBuckets.bucketKey }).from(rateLimitBuckets)
  return rows.map((row) => row.bucketKey)
}

describe("engine authz, rate limit and logging", () => {
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
    engine = await import("@/server/engine")
    users = await import("@/server/db/queries/users")
    connections = await import("@/server/db/queries/google-connections")
    sheets = await import("@/server/db/queries/spreadsheets")
    apis = await import("@/server/apis/service")
    keys = await import("@/server/keys/service")
    route = await import("@/app/api/v1/[...path]/route")
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    const alice = await seedUser()
    const bob = await seedUser()
    const aliceSheet = await seedSpreadsheet(alice)
    const bobSheet = await seedSpreadsheet(bob)
    const aliceKey = await seedKey(alice, ["read", "write"])
    const readKey = await seedKey(alice, ["read"])
    const bobApiId = await seedApi(bob, bobSheet, {
      name: "Bob roster",
      permissions: "read",
      allowedOperations: ["GET"],
      primaryKeyColumn: "id",
    })
    const restricted = await seedKey(alice, ["read", "write"], [bobApiId])

    world = {
      alice,
      bob,
      aliceApi: await seedApi(alice, aliceSheet, {
        name: "Alice roster",
        permissions: "read_write",
        allowedOperations: ["GET", "POST", "PATCH", "PUT", "DELETE"],
        primaryKeyColumn: "id",
      }),
      aliceReadApi: await seedApi(alice, aliceSheet, {
        name: "Alice read only",
        permissions: "read",
        allowedOperations: ["GET"],
        primaryKeyColumn: "id",
      }),
      bobApi: bobApiId,
      aliceKeyId: aliceKey.id,
      aliceKey: aliceKey.plaintext,
      readOnlyKey: readKey.plaintext,
      restrictedKey: restricted.plaintext,
      stub: fakeSheets({ grids: { [TAB.title]: GRID } }),
    }
  })

  afterAll(async () => {
    await stopTestDb()
  })

  describe("the 401 is one shape (§1.1, security.md §3 item 2)", () => {
    it("answers the identical body for an unknown, a revoked, an expired and a malformed key", async () => {
      const unknown = await call(bearer(`sz_live_${"0".repeat(32)}`), { path: [world.aliceApi] })
      expect(unknown.status).toBe(401)
      expect(unknown.raw).toBe(INVALID_KEY_BODY)

      const revoked = await keys.revokeKey(world.aliceKeyId, world.alice)
      expect(revoked.ok).toBe(true)
      const afterRevoke = await call(bearer(world.aliceKey), { path: [world.aliceApi] })
      expect(afterRevoke.raw).toBe(INVALID_KEY_BODY)

      const fresh = await seedKey(world.alice, ["read"])
      await test.update(apiKeys).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(apiKeys.id, fresh.id))
      const expired = await call(bearer(fresh.plaintext), { path: [world.aliceApi] })
      expect(expired.raw).toBe(INVALID_KEY_BODY)

      const malformed = await call(bearer("not-a-key"), { path: [world.aliceApi] })
      expect(malformed.raw).toBe(INVALID_KEY_BODY)
    })

    it("answers 401 missing_key when nothing was sent — and ignores ?key= (§1.1)", async () => {
      const none = await call(bearer(""), { path: [world.aliceApi] })
      expect(none.status).toBe(401)
      expect(none.body.error?.code).toBe("missing_key")

      const queryAuth = await call(bearer(""), { path: [world.aliceApi], query: { key: world.aliceKey } })
      expect(queryAuth.status).toBe(401)
      expect(queryAuth.body.error?.code).toBe("missing_key")
    })

    it("never returns or logs the plaintext key, in any column (§1.5, security.md §4)", async () => {
      await call(bearer(world.aliceKey), { path: [world.aliceApi] })
      await call(bearer("sz_live_" + "f".repeat(32)), { path: [world.aliceApi] })

      const rows = await logRows()
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        const text = JSON.stringify(row)
        expect(text).not.toContain(world.aliceKey)
        expect(text).not.toContain("sz_live_")
        expect(text).not.toContain("key_hash")
      }
    })
  })

  describe("the playground's keyId arm is indistinguishable (§4.8)", () => {
    it("serves an owned keyId with the same bytes the bearer arm produces", async () => {
      const viaKey = await call(bearer(world.aliceKey), { path: [world.aliceApi] })
      const viaId = await call({ kind: "keyId", apiKeyId: world.aliceKeyId, ownerId: world.alice }, { path: [world.aliceApi] })

      expect(viaId.status).toBe(viaKey.status)
      // Every header matches EXCEPT the counter: `X-RateLimit-Remaining` reports the window after
      // this call consumed it, so the second of two calls is always one lower than the first — that
      // is the quota moving, not the transport differing. `body` is compared for the bytes.
      const withoutRemaining = (headers: Record<string, string>) => {
        const copy = { ...headers }
        delete copy["X-RateLimit-Remaining"]
        return copy
      }
      expect(withoutRemaining(viaId.headers)).toEqual(withoutRemaining(viaKey.headers))
      expect(viaId.body.data).toEqual(viaKey.body.data)
      expect(viaId.body.meta).toMatchObject({ api_id: world.aliceApi, count: 2 })
    })

    it("answers the exact 401 bytes for a foreign keyId and for a keyId that does not exist", async () => {
      const foreign = await call({ kind: "keyId", apiKeyId: world.aliceKeyId, ownerId: world.bob }, { path: [world.aliceApi] })
      expect(foreign.status).toBe(401)
      expect(foreign.raw).toBe(INVALID_KEY_BODY)

      const ghost = await call({ kind: "keyId", apiKeyId: randomUUID(), ownerId: world.alice }, { path: [world.aliceApi] })
      expect(ghost.raw).toBe(INVALID_KEY_BODY)

      const badBearer = await call(bearer(`sz_live_${"1".repeat(32)}`), { path: [world.aliceApi] })
      expect(ghost.raw).toBe(badBearer.raw)
    })
  })

  describe("authorization order (§1.1, keys/service.ts)", () => {
    it("answers 404 api_not_found for another user's API — the same bytes as an unknown id", async () => {
      const foreignApi = await call(bearer(world.aliceKey), { path: [world.bobApi] })
      expect(foreignApi.status).toBe(404)
      expect(foreignApi.body.error?.code).toBe("api_not_found")

      const unknownApi = await call(bearer(world.aliceKey), { path: [randomUUID()] })
      expect(unknownApi.raw).toBe(foreignApi.raw)
    })

    it("answers 403 key_restricted when allowed_api_ids excludes this API", async () => {
      const { status, body } = await call(bearer(world.restrictedKey), { path: [world.aliceApi] })
      expect(status).toBe(403)
      expect(body.error?.code).toBe("key_restricted")
    })

    it("answers 403 operation_not_allowed when the API does not allow the verb", async () => {
      const { status, body } = await call(bearer(world.aliceKey), {
        method: "POST",
        path: [world.aliceReadApi],
        body: JSON.stringify({ id: "3", name: "Nope" }),
      })
      expect(status).toBe(403)
      expect(body.error?.code).toBe("operation_not_allowed")
    })

    it("answers 403 key_scope_insufficient when the key cannot write", async () => {
      const { status, body } = await call(bearer(world.readOnlyKey), {
        method: "POST",
        path: [world.aliceApi],
        body: JSON.stringify({ id: "3", name: "Nope" }),
      })
      expect(status).toBe(403)
      expect(body.error?.code).toBe("key_scope_insufficient")
      expect(body.error?.category).toBe("auth")

      // …and a read with a read-scope key is fine.
      const read = await call(bearer(world.readOnlyKey), { path: [world.aliceApi] })
      expect(read.status).toBe(200)
    })

    it("answers 404 for a disabled API and for a disabled OWNER — both stop serving immediately", async () => {
      await test.update(apiConfigurations).set({ enabled: false }).where(eq(apiConfigurations.id, world.aliceApi))
      const disabledApi = await call(bearer(world.aliceKey), { path: [world.aliceApi] })
      expect(disabledApi.status).toBe(404)
      expect(disabledApi.body.error?.code).toBe("api_not_found")

      await test.update(apiConfigurations).set({ enabled: true }).where(eq(apiConfigurations.id, world.aliceApi))
      await users.setUserStatus(world.alice, "disabled")
      const disabledOwner = await call(bearer(world.aliceKey), { path: [world.aliceApi] })
      expect(disabledOwner.status).toBe(404)
      expect(disabledOwner.body.error?.code).toBe("api_not_found")
    })
  })

  describe("rate limits (§1.4)", () => {
    async function seedThrottledApi(rateLimitPerHour: number): Promise<string> {
      const sheet = await seedSpreadsheet(world.alice)
      return seedApi(world.alice, sheet, {
        name: "Throttled",
        permissions: "read",
        allowedOperations: ["GET"],
        primaryKeyColumn: "id",
        rateLimitPerHour,
      })
    }

    it("honours api_configurations.rate_limit_per_hour and answers 429 with Retry-After", async () => {
      const apiId = await seedThrottledApi(1)

      const first = await call(bearer(world.aliceKey), { path: [apiId] })
      expect(first.status).toBe(200)
      expect(first.headers["X-RateLimit-Limit"]).toBe("1")

      const second = await call(bearer(world.aliceKey), { path: [apiId] })
      expect(second.status).toBe(429)
      expect(second.body.error).toMatchObject({ code: "rate_limited", category: "rate_limit" })
      // §4.4: the same number rides the header and `fields.retry_after`.
      expect(Number(second.headers["Retry-After"])).toBeGreaterThanOrEqual(1)
      expect(second.body.error?.fields).toMatchObject({ retry_after: second.headers["Retry-After"] })

      const third = await call(bearer(world.aliceKey), { path: [apiId] })
      expect(third.status).toBe(429)
      expect(Number(third.headers["Retry-After"])).toBeLessThanOrEqual(3600)
    })

    it("falls back to the platform default that BINDS when the API sets no override", async () => {
      // §1.4 counts a call in three windows: the api hour bucket (platform 1000), the key day bucket
      // and the API owner's `users.api_limit_per_day` (platform 500). The header names the window that
      // binds — the quota the caller runs out of first — so a normal user reports 500 here, not the
      // hour default. `api_configurations.rate_limit_per_hour` moves it when it is set.
      const { status, headers } = await call(bearer(world.aliceKey), { path: [world.aliceApi] })
      expect(status).toBe(200)
      expect(headers["X-RateLimit-Limit"]).toBe("500")
      expect(Number(headers["X-RateLimit-Remaining"])).toBe(499)
    })

    it("writes only hashed bucket keys — no raw key, api id or IP (§1.4, security.md §4)", async () => {
      await call(bearer(world.aliceKey), { path: [world.aliceApi], ip: "203.0.113.199" })

      const keys = await bucketKeys()
      expect(keys.length).toBeGreaterThanOrEqual(3)
      for (const bucket of keys) {
        expect(bucket).not.toContain(world.aliceKeyId)
        expect(bucket).not.toContain(world.aliceApi)
        expect(bucket).not.toContain("203.0.113.199")
        expect(bucket).not.toContain(world.aliceKey)
        // `{scope}:{32 hex}:{window}` (`database-schema.md`), the id hashed like `invitations/service.ts`.
        expect(bucket).toMatch(/^[a-z:]+[0-9a-f]{32}:[hd]\d+$/)
      }
      expect(keys.some((bucket) => bucket.startsWith("engine:ip:"))).toBe(true)
    })

    it("logs the 429 as its own request row with the rate_limit category", async () => {
      const apiId = await seedThrottledApi(1)
      await call(bearer(world.aliceKey), { path: [apiId] })
      await call(bearer(world.aliceKey), { path: [apiId] })

      const rows = await logRows()
      const statuses = rows.map((row) => row.statusCode)
      expect(statuses).toContain(200)
      expect(statuses).toContain(429)
      const denied = rows.find((row) => row.statusCode === 429)
      expect(denied?.errorCategory).toBe("rate_limit")
    })
  })

  describe("one request, one log row (§1.5)", () => {
    it("writes exactly one row per call — including the 401 — with method, path, status and duration", async () => {
      await call(bearer(`sz_live_${"0".repeat(32)}`), { path: [world.aliceApi] })
      expect(await logRows()).toHaveLength(1)

      await call(bearer(world.aliceKey), { path: [world.aliceApi] })
      const rows = await logRows()
      expect(rows).toHaveLength(2)

      const ok = rows.find((row) => row.statusCode === 200)
      expect(ok).toMatchObject({
        method: "GET",
        apiId: world.aliceApi,
        userId: world.alice,
        apiKeyId: world.aliceKeyId,
        errorCategory: null,
      })
      expect(Number(ok?.durationMs)).toBeGreaterThanOrEqual(0)
    })

    it("masks the {record} segment: a primary-key value is cell content and never enters a log", async () => {
      await call(bearer(world.aliceKey), { path: [world.aliceApi, "Ada-is-secret"] })

      const [row] = await logRows()
      expect(row?.path).toBe(`/api/v1/${world.aliceApi}/{record}`)
      expect(JSON.stringify(row)).not.toContain("Ada-is-secret")
    })

    it("stores no query string and no body, and still logs a rejected POST's bytes count", async () => {
      await call(bearer(world.aliceKey), {
        method: "POST",
        path: [world.aliceApi],
        body: JSON.stringify({ name: "Ada" }),
        query: { name: "Ada" },
      })

      const [row] = await logRows()
      expect(JSON.stringify(row)).not.toContain("Ada")
      expect(row?.path).toBe(`/api/v1/${world.aliceApi}`)
      expect(Number(row?.requestBytes)).toBeGreaterThan(0)
    })

    it("bumps last_used_at only for a call that authorized", async () => {
      const before = await test.select({ lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.id, world.aliceKeyId))
      expect(before[0]?.lastUsedAt).toBeNull()

      await call(bearer(`sz_live_${"0".repeat(32)}`), { path: [world.aliceApi] })
      const afterDenied = await test.select({ lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.id, world.aliceKeyId))
      expect(afterDenied[0]?.lastUsedAt).toBeNull()

      await call(bearer(world.aliceKey), { path: [world.aliceApi] })
      const afterOk = await test.select({ lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.id, world.aliceKeyId))
      expect(afterOk[0]?.lastUsedAt).toBeInstanceOf(Date)
    })
  })

  describe("verbs the route does not export (§4.4)", () => {
    it("answers 405 method_not_allowed with an Allow list, without a DB or Google call", async () => {
      const head = await route.HEAD()
      expect(head.status).toBe(405)
      expect(head.headers.get("allow")).toBe("GET, POST, PATCH, PUT, DELETE")
      expect(await head.json()).toEqual({
        error: { code: "method_not_allowed", message: "Method not allowed.", category: "validation" },
      })

      const options = route.OPTIONS()
      expect(options.status).toBe(405)
    })

    it("is never an oracle: an unknown id answers 404, not 405, for GET", async () => {
      // §1.1's order is credential first, then the API. A call with NO credential therefore cannot
      // report anything about the id space at all (401), and an authenticated call to an id that does
      // not exist answers the same 404 `api_not_found` that a foreign or disabled one does — never
      // the 405 the verb guard produces, which would leak that the path exists.
      const anonymous = await route.GET(new Request("http://localhost:3001/api/v1/nope"), {
        params: Promise.resolve({ path: ["nope"] }),
      })
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get("content-type")).toContain("application/json")

      const unknown = await route.GET(
        new Request("http://localhost:3001/api/v1/nope", {
          headers: { authorization: `Bearer ${world.aliceKey}` },
        }),
        { params: Promise.resolve({ path: ["nope"] }) }
      )
      expect(unknown.status).toBe(404)
      const wire = (await unknown.json()) as { error?: { code?: string } }
      expect(wire.error?.code).toBe("api_not_found")
      expect(unknown.headers.get("content-type")).toContain("application/json")
    })
  })
})
