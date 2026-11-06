import { createHash, randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import type { SnippetMethod } from "@/lib/snippets"
import { apiRequestLogs, rateLimitBuckets, users as usersTable } from "@/server/db/schema"

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
 * The per-USER daily quota on the request path (`backend-api-contract.md` §1.4, §4.8; the owner's
 * "each normal user will have 500 api limit, normally, until i allocate them limitation more or less,
 * as the owner i will have none"), measured through `handleEngineCall` — the ONE entry point both the
 * `/api/v1` route and the playground use, so a rule proven here holds for every caller.
 *
 * Proven: the stored 500 is the binding window; the bucket id is
 * `engine:user:<sha256(userId).slice(0,32)>:d86400` with no raw id in it; the (limit+1)th call of the
 * day answers §1.4's canonical 429 with `Retry-After`, `fields.retry_after` and a message that says
 * DAILY QUOTA, not key window; raising the limit lets the next call through without waiting for the
 * window; the quota counts across ALL of the owner's APIs and keys combined; a `role = 'owner'` row is
 * unlimited even with `api_limit_per_day = 1` and consumes NO user bucket at all; a stored `0` is
 * unlimited for a normal user; a 401 or a 403 still consumes nothing; and the per-key hour window keeps
 * denying in its own words, untouched by the new dimension.
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

let test: TestDb
let engine: EngineModule
let users: UsersModule
let connections: ConnectionsModule
let sheets: SpreadsheetsModule
let apis: ApisService
let keys: KeysService

let world: {
  userId: string
  spreadsheetId: string
  apiId: string
  secondApiId: string
  apiKey: string
  secondApiKey: string
  stub: SheetsStub
}

/* ---------------------------------------------------------------- seeding */

async function seedUser(role: "user" | "owner" = "user"): Promise<string> {
  const stamp = randomUUID()
  const row = await users.createUser({
    googleSub: `quota-engine-${stamp}`,
    email: `quota-engine-${stamp}@example.com`,
    role,
  })
  return row.id
}

async function setQuota(userId: string, limitPerDay: number): Promise<void> {
  await test.update(usersTable).set({ apiLimitPerDay: limitPerDay }).where(eq(usersTable.id, userId))
}

async function seedSpreadsheet(userId: string): Promise<string> {
  const connection = await connections.upsertConnection({
    userId,
    googleEmail: `quota-engine-${randomUUID()}@example.com`,
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
    permissions?: "read" | "read_write"
    allowedOperations?: SnippetMethod[]
    primaryKeyColumn?: string | null
    rateLimitPerHour?: number | null
  }
): Promise<string> {
  const result = await apis.createApi(
    {
      spreadsheetId,
      tabTitle: TAB.title,
      headerRow: 1,
      primaryKeyColumn: "id",
      permissions: "read",
      allowedOperations: ["GET"],
      ...input,
    },
    userId
  )
  if (!result.ok) throw new Error(`seed api failed: ${JSON.stringify(result.error)}`)
  return result.data.id
}

async function seedKey(userId: string, scopes: ("read" | "write")[] = ["read"]): Promise<string> {
  const result = await keys.createKey(
    { name: "quota engine key", scopes, allowedApiIds: null },
    userId
  )
  if (!result.ok) throw new Error(`seed key failed: ${JSON.stringify(result.error)}`)
  return result.data.plaintext
}

function makeCall(input: {
  path: string[]
  method?: SnippetMethod
  query?: Record<string, string>
  body?: string | null
  token?: string
  auth?: EngineAuth
  ip?: string | null
}): EngineCall {
  return {
    auth: input.auth ?? { kind: "bearer", token: input.token ?? world.apiKey },
    method: input.method ?? "GET",
    pathSegments: input.path,
    searchParams: new URLSearchParams(input.query ?? {}),
    bodyText: input.body ?? null,
    ip: input.ip ?? "198.51.100.23",
  }
}

/** THE SEAM: `handleEngineCall`'s second argument, so no engine test opens a socket (§4.8). */
function depsFor(stub: SheetsStub) {
  return { sheetsFor: async () => stub }
}

async function run(input: Parameters<typeof makeCall>[0]) {
  const outcome = await engine.handleEngineCall(makeCall(input), depsFor(world.stub))
  return {
    status: outcome.status,
    body: JSON.parse(outcome.body) as Envelope,
    raw: outcome.body,
    headers: outcome.headers,
  }
}

/* ---------------------------------------------------------------- bucket inspection */

/** The pinned bucket id, computed here from first principles rather than by importing the engine. */
function expectedUserBucket(userId: string): string {
  const hash = createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 32)
  return `engine:user:${hash}:d86400`
}

async function bucketRows(): Promise<Array<{ bucketKey: string; count: number }>> {
  return test.select({ bucketKey: rateLimitBuckets.bucketKey, count: rateLimitBuckets.count }).from(rateLimitBuckets)
}

async function userBuckets(): Promise<Array<{ bucketKey: string; count: number }>> {
  return (await bucketRows()).filter((row) => row.bucketKey.startsWith("engine:user:"))
}

async function userBucket(userId: string): Promise<{ bucketKey: string; count: number } | undefined> {
  return (await userBuckets()).find((row) => row.bucketKey === expectedUserBucket(userId))
}

async function logRows(): Promise<Array<Record<string, unknown>>> {
  return test.select().from(apiRequestLogs)
}

/* ---------------------------------------------------------------- the tests */

describe("engine per-user daily quota", () => {
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
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    const userId = await seedUser()
    const spreadsheetId = await seedSpreadsheet(userId)
    const secondKey = await seedKey(userId)
    world = {
      userId,
      spreadsheetId,
      apiId: await seedApi(userId, spreadsheetId, { name: "Quota roster" }),
      secondApiId: await seedApi(userId, spreadsheetId, { name: "Quota roster two" }),
      apiKey: await seedKey(userId),
      secondApiKey: secondKey,
      stub: fakeSheets({ grids: { [TAB.title]: GRID } }),
    }
  })

  afterAll(async () => {
    await stopTestDb()
  })

  describe("the default allocation", () => {
    it("reports the stored 500 as the binding window on the first call", async () => {
      const first = await run({ path: [world.apiId] })

      expect(first.status).toBe(200)
      expect(first.headers["X-RateLimit-Limit"]).toBe("500")
      expect(first.headers["X-RateLimit-Remaining"]).toBe("499")

      const bucket = await userBucket(world.userId)
      expect(bucket?.count).toBe(1)
    })

    it("hashes the bucket id — engine:user:<sha256(userId)[0..32]>:d86400, never the raw id", async () => {
      await run({ path: [world.apiId] })

      const rows = await bucketRows()
      expect(rows.map((row) => row.bucketKey)).toContain(expectedUserBucket(world.userId))
      for (const row of rows) {
        expect(row.bucketKey, row.bucketKey).not.toContain(world.userId)
      }
    })
  })

  describe("exhausting a normal user", () => {
    it("429s the call past the quota with §1.4's canonical envelope and quota wording", async () => {
      await setQuota(world.userId, 2)

      expect((await run({ path: [world.apiId] })).status).toBe(200)
      expect((await run({ path: [world.apiId] })).status).toBe(200)
      const denied = await run({ path: [world.apiId] })

      expect(denied.status).toBe(429)
      expect(denied.body.error?.code).toBe("rate_limited")
      expect(denied.body.error?.category).toBe("rate_limit")
      // The distinction the owner reads in a ticket: a DAILY QUOTA denial, not a key-window one.
      expect(denied.body.error?.message).toMatch(/daily API quota/)
      expect(denied.body.error?.message).toContain("2 requests per day")
      expect(denied.body.error?.message).not.toMatch(/API key/)

      expect(denied.headers["X-RateLimit-Limit"]).toBe("2")
      expect(denied.headers["X-RateLimit-Remaining"]).toBe("0")
      const retryAfter = Number(denied.headers["Retry-After"])
      expect(retryAfter).toBeGreaterThanOrEqual(1)
      expect(retryAfter).toBeLessThanOrEqual(86_400)
      // §4.4: the same number rides the header and `fields.retry_after`.
      expect(denied.body.error?.fields).toEqual({ retry_after: denied.headers["Retry-After"] })

      expect((await userBucket(world.userId))?.count).toBe(3)

      // And the 429 is logged like every other answer (§1.5), with its category.
      const logs = await logRows()
      expect(logs.filter((row) => row.statusCode === 429)).toHaveLength(1)
    })

    it("lets the very next call through once the owner raises the limit", async () => {
      await setQuota(world.userId, 1)
      expect((await run({ path: [world.apiId] })).status).toBe(200)
      expect((await run({ path: [world.apiId] })).status).toBe(429)

      await users.setUserApiLimit(world.userId, 5)
      const raised = await run({ path: [world.apiId] })
      expect(raised.status).toBe(200)
      expect(raised.headers["X-RateLimit-Limit"]).toBe("5")
      expect(raised.headers["X-RateLimit-Remaining"]).toBe("2")
    })

    it("counts the day across every API AND every key of that user, combined", async () => {
      await setQuota(world.userId, 3)

      // (api1, key1), (api2, key1), (api1, key2) — three different key windows, one user.
      expect((await run({ path: [world.apiId] })).status).toBe(200)
      expect((await run({ path: [world.secondApiId] })).status).toBe(200)
      expect((await run({ path: [world.apiId], token: world.secondApiKey })).status).toBe(200)
      const fourth = await run({ path: [world.secondApiId] })
      expect(fourth.status).toBe(429)
      expect(fourth.body.error?.code).toBe("rate_limited")

      const rows = await bucketRows()
      const user = rows.filter((row) => row.bucketKey.startsWith("engine:user:"))
      // ONE user counter for the whole account, and it is the one that tripped.
      expect(user).toHaveLength(1)
      expect(user[0]?.count).toBe(4)
      // The three per-(api,key) hour windows are separate rows and none of them is exhausted.
      expect(rows.filter((row) => row.bucketKey.startsWith("engine:key:") && /:h3600$/.test(row.bucketKey))).toHaveLength(3)
    })

    it("leaves the per-key hour window to deny in its own words when the user quota is open", async () => {
      await setQuota(world.userId, 0)
      const throttled = await seedApi(world.userId, world.spreadsheetId, {
        name: "Throttled one per hour",
        rateLimitPerHour: 1,
      })

      const first = await run({ path: [throttled] })
      expect(first.status).toBe(200)
      expect(first.headers["X-RateLimit-Limit"]).toBe("1")

      const second = await run({ path: [throttled] })
      expect(second.status).toBe(429)
      expect(second.body.error?.code).toBe("rate_limited")
      expect(second.body.error?.message).toContain("This API key has used up its requests")
      expect(second.body.error?.message).not.toMatch(/daily API quota/)
      expect(Number(second.headers["Retry-After"])).toBeLessThanOrEqual(3600)
      // A key-window denial never opens a user bucket: `0` means unlimited, so none exists.
      expect(await userBuckets()).toHaveLength(0)
    })
  })

  describe("who is unlimited", () => {
    it("gives an OWNER unlimited calls with api_limit_per_day = 1 (the bypass is structural)", async () => {
      const owner = await seedUser("owner")
      const sheet = await seedSpreadsheet(owner)
      const ownerApi = await seedApi(owner, sheet, { name: "Owner roster" })
      const ownerKey = await seedKey(owner)
      await setQuota(owner, 1)
      expect((await users.findUserById(owner))?.apiLimitPerDay).toBe(1)

      for (let index = 0; index < 6; index += 1) {
        const outcome = await run({ path: [ownerApi], token: ownerKey })
        expect(outcome.status, `call ${index + 1}`).toBe(200)
      }

      // Not merely "a big number": the dimension is absent, so no user bucket exists at all.
      expect(await userBuckets()).toHaveLength(0)
      // and the key windows keep their own platform numbers.
      expect((await bucketRows()).every((row) => !row.bucketKey.startsWith("engine:user:"))).toBe(true)
    })

    it("treats a stored 0 as unlimited for a normal user", async () => {
      await setQuota(world.userId, 0)

      for (let index = 0; index < 6; index += 1) {
        expect((await run({ path: [world.apiId] })).status).toBe(200)
      }
      expect(await userBuckets()).toHaveLength(0)
    })

    it("bypasses for the playground `keyId` arm too, because it is the same dispatch", async () => {
      const owner = await seedUser("owner")
      const sheet = await seedSpreadsheet(owner)
      const ownerApi = await seedApi(owner, sheet, { name: "Owner playground" })
      const ownerKey = await keys.createKey({ name: "arm", scopes: ["read"], allowedApiIds: null }, owner)
      if (!ownerKey.ok) throw new Error("seed key failed")
      await setQuota(owner, 1)

      for (let index = 0; index < 4; index += 1) {
        const outcome = await engine.handleEngineCall(
          makeCall({ path: [ownerApi], auth: { kind: "keyId", apiKeyId: ownerKey.data.id, ownerId: owner } }),
          depsFor(world.stub)
        )
        expect(outcome.status).toBe(200)
      }
      expect(await userBuckets()).toHaveLength(0)
    })
  })

  describe("placement after auth and authz", () => {
    it("consumes nothing on a 401 or a 403", async () => {
      await setQuota(world.userId, 1)

      const anonymous = await run({ path: [world.apiId], token: "sz_live_deadbeefdeadbeefdeadbeefdeadbeef" })
      expect(anonymous.status).toBe(401)
      expect(await userBuckets()).toHaveLength(0)

      const unknownApi = await run({ path: [randomUUID()] })
      expect(unknownApi.status).toBe(404)
      expect(await userBuckets()).toHaveLength(0)

      const writeDenied = await run({ path: [world.apiId], method: "POST", body: JSON.stringify({ id: "9" }) })
      expect(writeDenied.status).toBe(403)
      expect(await userBuckets()).toHaveLength(0)

      // The first authorized call is the FIRST increment, so a 1/day user still has its one call.
      expect((await run({ path: [world.apiId] })).status).toBe(200)
      expect((await userBucket(world.userId))?.count).toBe(1)
    })

    it("counts the playground `keyId` arm against the same window", async () => {
      await setQuota(world.userId, 1)
      const keyRow = await keys.createKey({ name: "arm", scopes: ["read"], allowedApiIds: null }, world.userId)
      if (!keyRow.ok) throw new Error("seed key failed")
      const auth: EngineAuth = { kind: "keyId", apiKeyId: keyRow.data.id, ownerId: world.userId }

      expect((await run({ path: [world.apiId], auth })).status).toBe(200)
      const second = await run({ path: [world.secondApiId], auth })
      expect(second.status).toBe(429)
      expect(second.body.error?.message).toMatch(/daily API quota/)
    })
  })
})
