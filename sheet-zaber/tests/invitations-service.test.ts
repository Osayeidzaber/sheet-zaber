import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { fail, isActionError, type ActionResult } from "@/lib/action-result"

import {
  auditLogs,
  googleConnections,
  invitationRedemptions,
  invitations,
  rateLimitBuckets,
  userProfiles,
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
 * Invitation service + `POST /auth/invitation` against the real embedded PostgreSQL 16
 * (`tests/smoke.test.ts` harness shape: DATABASE_URL is republished before the modules that read
 * `src/lib/env.ts` are first imported, so their own pooled `db` reaches the test instance).
 * No Google calls, no browser, no network.
 */

type Pending = import("@/server/auth/pending").PendingIdentity

const PENDING_EXPIRED = {
  error: {
    code: "pending_expired",
    message: "That sign-in is no longer active. Connect with Google again.",
    category: "auth",
  },
}

describe("invitation service and invitation route", () => {
  let test: TestDb
  let env: typeof import("@/lib/env")["env"]
  let sha256: typeof import("@/lib/crypto")["sha256"]
  let aesGcmDecrypt: typeof import("@/lib/crypto")["aesGcmDecrypt"]
  let recordAudit: typeof import("@/server/admin/audit")["recordAudit"]
  let pendingLib: typeof import("@/server/auth/pending")
  let sessionLib: typeof import("@/server/auth/session")
  let usersRepo: typeof import("@/server/db/queries/users")
  let svc: typeof import("@/server/invitations/service")
  let route: typeof import("@/app/auth/invitation/route")
  let owner: { id: string }

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

    const [envModule, crypto, audit, pending, session, usersModule, service, invitationRoute] = await Promise.all([
      import("@/lib/env"),
      import("@/lib/crypto"),
      import("@/server/admin/audit"),
      import("@/server/auth/pending"),
      import("@/server/auth/session"),
      import("@/server/db/queries/users"),
      import("@/server/invitations/service"),
      import("@/app/auth/invitation/route"),
    ])
    env = envModule.env
    sha256 = crypto.sha256
    aesGcmDecrypt = crypto.aesGcmDecrypt
    recordAudit = audit.recordAudit
    pendingLib = pending
    sessionLib = session
    usersRepo = usersModule
    svc = service
    route = invitationRoute
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    owner = await usersRepo.createUser({
      googleSub: `owner-sub-${randomUUID()}`,
      email: `owner-${randomUUID()}@example.com`,
      role: "owner",
    })
  })

  afterAll(async () => {
    await stopTestDb()
  })

  function identity(overrides: Partial<Pending> = {}): Pending {
    const stamp = randomUUID()
    return {
      sub: `invitee-sub-${stamp}`,
      email: `invitee-${stamp}@example.com`,
      name: "Rahim Uddin",
      picture: "https://lh3.googleusercontent.com/a/avatar",
      exp: Math.floor(Date.now() / 1000) + 600,
      refreshToken: `fake-refresh-${stamp}`,
      scope: "openid email https://www.googleapis.com/auth/spreadsheets",
      ...overrides,
    }
  }

  /** `signPending` → `verifyPending` is the proof that the cookie contract is what the service reads. */
  function roundTrip(overrides: Partial<Pending> = {}): Pending {
    const value = identity(overrides)
    const verified = pendingLib.verifyPending(pendingLib.signPending(value))
    if (!verified) throw new Error("pending cookie round-trip failed")
    return verified
  }

  function unwrap<T>(result: ActionResult<T>): T {
    if (isActionError(result)) throw new Error(`unexpected refusal: ${result.error.code} ${result.error.message}`)
    return result.data
  }

  function refusal(result: ActionResult<unknown>) {
    if (!isActionError(result)) throw new Error("expected a refusal")
    return result.error
  }

  async function createCodes(count: number, extra: { maxUses?: number; expiresAt?: Date } = {}): Promise<string[]> {
    return unwrap(await svc.createInvitations({ count, ...extra }, owner.id)).codes
  }

  async function invitationFor(code: string): Promise<{ id: string; uses: number }> {
    const [row] = await test.select().from(invitations).where(eq(invitations.codeHash, sha256(code)))
    if (!row) throw new Error("invitation row missing")
    return { id: row.id, uses: row.uses }
  }

  function post(options: {
    code?: string | null
    pending?: string | null
    ip?: string
    accept?: string
    form?: boolean
    returnTo?: string
  }): Request {
    const headers: Record<string, string> = {
      "x-forwarded-for": `${options.ip ?? "203.0.113.10"}, 10.0.0.1`,
      "content-type": options.form ? "application/x-www-form-urlencoded" : "application/json",
    }
    if (options.accept) headers.accept = options.accept
    if (options.pending) headers.cookie = `${pendingLib.PENDING_COOKIE}=${options.pending}`
    const body = options.form
      ? new URLSearchParams({ code: options.code ?? "" }).toString()
      : JSON.stringify({ code: options.code ?? "" })
    const url = `http://localhost:3001/auth/invitation${
      options.returnTo ? `?returnTo=${encodeURIComponent(options.returnTo)}` : ""
    }`
    return new Request(url, { method: "POST", headers, body })
  }

  function clearedPending(response: Response): boolean {
    return response
      .headers.getSetCookie()
      .some((cookie) => cookie.startsWith(`${pendingLib.PENDING_COOKIE}=`) && cookie.includes("Max-Age=0"))
  }

  it("returns N plaintext codes once and stores only their hashes", async () => {
    const created = unwrap(await svc.createInvitations({ count: 3, label: "for Rahim", maxUses: 2 }, owner.id))
    expect(created.codes).toHaveLength(3)
    expect(created.plaintext).toEqual(created.codes)
    expect(created.invitations).toHaveLength(3)
    expect(new Set(created.codes).size).toBe(3)
    for (const code of created.codes) expect(code).toMatch(/^ZABER-[0-9A-Z]{4}-[0-9A-Z]{4}$/)

    const rows = await test.select().from(invitations)
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.codeHash).sort()).toEqual(created.codes.map((code) => sha256(code)).sort())
    for (const row of rows) {
      // No returned plaintext survives anywhere in the stored row.
      expect(Object.values(row).some((value) => typeof value === "string" && created.codes.includes(value))).toBe(false)
      expect(row).toMatchObject({ label: "for Rahim", maxUses: 2, uses: 0, createdBy: owner.id, revokedAt: null })
    }

    const listed = unwrap(await svc.listInvitationsForOwner())
    expect(listed).toHaveLength(3)
    for (const item of listed) {
      expect(item).not.toHaveProperty("codeHash")
      expect(item).not.toHaveProperty("code_hash")
    }

    const audit = await test.select().from(auditLogs).where(eq(auditLogs.action, "invitation.create"))
    expect(audit).toHaveLength(1)
    expect(audit[0].actorId).toBe(owner.id)
    expect(audit[0].detail).toEqual({ count: 3, maxUses: 2, hasLabel: true, expiresAt: null })
  })

  it("refuses a non-owner with an audited denial and a zod-validated body", async () => {
    const member = await usersRepo.createUser({
      googleSub: `member-sub-${randomUUID()}`,
      email: `member-${randomUUID()}@example.com`,
      role: "user",
    })

    expect(await svc.createInvitations({ count: 1 }, member.id)).toEqual(
      fail("forbidden", "You are not allowed to do that.", "auth")
    )
    expect(await test.select().from(invitations)).toHaveLength(0)

    const audit = await test.select().from(auditLogs).where(eq(auditLogs.action, "invitation.create"))
    expect(audit).toHaveLength(1)
    expect(audit[0].actorId).toBe(member.id)
    expect(audit[0].detail).toEqual({ outcome: "denied" })

    expect(await svc.createInvitations({ count: 0 }, owner.id)).toMatchObject({
      error: { code: "validation_failed", category: "validation", fields: { count: expect.any(String) } },
    })
    expect(await svc.createInvitations({ count: 3, maxUses: 5000 }, owner.id)).toMatchObject({
      error: { code: "validation_failed", fields: { maxUses: expect.any(String) } },
    })
  })

  it("redeems once through the whole registration graph in one commit", async () => {
    const [code] = await createCodes(1)
    const pending = roundTrip()

    const result = unwrap(await svc.redeemInvitation({ ip: null, plaintextCode: code, pending }))
    expect(result).toMatchObject({ email: pending.email, role: "user" })

    const [user] = await test.select().from(users).where(eq(users.googleSub, pending.sub))
    expect(user).toMatchObject({ email: pending.email, role: "user", status: "active" })
    expect(result.userId).toBe(user.id)
    expect(user.invitationId).toHaveLength(36)

    const [profile] = await test.select().from(userProfiles).where(eq(userProfiles.userId, user.id))
    expect(profile.displayName).toBe("Rahim Uddin")
    expect(profile.pictureUrl).toBe(pending.picture)

    const [connection] = await test.select().from(googleConnections).where(eq(googleConnections.userId, user.id))
    // `verifyPending` hands back the plaintext refresh token; the column must hold ciphertext.
    expect(connection.refreshTokenEnc).not.toBe(pending.refreshToken)
    expect(connection.refreshTokenEnc).not.toContain(pending.refreshToken)
    expect(aesGcmDecrypt(connection.refreshTokenEnc, env.TOKEN_ENCRYPTION_KEY)).toBe(pending.refreshToken)
    expect(connection).toMatchObject({ googleEmail: pending.email, scope: pending.scope, status: "connected" })

    const [redemption] = await test
      .select()
      .from(invitationRedemptions)
      .where(eq(invitationRedemptions.redeemedBy, user.id))
    expect(redemption.invitationId).toBe(user.invitationId)

    const [invitation] = await test.select().from(invitations).where(eq(invitations.id, redemption.invitationId))
    expect(invitation.uses).toBe(1)

    const audit = await test.select().from(auditLogs).where(eq(auditLogs.action, "invitation.redeem"))
    expect(audit).toHaveLength(1)
    expect(audit[0].actorId).toBe(user.id)
    expect(audit[0].subjectId).toBe(invitation.id)
    expect(audit[0].detail).toEqual({ role: "user" })
  })

  it("grants the owner role at INSERT only for OWNER_EMAIL", async () => {
    const [code] = await createCodes(1)
    const pending = roundTrip({ email: env.OWNER_EMAIL.toUpperCase() })

    const result = unwrap(await svc.redeemInvitation({ ip: null, plaintextCode: code, pending }))
    expect(result.role).toBe("owner")
    const [user] = await test.select().from(users).where(eq(users.id, result.userId))
    expect(user.role).toBe("owner")

    const other = roundTrip()
    expect(unwrap(await svc.redeemInvitation({ ip: null, plaintextCode: (await createCodes(1))[0], pending: other })).role).toBe("user")
  })

  it("elects exactly one winner when two identities race a single-use code", async () => {
    const [code] = await createCodes(1)
    const results = await Promise.all([
      svc.redeemInvitation({ ip: null, plaintextCode: code, pending: roundTrip() }),
      svc.redeemInvitation({ ip: null, plaintextCode: code, pending: roundTrip() }),
    ])

    expect(results.filter((result) => !isActionError(result))).toHaveLength(1)
    expect(results.find((result) => isActionError(result))).toEqual(svc.invalidInvitationError())
    expect(await test.select().from(users)).toHaveLength(2) // owner + exactly one invitee
    expect(await test.select().from(invitationRedemptions)).toHaveLength(1)
    const [invitation] = await test.select().from(invitations)
    expect(invitation.uses).toBe(1)
  })

  it("rolls the whole redemption back when a later step throws", async () => {
    const [code] = await createCodes(1)
    const pending = roundTrip()

    const failed = await svc.redeemInvitation(
      { ip: null, plaintextCode: code, pending },
      {
        deps: {
          recordAudit: async () => {
            throw new Error("forced rollback")
          },
        },
      }
    )
    expect(failed).toEqual(fail("internal_error", "The request could not be completed.", "internal"))

    const [invitation] = await test.select().from(invitations)
    expect(invitation.uses).toBe(0)
    expect(await test.select().from(users)).toHaveLength(1)
    expect(await test.select().from(userProfiles)).toHaveLength(0)
    expect(await test.select().from(googleConnections)).toHaveLength(0)
    expect(await test.select().from(invitationRedemptions)).toHaveLength(0)
    expect(await test.select().from(auditLogs)).toHaveLength(1) // only invitation.create survived

    // The counter was never consumed, so the same code still works.
    expect(unwrap(await svc.redeemInvitation({ ip: null, plaintextCode: code, pending })).userId).toHaveLength(36)
  })

  it("maps a duplicate identity to already_registered without persisting anything", async () => {
    const [code] = await createCodes(1)
    const pending = roundTrip()
    await usersRepo.createUser({ googleSub: pending.sub, email: `taken-${randomUUID()}@example.com`, role: "user" })

    expect(await svc.redeemInvitation({ ip: null, plaintextCode: code, pending })).toEqual(
      fail("already_registered", "This Google account already has a Sheet Zaber account.", "auth")
    )
    const [invitation] = await test.select().from(invitations)
    expect(invitation.uses).toBe(0)
    expect(await test.select().from(users)).toHaveLength(2)
    expect(await test.select().from(invitationRedemptions)).toHaveLength(0)
  })

  it("throttles the IP dimension inside the service, so a server action cannot bypass it", async () => {
    // The route is not the only door: `/login` redeems through `submitInvitation` directly, so
    // a bucket held by the adapter would leave that path unlimited (`backend-api-contract.md` §2).
    const [code] = await createCodes(1)
    const offender = "198.51.100.23"
    const statuses: string[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // A fresh pending identity each time, so only the shared IP can be what refuses.
      const result = await svc.redeemInvitation({
        ip: offender,
        plaintextCode: "ZABER-0000-0000",
        pending: roundTrip(),
      })
      statuses.push(isActionError(result) ? result.error.code : "redeemed")
    }
    expect(statuses).toEqual(["invalid_invitation", "invalid_invitation", "invalid_invitation", "invalid_invitation", "invalid_invitation"])

    const goodCode = await svc.redeemInvitation({ ip: offender, plaintextCode: code, pending: roundTrip() })
    expect(refusal(goodCode).code).toBe("rate_limited")
    expect(goodCode).toMatchObject({
      error: { category: "rate_limit", fields: { retry_after: expect.any(String) } },
    })
    expect(await test.select().from(invitationRedemptions)).toHaveLength(0)

    const bystander = await svc.redeemInvitation({ ip: "198.51.100.24", plaintextCode: code, pending: roundTrip() })
    expect(isActionError(bystander)).toBe(false)
  })

  it("answers revoked, expired, exhausted, unknown and malformed codes with identical bytes", async () => {
    const [revokedCode, , spentCode] = await createCodes(3, { maxUses: 1 })
    const revoked = await invitationFor(revokedCode)
    expect(unwrap(await svc.revokeInvitation(revoked.id, owner.id))).toEqual({ id: revoked.id })

    const [datePass] = await createCodes(1, { expiresAt: new Date(Date.now() - 60_000) })
    unwrap(await svc.redeemInvitation({ ip: null, plaintextCode: spentCode, pending: roundTrip() }))

    const envelopes = await Promise.all(
      [revokedCode, datePass, spentCode, "ZABER-0000-0000", "not-even-a-code"].map((code) =>
        svc.redeemInvitation({ ip: null, plaintextCode: code, pending: roundTrip() })
      )
    )
    const bytes = envelopes.map((envelope) => JSON.stringify(envelope))
    for (const envelope of bytes) expect(envelope).toBe(bytes[0])
    expect(bytes[0]).toBe(
      '{"error":{"code":"invalid_invitation","message":"invitation code is not valid","category":"auth"}}'
    )
    for (const envelope of envelopes) {
      expect(refusal(envelope).message).toBe("invitation code is not valid")
      expect(refusal(envelope).category).toBe("auth")
      expect(refusal(envelope).fields).toBeUndefined()
    }

    // The refusals wrote no user, and the spent code stayed spent: one increment, no double count.
    expect(await test.select().from(users)).toHaveLength(2)
    expect((await invitationFor(spentCode)).uses).toBe(1)
    expect((await invitationFor(datePass)).uses).toBe(0)
  })

  it("refuses a missing, stale or tampered pending identity with pending_expired", async () => {
    const [code] = await createCodes(1)
    const stale = identity({ exp: Math.floor(Date.now() / 1000) - 1 })

    expect(await svc.redeemInvitation({ ip: null, plaintextCode: code, pending: null })).toEqual(PENDING_EXPIRED)
    expect(await svc.redeemInvitation({ ip: null, plaintextCode: code, pending: stale })).toEqual(PENDING_EXPIRED)
    // A tampered cookie verifies to `null`, which is the same refusal — no extra signal.
    expect(pendingLib.verifyPending(`${pendingLib.signPending(identity())}x`)).toBeNull()
    expect(await test.select().from(users)).toHaveLength(1)
  })

  it("revokes idempotently, keeps the first timestamp and audits each call", async () => {
    const [code] = await createCodes(1)
    const { id } = await invitationFor(code)

    expect(unwrap(await svc.revokeInvitation(id, owner.id))).toEqual({ id })
    const [afterFirst] = await test.select().from(invitations).where(eq(invitations.id, id))
    expect(afterFirst.revokedAt).toBeInstanceOf(Date)

    expect(unwrap(await svc.revokeInvitation(id, owner.id))).toEqual({ id })
    const [afterSecond] = await test.select().from(invitations).where(eq(invitations.id, id))
    expect(afterSecond.revokedAt?.getTime()).toBe(afterFirst.revokedAt?.getTime())
    expect(await test.select().from(auditLogs).where(eq(auditLogs.action, "invitation.revoke"))).toHaveLength(2)

    expect(await svc.redeemInvitation({ ip: null, plaintextCode: code, pending: roundTrip() })).toEqual(
      svc.invalidInvitationError()
    )
    expect(await svc.revokeInvitation("not-a-uuid", owner.id)).toMatchObject({
      error: { code: "validation_failed", fields: { id: expect.any(String) } },
    })
    const member = await usersRepo.createUser({
      googleSub: `member-sub-${randomUUID()}`,
      email: `member-${randomUUID()}@example.com`,
      role: "user",
    })
    expect(await svc.revokeInvitation(id, member.id)).toEqual(
      fail("forbidden", "You are not allowed to do that.", "auth")
    )

    // Two successful revokes of this invitation, one audited denial, and nothing else.
    const revoked = await test.select().from(auditLogs).where(eq(auditLogs.action, "invitation.revoke"))
    expect(revoked.filter((row) => row.subjectId === id)).toHaveLength(2)
    expect(revoked.filter((row) => row.actorId === member.id)).toHaveLength(1)
  })

  it("clears the pending cookie on success and issues a session built from the DB row", async () => {
    const [code] = await createCodes(1)
    const pending = roundTrip()

    const response = await route.POST(post({ code, pending: pendingLib.signPending(pending), form: true }))
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/overview")
    expect(clearedPending(response)).toBe(true)

    const sessionCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${sessionLib.SESSION_COOKIE}=`))
    expect(sessionCookie).toBeDefined()
    const token = sessionCookie?.split(";")[0]?.slice(sessionCookie.indexOf("=") + 1)
    const payload = sessionLib.verifySession(token ?? null)
    expect(payload?.role).toBe("user")

    const [user] = await test.select().from(users).where(eq(users.googleSub, pending.sub))
    expect(payload?.uid).toBe(user.id)
    expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 600)
    expect(await test.select().from(invitationRedemptions)).toHaveLength(1)
  })

  it("answers a JSON submit with a body, honours a relative returnTo and blocks an absolute one", async () => {
    const [first, second] = await createCodes(2)

    const jsonResponse = await route.POST(
      post({
        code: first,
        pending: pendingLib.signPending(roundTrip()),
        ip: "198.51.100.1",
        accept: "application/json",
        returnTo: "/admin/invitations",
      })
    )
    expect(jsonResponse.status).toBe(200)
    expect(await jsonResponse.json()).toEqual({ ok: true, redirect: "/admin/invitations" })

    const hijack = await route.POST(
      post({
        code: second,
        pending: pendingLib.signPending(roundTrip()),
        ip: "198.51.100.2",
        form: true,
        returnTo: "https://evil.example/x",
      })
    )
    expect(hijack.status).toBe(303)
    expect(hijack.headers.get("location")).toBe("/overview")
  })

  it("clears the pending cookie only when the cookie is the cause of the failure", async () => {
    const [code] = await createCodes(1)

    const noCookie = await route.POST(post({ code, ip: "192.0.2.50" }))
    expect(noCookie.status).toBe(401)
    expect(await noCookie.json()).toEqual(PENDING_EXPIRED)
    expect(clearedPending(noCookie)).toBe(true)

    const badCode = await route.POST(
      post({ code: "ZABER-0000-0000", pending: pendingLib.signPending(roundTrip()), ip: "192.0.2.51" })
    )
    expect(badCode.status).toBe(401)
    expect(await badCode.json()).toEqual(svc.invalidInvitationError())
    expect(badCode.headers.getSetCookie()).toHaveLength(0)

    const missingBody = await route.POST(post({ code: null, ip: "192.0.2.52" }))
    expect(missingBody.status).toBe(400)
    expect(await missingBody.json()).toMatchObject({
      error: { code: "validation_failed", category: "validation", fields: { code: "invitation code is not valid" } },
    })
    expect(missingBody.headers.getSetCookie()).toHaveLength(0)
  })

  it("returns 429 with retry-after after five attempts in the window, per IP and per cookie", async () => {
    const pending = pendingLib.signPending(roundTrip())
    const statuses: number[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await route.POST(post({ code: "ZABER-0000-0000", pending, ip: "192.0.2.77" }))
      statuses.push(response.status)
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401])

    const sixth = await route.POST(post({ code: "ZABER-0000-0000", pending, ip: "192.0.2.77" }))
    expect(sixth.status).toBe(429)
    const retryAfter = Number(sixth.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(900)
    expect(await sixth.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many attempts. Try again later.",
        category: "rate_limit",
        fields: { retry_after: expect.any(String) },
      },
    })

    // A fresh cookie on the exhausted IP is still refused: the IP dimension throttles alone.
    const otherCookie = await route.POST(
      post({ code: "ZABER-0000-0000", pending: pendingLib.signPending(roundTrip()), ip: "192.0.2.77" })
    )
    expect(otherCookie.status).toBe(429)

    const keys = await test.select({ bucketKey: rateLimitBuckets.bucketKey }).from(rateLimitBuckets)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key.bucketKey).toMatch(/^invite:(ip|sub):[0-9a-f]{32}:m15$/)
      expect(key.bucketKey).not.toContain("192.0.2.77")
      expect(key.bucketKey).not.toContain("invitee-sub-")
    }
    expect(await test.select().from(users)).toHaveLength(1)
  })

  it("scrubs secret-shaped detail before an audit row is written", async () => {
    await recordAudit({
      actorId: owner.id,
      action: "settings.update",
      subjectType: "platform",
      detail: {
        code: "ZABER-ABCD-EFGH",
        codeHash: sha256("ZABER-ABCD-EFGH"),
        refreshToken: "1//fake-token-material",
        email: "someone@example.com",
        nested: { token: "abc", perUser: { digest: sha256("other"), kept: 7 } },
        outcome: "denied",
      },
    })

    const [row] = await test.select().from(auditLogs).where(eq(auditLogs.action, "settings.update"))
    // Secret-NAMED keys are dropped; a secret-SHAPED value under a benign name keeps its place
    // as a marker, so the audit row still shows that something was there.
    expect(row.detail).toEqual({
      nested: { perUser: { digest: "[redacted]", kept: 7 } },
      outcome: "denied",
    })
    expect(JSON.stringify(row.detail)).not.toContain(sha256("ZABER-ABCD-EFGH"))
    expect(JSON.stringify(row.detail)).not.toContain("ZABER-ABCD-EFGH")
    expect(JSON.stringify(row.detail)).not.toContain("someone@example.com")
  })
})
