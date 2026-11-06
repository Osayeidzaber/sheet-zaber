import { randomUUID } from "node:crypto"

import { eq, inArray } from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import pg from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import * as schema from "@/server/db/schema"
import { users } from "@/server/db/schema"

import { getTestDbUrl, migrateTestDb, startTestDb, stopTestDb } from "./helpers/db"

/*
 * backend-api-contract.md §4.2 / authentication-flow.md §2 rule 2: the guards are the
 * security boundary, so this runs against a real (embedded) PostgreSQL with real `users`
 * rows, and the real session module signs the cookies.
 *
 * `src/server/db/client.ts` binds its pool to `env.DATABASE_URL` at module load, so the
 * URL is repointed at the test instance before the guarded modules are first imported.
 */

type GuardsModule = typeof import("@/server/auth/guards")
type SessionModule = typeof import("@/server/auth/session")
type ClientModule = typeof import("@/server/db/client")

let startupError: unknown = null
let guardsModule: GuardsModule | undefined
let sessionModule: SessionModule | undefined
let cookieName = "sz_session"
let testDb: NodePgDatabase<typeof schema> | undefined
let adminPool: pg.Pool | undefined
let originalDatabaseUrl: string | undefined
const clientModules: ClientModule[] = []
const createdIds: string[] = []

beforeAll(async () => {
  try {
    originalDatabaseUrl = process.env.DATABASE_URL
    await startTestDb()
    await migrateTestDb()

    const url = getTestDbUrl()
    process.env.DATABASE_URL = url
    adminPool = new pg.Pool({ connectionString: url, max: 2 })
    testDb = drizzle(adminPool, { schema })

    clientModules.push(await import("@/server/db/client"))
    guardsModule = await import("@/server/auth/guards")
    sessionModule = await import("@/server/auth/session")
    cookieName = sessionModule.SESSION_COOKIE
  } catch (error) {
    startupError = error
    console.error("[guards.test] embedded Postgres unavailable:", error)
  }
}, 300_000)

afterAll(async () => {
  if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl
  for (const client of clientModules.splice(0)) {
    await client.getPool().end().catch(() => {})
  }
  await adminPool?.end().catch(() => {})
  await stopTestDb().catch(() => {})
})

afterEach(async () => {
  if (testDb && createdIds.length > 0) {
    await testDb.delete(users).where(inArray(users.id, createdIds))
    createdIds.splice(0, createdIds.length)
  }
  vi.doUnmock("next/headers")
  vi.resetModules()
})

interface Ctx {
  skip: () => never
}

function guards(ctx: Ctx): GuardsModule {
  if (startupError) ctx.skip()
  if (!guardsModule) throw new Error("guards module missing without a startup error")
  return guardsModule
}

function session(ctx: Ctx): SessionModule {
  if (startupError) ctx.skip()
  if (!sessionModule) throw new Error("session module missing without a startup error")
  return sessionModule
}

function db(ctx: Ctx): NodePgDatabase<typeof schema> {
  if (startupError) ctx.skip()
  if (!testDb) throw new Error("test database missing without a startup error")
  return testDb
}

async function insertUser(
  ctx: Ctx,
  over: Partial<{ role: string; status: string }> = {}
): Promise<{ id: string; email: string; role: string; status: string }> {
  const id = randomUUID()
  const row = {
    id,
    googleSub: `sub-${id}`,
    email: `guard-${id}@example.com`,
    role: "user",
    status: "active",
    ...over,
  }
  await db(ctx).insert(users).values(row)
  createdIds.push(id)
  return row
}

function signedToken(ctx: Ctx, uid: string, role: "user" | "owner", expOffset = 3600): string {
  return session(ctx).signSession({
    uid,
    role,
    exp: Math.floor(Date.now() / 1000) + expOffset,
  })
}

function requestWith(headerValue?: string): Request {
  const headers = new Headers()
  if (headerValue !== undefined) headers.set("cookie", headerValue)
  return new Request("http://localhost:3001/overview", { headers })
}

async function failure(error: Promise<unknown>): Promise<unknown> {
  return error.then(
    () => null,
    (reason: unknown) => reason
  )
}

function redirectDigest(error: unknown): string {
  return (error as { digest?: string } | null)?.digest ?? ""
}

/** Re-import the guards with Next's cookie store answering in place of a Request. */
async function withCookieStore(token: string | null): Promise<GuardsModule> {
  vi.resetModules()
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      get: (name: string) =>
        name === cookieName && token !== null ? { name, value: token } : undefined,
    }),
  }))
  clientModules.push(await import("@/server/db/client"))
  return import("@/server/auth/guards")
}

describe("readUser", () => {
  it("returns {id, email, role} for a valid cookie backed by an active row", async (ctx) => {
    const g = guards(ctx)
    const row = await insertUser(ctx, { role: "owner" })

    const result = await g.readUser(requestWith(`${cookieName}=${signedToken(ctx, row.id, "owner")}`))

    expect(result).toEqual({ id: row.id, email: row.email, role: "owner" })
  })

  it("returns the DB role, never the role the cookie claims", async (ctx) => {
    const g = guards(ctx)
    const row = await insertUser(ctx, { role: "user" })

    const result = await g.readUser(
      requestWith(`${cookieName}=${signedToken(ctx, row.id, "owner")}`)
    )

    expect(result?.role).toBe("user")
    expect(result).toEqual({ id: row.id, email: row.email, role: "user" })
  })

  it("rejects a disabled account on its next request, even with a perfect signature", async (ctx) => {
    const g = guards(ctx)
    const row = await insertUser(ctx, { status: "disabled" })
    const token = signedToken(ctx, row.id, "user")

    expect(await g.readUser(requestWith(`${cookieName}=${token}`))).toBeNull()

    await db(ctx).update(users).set({ status: "active" }).where(eq(users.id, row.id))
    expect(await g.readUser(requestWith(`${cookieName}=${token}`))).not.toBeNull()
  })

  it("rejects a valid signature for a row that does not exist", async (ctx) => {
    const g = guards(ctx)
    const token = signedToken(ctx, randomUUID(), "owner")

    expect(await g.readUser(requestWith(`${cookieName}=${token}`))).toBeNull()
  })

  it("rejects forged, foreign-named and expired cookies", async (ctx) => {
    const g = guards(ctx)
    const row = await insertUser(ctx)

    expect(await g.readUser(requestWith(`${cookieName}=${row.id}.forged`))).toBeNull()
    expect(await g.readUser(requestWith(undefined))).toBeNull()
    expect(await g.readUser(requestWith("other_cookie=1; sz_other=2"))).toBeNull()
    expect(
      await g.readUser(
        requestWith(`${cookieName}=${signedToken(ctx, row.id, "user", -1)}`)
      )
    ).toBeNull()
  })

  it("reads the session cookie among other cookies in the same header", async (ctx) => {
    const g = guards(ctx)
    const row = await insertUser(ctx)
    const token = signedToken(ctx, row.id, "user")

    expect(await g.readUser(requestWith(`theme=dark; ${cookieName}=${token}; csrf=abc`))).toEqual({
      id: row.id,
      email: row.email,
      role: "user",
    })
  })

  it("returns null with no Request and no cookie store, without throwing", async (ctx) => {
    const g = guards(ctx)

    await expect(g.readUser()).resolves.toBeNull()
    await expect(g.readOwner()).resolves.toBeNull()
  })
})

describe("readOwner", () => {
  it("returns the user for an owner row", async (ctx) => {
    const g = guards(ctx)
    const row = await insertUser(ctx, { role: "owner" })
    const request = requestWith(`${cookieName}=${signedToken(ctx, row.id, "owner")}`)

    expect(await g.readOwner(request)).toEqual({ id: row.id, email: row.email, role: "owner" })
  })

  it("returns null for a regular user", async (ctx) => {
    const g = guards(ctx)
    const row = await insertUser(ctx, { role: "user" })
    const request = requestWith(`${cookieName}=${signedToken(ctx, row.id, "user")}`)

    expect(await g.readOwner(request)).toBeNull()
  })

  it("returns null for an owner-claiming cookie on a user row", async (ctx) => {
    const g = guards(ctx)
    const row = await insertUser(ctx, { role: "user" })
    const request = requestWith(`${cookieName}=${signedToken(ctx, row.id, "owner")}`)

    expect(await g.readOwner(request)).toBeNull()
  })

  it("returns null for a disabled owner", async (ctx) => {
    const g = guards(ctx)
    const row = await insertUser(ctx, { role: "owner", status: "disabled" })
    const request = requestWith(`${cookieName}=${signedToken(ctx, row.id, "owner")}`)

    expect(await g.readOwner(request)).toBeNull()
  })
})

describe("requireUser / requireOwner", () => {
  it("redirects to /login when there is no session", async (ctx) => {
    const g = guards(ctx)

    expect(redirectDigest(await failure(g.requireUser()))).toContain("/login")
    expect(redirectDigest(await failure(g.requireOwner()))).toContain("/login")
  })

  it("redirects to /login when the session row was disabled", async (ctx) => {
    const g = await withCookieStore(signedToken(ctx, (await insertUser(ctx, { status: "disabled" })).id, "user"))

    expect(redirectDigest(await failure(g.requireUser()))).toContain("/login")
  })

  it("resolves the cookie store when no Request is passed", async (ctx) => {
    const row = await insertUser(ctx, { role: "user" })
    const g = await withCookieStore(signedToken(ctx, row.id, "owner"))

    expect(await g.readUser()).toEqual({ id: row.id, email: row.email, role: "user" })
    expect(await g.requireUser()).toEqual({ id: row.id, email: row.email, role: "user" })
  })

  it("requireOwner returns the owner and redirects a valid non-owner to /overview", async (ctx) => {
    const ownerRow = await insertUser(ctx, { role: "owner" })
    const ownerGuards = await withCookieStore(signedToken(ctx, ownerRow.id, "owner"))
    expect(await ownerGuards.requireOwner()).toEqual({
      id: ownerRow.id,
      email: ownerRow.email,
      role: "owner",
    })

    const memberRow = await insertUser(ctx, { role: "user" })
    const memberGuards = await withCookieStore(signedToken(ctx, memberRow.id, "owner"))
    expect(redirectDigest(await failure(memberGuards.requireOwner()))).toContain("/overview")
    expect(await memberGuards.requireUser()).toEqual({
      id: memberRow.id,
      email: memberRow.email,
      role: "user",
    })
  })
})
