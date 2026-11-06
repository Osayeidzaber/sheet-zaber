import { createHash, randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { isActionError } from "@/lib/action-result"
import { googleConnections, userProfiles, users } from "@/server/db/schema"

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
 * Integration tests for the Google sign-in flow against the real ephemeral embedded
 * Postgres: the handlers are called directly with a FAKE OAuthTransport (no network,
 * no browser, no real grants) and the query modules' pooled client is exercised for
 * real. Fixture refresh tokens are fabricated strings — never Google material.
 */

const CLIENT_ID = "test-client-id"
const SITE = "http://localhost:3001"
const SCOPE = "openid email profile https://www.googleapis.com/auth/spreadsheets"
const VERIFIER = "v".repeat(43)

type GoogleModule = typeof import("@/server/auth/google-oauth")
type PendingModule = typeof import("@/server/auth/pending")
type SessionModule = typeof import("@/server/auth/session")

let oauth: GoogleModule
let pending: PendingModule
let session: SessionModule
let tokens: typeof import("@/server/google/tokens")
let connections: typeof import("@/server/google/connections")
let connectionsRepo: typeof import("@/server/db/queries/google-connections")
let usersRepo: typeof import("@/server/db/queries/users")
let routeLogin: (request: Request) => Promise<Response>
let routeCallback: (request: Request) => Promise<Response>
let routeConnect: (request: Request) => Promise<Response>
let routeLogout: (request: Request) => Promise<Response>
let test: TestDb

/** Recorded revoke attempts; the stub is installed file-wide so nothing reaches Google. */
const revoked: string[] = []

beforeAll(async () => {
  let url: string
  try {
    url = inject(TEST_DB_URL_KEY)
  } catch {
    await startTestDb()
    await migrateTestDb()
    url = getTestDbUrl()
  }
  // The db client binds env.DATABASE_URL at the query modules' first import, and the
  // OAuth modules read GOOGLE_* through the same frozen env — both go in before the
  // dynamic imports below. The secret is a fixture; nothing here talks to Google.
  process.env.DATABASE_URL = url
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret-fixture"

  test = await getTestDb()
  usersRepo = await import("@/server/db/queries/users")
  connectionsRepo = await import("@/server/db/queries/google-connections")
  oauth = await import("@/server/auth/google-oauth")
  pending = await import("@/server/auth/pending")
  session = await import("@/server/auth/session")
  tokens = await import("@/server/google/tokens")
  connections = await import("@/server/google/connections")
  routeLogin = (await import("@/app/auth/google/route")).GET
  routeCallback = (await import("@/app/auth/google/callback/route")).GET
  routeConnect = (await import("@/app/auth/google/connect/route")).GET
  routeLogout = (await import("@/app/auth/logout/route")).POST
}, 300_000)

beforeEach(async () => {
  await truncateAll()
  tokens.clearAccessTokenCache()
  oauth.setOAuthTransport(null)
  revoked.length = 0
  connections.setRevokeTransport(async (token) => {
    revoked.push(token)
  })
})

afterAll(async () => {
  connections.setRevokeTransport(null)
  await stopTestDb()
})

/* Fixtures ------------------------------------------------------------------ */

type IdentityFixture = {
  sub: string
  email: string
  name: string | null
  picture: string | null
  emailVerified: boolean
  refreshToken: string
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

/** Unsigned JWT fixture — the fake transport stands in for Google's signature check. */
function makeIdToken(claims: Record<string, unknown>): string {
  return [b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })), b64url(JSON.stringify(claims)), "sig"].join(".")
}

function newFixture(over: Partial<IdentityFixture> = {}): IdentityFixture {
  const stamp = randomUUID()
  return {
    sub: `sub-${stamp}`,
    email: `google-${stamp}@example.com`,
    name: "Fixture Person",
    picture: "https://example.test/avatar.png",
    emailVerified: true,
    refreshToken: `fake-refresh-${stamp}`,
    ...over,
  }
}

/** Installs a fake transport and records every exchange attempt. */
function installFakeTransport(nonce: string, fixture: IdentityFixture): Array<{ code: string; verifier: string }> {
  const calls: Array<{ code: string; verifier: string }> = []
  oauth.setOAuthTransport({
    exchangeCode: async (code, verifier) => {
      calls.push({ code, verifier })
      return {
        idToken: makeIdToken({
          iss: "accounts.google.com",
          aud: CLIENT_ID,
          sub: fixture.sub,
          email: fixture.email,
          email_verified: fixture.emailVerified,
          name: fixture.name,
          picture: fixture.picture,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        refreshToken: fixture.refreshToken,
        scope: SCOPE,
      }
    },
    // verifyIdentity re-derives the identity from the token claims; this return value
    // exists only to satisfy the transport contract.
    verifyIdToken: async () => ({
      sub: fixture.sub,
      email: fixture.email,
      emailVerified: fixture.emailVerified,
      name: fixture.name,
      picture: fixture.picture,
    }),
  })
  return calls
}

function signedState(over: { nonce?: string; returnTo?: string; link?: boolean; exp?: number } = {}): {
  token: string
  nonce: string
} {
  const nonce = over.nonce ?? `nonce-${randomUUID()}`
  const token = oauth.signState({
    nonce,
    verifier: VERIFIER,
    returnTo: over.returnTo ?? "/overview",
    link: over.link ?? false,
    exp: over.exp,
  })
  return { token, nonce }
}

function requestWithCookies(url: string, cookies: Record<string, string>): Request {
  const header = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")
  return new Request(url, { headers: { cookie: header } })
}

function cookieHeaderFor(response: Response, name: string): string | null {
  return response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`)) ?? null
}

function cookieValueFor(response: Response, name: string): string | null {
  const header = cookieHeaderFor(response, name)
  if (!header) return null
  return header.slice(name.length + 1, header.indexOf(";"))
}

function maxAgeOf(header: string): number {
  const match = /Max-Age=(\d+)/.exec(header)
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY
}

async function callCallback(nonce: string, stateToken: string, code = "the-code"): Promise<Response> {
  return routeCallback(
    requestWithCookies(`${SITE}/auth/google/callback?code=${code}&state=${nonce}`, {
      [oauth.OAUTH_STATE_COOKIE]: stateToken,
    })
  )
}

/* GET /auth/google ------------------------------------------------------------ */

describe("GET /auth/google", () => {
  it("redirects to consent and sets the one-shot state cookie carrying the PKCE verifier", async () => {
    const response = await routeLogin(new Request(`${SITE}/auth/google`))
    expect(response.status).toBe(302)

    const consent = new URL(response.headers.get("location") ?? "")
    expect(`${consent.origin}${consent.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(consent.searchParams.get("access_type")).toBe("offline")
    expect(consent.searchParams.get("prompt")).toBe("consent")
    expect(consent.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/spreadsheets")
    expect(consent.searchParams.get("scope")).not.toContain("drive")

    const stateHeader = cookieHeaderFor(response, oauth.OAUTH_STATE_COOKIE)
    expect(stateHeader).not.toBeNull()
    expect(stateHeader).toContain("HttpOnly")
    expect(maxAgeOf(stateHeader ?? "")).toBeLessThanOrEqual(600)

    const payload = oauth.readStateCookie(cookieValueFor(response, oauth.OAUTH_STATE_COOKIE))
    expect(payload).not.toBeNull()
    expect(payload?.nonce).toBe(consent.searchParams.get("state"))
    // The URL only ever carries the challenge; the verifier stays in the HttpOnly cookie.
    expect(payload?.verifier).not.toBe(consent.searchParams.get("code_challenge"))
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256")
    expect(consent.searchParams.get("nonce")).toBe(payload?.nonce)
    expect(consent.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(payload?.verifier ?? "", "utf8").digest("base64url")
    )
  })

  it("keeps a same-site ?next and drops foreign ones", async () => {
    const good = await routeLogin(new Request(`${SITE}/auth/google?next=/overview?tab=connections`))
    const goodPayload = oauth.readStateCookie(cookieValueFor(good, oauth.OAUTH_STATE_COOKIE))
    expect(goodPayload?.returnTo).toBe("/overview?tab=connections")

    const evil = await routeLogin(new Request(`${SITE}/auth/google?next=https:/evil.example/x`))
    const evilPayload = oauth.readStateCookie(cookieValueFor(evil, oauth.OAUTH_STATE_COOKIE))
    expect(evilPayload?.returnTo).toBe("/overview")
  })
})

/* GET /auth/google/connect ---------------------------------------------------- */

describe("GET /auth/google/connect", () => {
  it("sends an anonymous caller to /login without issuing state", async () => {
    const response = await routeConnect(new Request(`${SITE}/auth/google/connect`))
    expect(response.headers.get("location")).toBe(`${SITE}/login`)
    expect(cookieHeaderFor(response, oauth.OAUTH_STATE_COOKIE)).toBeNull()
  })

  it("issues a link-flagged state cookie for a session user", async () => {
    const user = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `connect-${randomUUID()}@example.com`,
      role: "user",
    })
    const sessionToken = session.signSession({
      uid: user.id,
      role: "user",
      exp: Math.floor(Date.now() / 1000) + 600,
    })
    const response = await routeConnect(
      requestWithCookies(`${SITE}/auth/google/connect`, { [session.SESSION_COOKIE]: sessionToken })
    )
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toContain("accounts.google.com")
    const payload = oauth.readStateCookie(cookieValueFor(response, oauth.OAUTH_STATE_COOKIE))
    expect(payload?.link).toBe(true)
    expect(payload?.returnTo).toBe("/overview")
  })
})

/* GET /auth/google/callback --------------------------------------------------- */

describe("GET /auth/google/callback", () => {
  it("sends a brand-new identity to the invitation step with an encrypted sz_pending cookie", async () => {
    const { token, nonce } = signedState()
    const fixture = newFixture()
    const calls = installFakeTransport(nonce, fixture)

    const response = await callCallback(nonce, token)
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(`${SITE}/login?step=invitation`)
    // The code exchange used the cookie's verifier — the URL never carried it.
    expect(calls).toEqual([{ code: "the-code", verifier: VERIFIER }])

    const pendingHeader = cookieHeaderFor(response, pending.PENDING_COOKIE)
    expect(pendingHeader).not.toBeNull()
    expect(pendingHeader).toContain("HttpOnly")
    expect(pendingHeader).toContain("SameSite")
    expect(maxAgeOf(pendingHeader ?? "")).toBeLessThanOrEqual(600)
    // The payload decrypts to the refresh token — encrypted inside the cookie, never in the URL.
    const identity = pending.verifyPending(cookieValueFor(response, pending.PENDING_COOKIE))
    expect(identity?.refreshToken).toBe(fixture.refreshToken)
    expect(identity?.sub).toBe(fixture.sub)
    expect(identity?.email).toBe(fixture.email)
    expect(identity?.scope).toBe(SCOPE)

    expect(cookieHeaderFor(response, session.SESSION_COOKIE)).toBeNull()
    expect(cookieHeaderFor(response, oauth.OAUTH_STATE_COOKIE)).toContain("Max-Age=0")
    expect(response.headers.get("location")).not.toContain(fixture.refreshToken)
    expect(await test.select().from(users)).toHaveLength(0)
  })

  it("signs in an existing active user and stores the connection as ciphertext", async () => {
    const user = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `existing-${randomUUID()}@example.com`,
      role: "user",
    })
    const { token, nonce } = signedState({ returnTo: "/overview?tab=settings" })
    const fixture = newFixture({ sub: user.googleSub, email: user.email })
    installFakeTransport(nonce, fixture)

    const response = await callCallback(nonce, token)
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(`${SITE}/overview?tab=settings`)

    const sessionToken = cookieValueFor(response, session.SESSION_COOKIE)
    expect(session.verifySession(sessionToken)).toEqual({
      uid: user.id,
      role: "user",
      exp: expect.any(Number),
    })

    const touched = await usersRepo.findUserById(user.id)
    expect(touched?.lastLoginAt).toBeInstanceOf(Date)
    const [profile] = await test.select().from(userProfiles).where(eq(userProfiles.userId, user.id))
    expect(profile.displayName).toBe("Fixture Person")

    const rows = await test.select().from(googleConnections).where(eq(googleConnections.userId, user.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].googleEmail).toBe(fixture.email)
    expect(rows[0].scope).toBe(SCOPE)
    expect(rows[0].status).toBe("connected")
    // Ciphertext in the row, plaintext only ever inside the decrypt helper.
    expect(rows[0].refreshTokenEnc).not.toContain(fixture.refreshToken)
    expect(tokens.decryptRefreshToken(rows[0].refreshTokenEnc)).toBe(fixture.refreshToken)
    expect(cookieHeaderFor(response, oauth.OAUTH_STATE_COOKIE)).toContain("Max-Age=0")
  })

  it("rejects a disabled user with ?error=disabled and writes nothing", async () => {
    const user = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `disabled-${randomUUID()}@example.com`,
      role: "user",
    })
    await usersRepo.setUserStatus(user.id, "disabled")
    const { token, nonce } = signedState()
    installFakeTransport(nonce, newFixture({ sub: user.googleSub, email: user.email }))

    const response = await callCallback(nonce, token)
    expect(response.headers.get("location")).toBe(`${SITE}/login?error=disabled`)
    expect(cookieHeaderFor(response, session.SESSION_COOKIE)).toBeNull()
    expect(await usersRepo.findUserById(user.id)).toMatchObject({ lastLoginAt: null })
    expect(await test.select().from(googleConnections)).toHaveLength(0)
    expect(await test.select().from(userProfiles)).toHaveLength(0)
  })

  it("aborts an unverified email with ?error=email_unverified and creates no account", async () => {
    const { token, nonce } = signedState()
    installFakeTransport(nonce, newFixture({ emailVerified: false }))

    const response = await callCallback(nonce, token)
    expect(response.headers.get("location")).toBe(`${SITE}/login?error=email_unverified`)
    expect(cookieHeaderFor(response, pending.PENDING_COOKIE)).toBeNull()
    expect(await test.select().from(users)).toHaveLength(0)
  })

  it("rejects missing, mismatched and expired state before exchanging anything, and creates no user", async () => {
    const { token, nonce } = signedState()
    const calls = installFakeTransport(nonce, newFixture())

    const noCookie = await routeCallback(
      new Request(`${SITE}/auth/google/callback?code=the-code&state=${nonce}`)
    )
    expect(noCookie.headers.get("location")).toBe(`${SITE}/login?error=oauth_state`)

    const mismatched = await callCallback("someone-elses-nonce", token)
    expect(mismatched.headers.get("location")).toBe(`${SITE}/login?error=oauth_state`)

    const expired = signedState({ exp: Math.floor(Date.now() / 1000) - 60 })
    const stale = await callCallback(expired.nonce, expired.token)
    expect(stale.headers.get("location")).toBe(`${SITE}/login?error=oauth_state`)

    const forged = await callCallback(nonce, `${b64url(JSON.stringify({ nonce }))}.AAAA`)
    expect(forged.headers.get("location")).toBe(`${SITE}/login?error=oauth_state`)

    expect(calls).toHaveLength(0)
    expect(await test.select().from(users)).toHaveLength(0)
  })

  it("maps a Google consent-screen cancel to ?error=oauth_denied", async () => {
    const response = await routeCallback(
      new Request(`${SITE}/auth/google/callback?error=access_denied&state=whatever`)
    )
    expect(response.headers.get("location")).toBe(`${SITE}/login?error=oauth_denied`)
    expect(cookieHeaderFor(response, oauth.OAUTH_STATE_COOKIE)).toContain("Max-Age=0")
  })

  it("fails closed to ?error=oauth_failed when the code exchange throws", async () => {
    const { token, nonce } = signedState()
    oauth.setOAuthTransport({
      exchangeCode: async () => {
        throw new Error("invalid_grant")
      },
      verifyIdToken: async () => {
        throw new Error("unreachable in this fixture")
      },
    })

    const response = await callCallback(nonce, token)
    expect(response.headers.get("location")).toBe(`${SITE}/login?error=oauth_failed`)
    expect(await test.select().from(users)).toHaveLength(0)
  })

  it("link mode attaches the grant to the session user without a pending cookie", async () => {
    const user = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `session-${randomUUID()}@example.com`,
      role: "user",
    })
    const sessionToken = session.signSession({
      uid: user.id,
      role: "user",
      exp: Math.floor(Date.now() / 1000) + 600,
    })
    const { token, nonce } = signedState({ link: true })
    const fixture = newFixture()
    installFakeTransport(nonce, fixture)

    const response = await routeCallback(
      requestWithCookies(`${SITE}/auth/google/callback?code=the-code&state=${nonce}`, {
        [oauth.OAUTH_STATE_COOKIE]: token,
        [session.SESSION_COOKIE]: sessionToken,
      })
    )
    expect(response.headers.get("location")).toBe(`${SITE}/overview`)
    expect(cookieHeaderFor(response, pending.PENDING_COOKIE)).toBeNull()
    // A second Google account under the SAME user — never a new user row.
    expect(await test.select().from(users)).toHaveLength(1)
    const rows = await test.select().from(googleConnections).where(eq(googleConnections.userId, user.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].googleEmail).toBe(fixture.email)
  })

  it("link mode refuses to attach a Google identity owned by a different account", async () => {
    const victim = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `victim-${randomUUID()}@example.com`,
      role: "user",
    })
    const sessionUser = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `session-${randomUUID()}@example.com`,
      role: "user",
    })
    const sessionToken = session.signSession({
      uid: sessionUser.id,
      role: "user",
      exp: Math.floor(Date.now() / 1000) + 600,
    })
    const { token, nonce } = signedState({ link: true })
    installFakeTransport(nonce, newFixture({ sub: victim.googleSub, email: victim.email }))

    const response = await routeCallback(
      requestWithCookies(`${SITE}/auth/google/callback?code=the-code&state=${nonce}`, {
        [oauth.OAUTH_STATE_COOKIE]: token,
        [session.SESSION_COOKIE]: sessionToken,
      })
    )
    expect(response.headers.get("location")).toBe(`${SITE}/overview`)
    expect(await test.select().from(googleConnections)).toHaveLength(0)
  })
})

/* POST /auth/logout ----------------------------------------------------------- */

describe("POST /auth/logout", () => {
  it("clears the session cookie and redirects to /login", async () => {
    const response = await routeLogout(new Request(`${SITE}/auth/logout`, { method: "POST" }))
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(`${SITE}/login`)
    const header = cookieHeaderFor(response, session.SESSION_COOKIE)
    expect(header).not.toBeNull()
    expect(header).toContain(`${session.SESSION_COOKIE}=; `)
    expect(maxAgeOf(header ?? "")).toBe(0)
    expect(header).toContain("HttpOnly")
  })
})

/* src/server/google/connections.ts ------------------------------------------- */

describe("connection service", () => {
  it("lists the §4.6 payload and never leaks ciphertext, tokens or the user id", async () => {
    const user = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `listed-${randomUUID()}@example.com`,
      role: "user",
    })
    const fixtureToken = `fake-refresh-${randomUUID()}`
    const connection = await connections.connectGoogle({
      userId: user.id,
      googleEmail: "sheets@example.com",
      refreshToken: fixtureToken,
      scope: SCOPE,
    })
    expect(connection.status).toBe("connected")
    expect(connection).not.toHaveProperty("userId")
    expect(connection).not.toHaveProperty("refreshTokenEnc")

    const listed = await connections.listConnectionsForUser(user.id)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual({
      id: connection.id,
      googleEmail: "sheets@example.com",
      scope: SCOPE,
      status: "connected",
      connectedAt: listed[0].connectedAt,
      lastUsedAt: null,
    })
    expect(JSON.stringify(listed)).not.toContain(fixtureToken)

    const action = await connections.listConnections({ id: user.id, email: user.email, role: "user" })
    if (isActionError(action)) throw new Error(`listConnections failed: ${action.error.code}`)
    expect(action.data).toHaveLength(1)
  })

  it("revives a reauth_required row through the documented upsert", async () => {
    const user = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `revive-${randomUUID()}@example.com`,
      role: "user",
    })
    const first = await connections.connectGoogle({
      userId: user.id,
      googleEmail: "same@example.com",
      refreshToken: `fake-refresh-${randomUUID()}`,
      scope: SCOPE,
    })
    await connectionsRepo.markConnectionStatus(first.id, "reauth_required")

    const revived = await connections.connectGoogle({
      userId: user.id,
      googleEmail: "same@example.com",
      refreshToken: `fake-refresh-${randomUUID()}`,
      scope: SCOPE,
    })
    expect(revived.id).toBe(first.id)
    expect(revived.status).toBe("connected")
    expect(await connections.listConnectionsForUser(user.id)).toHaveLength(1)
  })

  it("requireUsableConnection answers with the documented codes for every state", async () => {
    const user = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `usable-${randomUUID()}@example.com`,
      role: "user",
    })

    const none = await connections.requireUsableConnection(user.id)
    expect(none).toMatchObject({ error: { code: "validation_failed", category: "validation" } })

    const connection = await connections.connectGoogle({
      userId: user.id,
      googleEmail: "usable@example.com",
      refreshToken: `fake-refresh-${randomUUID()}`,
      scope: SCOPE,
    })
    const usable = await connections.requireUsableConnection(user.id)
    expect(usable).toMatchObject({ ok: true, data: { id: connection.id, status: "connected" } })

    await connectionsRepo.markConnectionStatus(connection.id, "reauth_required")
    const dead = await connections.requireUsableConnection(user.id)
    expect(dead).toMatchObject({ error: { code: "google_reauth_required", category: "google" } })

    const scoped = await connections.requireUsableConnection(user.id, connection.id)
    expect(scoped).toMatchObject({ error: { code: "google_reauth_required", category: "google" } })
    const foreign = await connections.requireUsableConnection(user.id, randomUUID())
    expect(foreign).toMatchObject({ error: { code: "not_found", category: "not_found" } })
  })

  it("disconnectGoogle deletes owner-scoped rows and refuses foreign or unknown ids identically", async () => {
    const alice = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `alice-${randomUUID()}@example.com`,
      role: "user",
    })
    const bob = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `bob-${randomUUID()}@example.com`,
      role: "user",
    })
    const aliceToken = `fake-refresh-${randomUUID()}`
    const aliceConnection = await connections.connectGoogle({
      userId: alice.id,
      googleEmail: "alice@gmail.example",
      refreshToken: aliceToken,
      scope: SCOPE,
    })
    const bobConnection = await connections.connectGoogle({
      userId: bob.id,
      googleEmail: "bob@gmail.example",
      refreshToken: `fake-refresh-${randomUUID()}`,
      scope: SCOPE,
    })

    expect(await connections.disconnectGoogle(alice.id, bobConnection.id)).toMatchObject({
      error: { code: "not_found", category: "not_found" },
    })
    expect(await connections.disconnectGoogle(alice.id, randomUUID())).toMatchObject({
      error: { code: "not_found", category: "not_found" },
    })
    expect(await connections.listConnectionsForUser(bob.id)).toHaveLength(1)

    const gone = await connections.disconnectGoogle(alice.id, aliceConnection.id)
    expect(gone).toMatchObject({ ok: true, data: { id: aliceConnection.id } })
    expect(await connections.listConnectionsForUser(alice.id)).toHaveLength(0)
    // The decrypt happened server-side and the (fake) plaintext reached the revoke seam.
    expect(revoked).toEqual([aliceToken])

    // A revoke failure never blocks the deletion (§2).
    connections.setRevokeTransport(async () => {
      throw new Error("Google revoke unreachable")
    })
    const bobGone = await connections.disconnectGoogle(bob.id, bobConnection.id)
    expect(bobGone).toMatchObject({ ok: true, data: { id: bobConnection.id } })
    expect(await connections.listConnectionsForUser(bob.id)).toHaveLength(0)

    // The §4.7 one-argument form resolves the session user; outside a request context
    // there is none, so it answers with the same no-oracle shape.
    const carol = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `carol-${randomUUID()}@example.com`,
      role: "user",
    })
    const carolConnection = await connections.connectGoogle({
      userId: carol.id,
      googleEmail: "carol@gmail.example",
      refreshToken: `fake-refresh-${randomUUID()}`,
      scope: SCOPE,
    })
    expect(await connections.disconnectGoogle(carolConnection.id)).toMatchObject({
      error: { code: "not_found", category: "not_found" },
    })
    expect(await connections.listConnectionsForUser(carol.id)).toHaveLength(1)
  })
})

/* src/server/google/tokens.ts getAccessToken ---------------------------------- */

describe("getAccessToken", () => {
  async function seededConnection(refreshToken: string) {
    const user = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `token-${randomUUID()}@example.com`,
      role: "user",
    })
    await connections.connectGoogle({
      userId: user.id,
      googleEmail: "tokens@example.com",
      refreshToken,
      scope: SCOPE,
    })
    const [row] = await connectionsRepo.listConnections(user.id)
    return row
  }

  it("refreshes once, caches in-process, and never persists the access token", async () => {
    const refreshToken = `fake-refresh-${randomUUID()}`
    const row = await seededConnection(refreshToken)
    let hits = 0
    const accessToken = `fake-access-${randomUUID()}`

    const transport = async (received: string) => {
      hits += 1
      expect(received).toBe(refreshToken)
      return { accessToken, expiresAt: Date.now() + 60_000 }
    }

    expect(await tokens.getAccessToken(row, transport)).toBe(accessToken)
    expect(await tokens.getAccessToken(row, transport)).toBe(accessToken)
    expect(hits).toBe(1)

    const [stored] = await test.select().from(googleConnections).where(eq(googleConnections.id, row.id))
    expect(JSON.stringify(stored)).not.toContain(accessToken)
  })

  it("marks the row reauth_required and throws GoogleAuthError when refresh fails", async () => {
    const row = await seededConnection(`fake-refresh-${randomUUID()}`)
    const failing = async () => {
      throw new Error("invalid_grant")
    }

    const error = await tokens.getAccessToken(row, failing).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(tokens.GoogleAuthError)
    expect(error).toMatchObject({ reason: "refresh_failed" })
    const [stored] = await test.select().from(googleConnections).where(eq(googleConnections.id, row.id))
    expect(stored.status).toBe("reauth_required")
  })

  it("treats undecryptable ciphertext as reauth_required, never as a crash", async () => {
    const user = await usersRepo.createUser({
      googleSub: `sub-${randomUUID()}`,
      email: `corrupt-${randomUUID()}@example.com`,
      role: "user",
    })
    const row = await connectionsRepo.upsertConnection({
      userId: user.id,
      googleEmail: "corrupt@example.com",
      refreshTokenEnc: b64url("this-was-never-encrypted-with-the-key"),
      scope: SCOPE,
    })
    const transport = async () => ({ accessToken: "should-never-happen" })

    const error = await tokens.getAccessToken(row, transport).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(tokens.GoogleAuthError)
    expect(error).toMatchObject({ reason: "decrypt_failed" })
    const [stored] = await test.select().from(googleConnections).where(eq(googleConnections.id, row.id))
    expect(stored.status).toBe("reauth_required")
  })
})
