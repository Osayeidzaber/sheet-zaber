import { randomUUID } from "node:crypto"

import { beforeAll, afterAll, beforeEach, describe, expect, inject, it } from "vitest"
import { eq } from "drizzle-orm"

import { getTestDb, getTestDbUrl, migrateTestDb, startTestDb, stopTestDb, TEST_DB_URL_KEY, truncateAll } from "./helpers/db"
import { apiConfigurations, apiRequestLogs, registeredSpreadsheets, users } from "@/server/db/schema"

/*
 * Regressions for the backend hardening pass: durable logs, the owner floor, the owner's rate bypass,
 * restored spreadsheets, the CSRF check, the email timeout and the invitation copy.
 */

type Actor = { id: string; role: "owner" | "user"; email: string }

let admin: typeof import("@/server/admin/users")
let logs: typeof import("@/server/db/queries/logs")
let sheets: typeof import("@/server/db/queries/spreadsheets")
let connections: typeof import("@/server/db/queries/google-connections")
let rate: typeof import("@/server/engine/ratelimit")
let keys: typeof import("@/server/keys/service")
let http: typeof import("@/server/http/internal-route")
let request: typeof import("@/server/http/request")
let email: typeof import("@/server/email/client")
let invite: typeof import("@/server/email/invitation")
let test: Awaited<ReturnType<typeof getTestDb>>

async function insertUser(role: "owner" | "user" = "user"): Promise<Actor> {
  const id = randomUUID()
  const address = `hardening-${id}@example.com`
  await test.insert(users).values({ id, googleSub: `sub-${id}`, email: address, role })
  return { id, role, email: address }
}

async function insertApi(userId: string, name: string): Promise<{ apiId: string; sheetId: string }> {
  const connection = await connections.upsertConnection({
    userId,
    googleEmail: `conn-${randomUUID()}@example.com`,
    refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0",
    scope: "openid",
  })
  const sheet = await sheets.upsertSpreadsheet({
    userId,
    connectionId: connection.id,
    googleSheetId: `sheet-${randomUUID()}`,
    title: "Roster",
    tabs: [],
  })
  const apiId = randomUUID()
  await test.insert(apiConfigurations).values({
    id: apiId,
    userId,
    spreadsheetId: sheet.id,
    name,
    tabTitle: "Sheet1",
    allowedOperations: ["GET"],
  })
  return { apiId, sheetId: sheet.id }
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
  process.env.DATABASE_URL = url
  test = await getTestDb()
  admin = await import("@/server/admin/users")
  logs = await import("@/server/db/queries/logs")
  sheets = await import("@/server/db/queries/spreadsheets")
  connections = await import("@/server/db/queries/google-connections")
  rate = await import("@/server/engine/ratelimit")
  keys = await import("@/server/keys/service")
  http = await import("@/server/http/internal-route")
  request = await import("@/server/http/request")
  email = await import("@/server/email/client")
  invite = await import("@/server/email/invitation")
}, 300_000)

beforeEach(async () => {
  await truncateAll()
})

afterAll(async () => {
  await stopTestDb()
})

describe("durable request logs", () => {
  it("keeps the row and the API's name after the API and then the account are deleted", async () => {
    const owner = await insertUser("owner")
    const member = await insertUser()
    const { apiId } = await insertApi(member.id, "Roster API")
    await logs.insertRequestLog({ apiId, userId: member.id, method: "GET", path: "/api/v1/x", statusCode: 200, durationMs: 1 })

    await test.delete(apiConfigurations).where(eq(apiConfigurations.id, apiId))
    expect(await test.select().from(apiRequestLogs)).toMatchObject([{ apiId: null, apiName: "Roster API", userId: member.id }])

    expect("data" in (await admin.deleteUser(member.id, owner))).toBe(true)
    expect(await test.select().from(apiRequestLogs)).toMatchObject([
      { apiId: null, apiName: "Roster API", userId: null, userEmail: member.email },
    ])
  })
})

describe("the owner floor", () => {
  it("cannot be crossed by two owners disabling each other at once", async () => {
    const [a, b] = [await insertUser("owner"), await insertUser("owner")]
    await Promise.all([admin.setUserStatus(b.id, "disabled", a), admin.setUserStatus(a.id, "disabled", b)])

    const active = await test.select().from(users).where(eq(users.status, "active"))
    expect(active.filter((row) => row.role === "owner")).toHaveLength(1)
  })
})

describe("the owner's rate bypass", () => {
  it("consumes no window, whatever the limits, and advertises none", async () => {
    const owner = await insertUser("owner")
    const verdict = await rate.consumeEngineRate({ apiId: "a", keyId: "k", userId: owner.id, ip: "1.2.3.4", hourLimit: 1, dayLimit: 1, ipLimit: 1 })
    const again = await rate.consumeEngineRate({ apiId: "a", keyId: "k", userId: owner.id, ip: "1.2.3.4", hourLimit: 1, dayLimit: 1, ipLimit: 1 })
    expect(verdict.allowed && again.allowed).toBe(true)
    expect(rate.rateLimitHeaders(again)).toEqual({})
  })
})

describe("restored spreadsheets", () => {
  it("clears inaccessible when a refresh succeeds", async () => {
    const member = await insertUser()
    const { sheetId } = await insertApi(member.id, "Any")
    await sheets.setSpreadsheetStatus(sheetId, "inaccessible")
    await sheets.updateSpreadsheetTabs(sheetId, [])
    const [row] = await test.select().from(registeredSpreadsheets).where(eq(registeredSpreadsheets.id, sheetId))
    expect(row.status).toBe("active")
  })
})

describe("key ownership comes first", () => {
  it("answers api_not_found to a restricted key probing a foreign API", () => {
    const decision = keys.authorizeKeyCall(
      { id: "k", userId: "alice", scopes: ["read"], allowedApiIds: ["other"], name: "k" },
      { id: "bobs", userId: "bob", permissions: "read", allowedOperations: ["GET"] },
      "GET"
    )
    expect(decision).toEqual({ ok: false, code: "api_not_found" })
  })
})

describe("CSRF on internal writes", () => {
  const route = () => http.userRoute(() => ({ ok: true, data: {} }) as never)

  it("refuses a foreign Origin before reading the session, and leaves reads and same-origin alone", async () => {
    const post = (headers: Record<string, string>) => new Request("http://localhost:3001/api/internal/x", { method: "POST", headers })
    expect((await route()(post({ origin: "https://evil.example" }))).status).toBe(403)
    expect((await route()(post({ "sec-fetch-site": "cross-site" }))).status).toBe(403)
    // No session in these, so getting past the check means 401.
    expect((await route()(post({ origin: "http://localhost:3001" }))).status).toBe(401)
    expect((await route()(new Request("http://localhost:3001/api/internal/x", { headers: { origin: "https://evil.example" } }))).status).toBe(401)
  })
})

describe("database TLS config", () => {
  it("verifies remote hosts, even when the URL says sslmode=require", async () => {
    const { pgConnectionConfig } = await import("@/lib/db-connection")
    const remote = pgConnectionConfig("postgresql://u:p@db.example.com:5432/d?sslmode=require", "A\\nB")
    expect(remote.connectionString).toBe("postgresql://u:p@db.example.com:5432/d")
    expect(remote.ssl).toEqual({ rejectUnauthorized: true, ca: "A\nB" })
    expect(pgConnectionConfig("postgresql://u:p@localhost:5433/d").ssl).toBeUndefined()
  })
})

describe("the trusted client IP header", () => {
  it("ignores a spoofed x-forwarded-for once configured", () => {
    process.env.CLIENT_IP_HEADER = "true-client-ip"
    try {
      const headers = { "x-forwarded-for": "6.6.6.6", "true-client-ip": "1.2.3.4" }
      expect(request.clientIp(new Request("http://x/", { headers }))).toBe("1.2.3.4")
      expect(request.clientIp(new Request("http://x/", { headers: { "x-forwarded-for": "6.6.6.6" } }))).toBe(null)
    } finally {
      delete process.env.CLIENT_IP_HEADER
    }
  })
})

describe("POST /auth/invitation", () => {
  it("reads a JSON body that arrives without a JSON content type", async () => {
    const { POST } = await import("@/app/auth/invitation/route")
    const response = await POST(
      new Request("http://localhost:3001/auth/invitation", {
        method: "POST",
        headers: { accept: "application/json" },
        body: JSON.stringify({ code: "ZABER-AAAA-BBBB" }),
      })
    )
    // Past body parsing, the missing sign-in cookie is the refusal, not "a code is required".
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("pending_expired")
  })
})

describe("unknown clients", () => {
  it("share one throttle bucket instead of skipping it", () => {
    expect(request.clientBucketIp(new Request("http://x/"))).toBe("unknown-client")
    expect(request.clientBucketIp(new Request("http://x/", { headers: { "x-real-ip": "1.1.1.1" } }))).toBe("1.1.1.1")
  })
})

describe("invitation email", () => {
  it("promises single use only for a single-use code", () => {
    const build = (maxUses: number) => invite.buildInvitationEmail({ to: "a@example.com", code: "ZABER-AAAA-BBBB", expiresAt: null, maxUses }).text
    expect(build(1)).toContain("works exactly once")
    expect(build(5)).toContain("can be used 5 times")
    expect(build(5)).not.toContain("exactly once")
  })

  it("times out a provider that stalls while sending the body", async () => {
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")))
        },
      })
      return new Response(body, { status: 200 })
    }) as typeof fetch
    const result = await email.sendEmail(
      { to: "a@example.com", subject: "s", text: "t", html: "h" },
      { deps: { fetchImpl, timeoutMs: 20, config: { apiKey: "k", from: "f@example.com" } } }
    )
    expect("error" in result).toBe(true)
  })
})
