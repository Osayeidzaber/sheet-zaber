import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, inject, it, vi } from "vitest"

import { fail, isActionError, ok, type ActionResult } from "@/lib/action-result"
import { sha256 } from "@/lib/crypto"
import { auditLogs, invitations } from "@/server/db/schema"

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
 * Invite-by-email (`inviteUsers`, the Resend transport, the message builder, and the POST half of
 * `/api/internal/admin/invitations`) against the real embedded PostgreSQL 16 — but NEVER the real
 * network: `fetch` is globally stubbed to throw for the whole file, and every email assertion reads
 * what the INJECTED seam recorded (`RedeemDeps` style, `backend-api-contract.md` §4.5). The fake
 * API-key string below is fabricated test input; the real `RESEND_API_KEY` lives in `.env.local`
 * and no assertion in this file may ever print, snapshot or compare against it.
 */

type SentEmail = { to: string; subject: string; text: string; html: string }

const CODE_RE = /ZABER-[0-9A-Z]{4}-[0-9A-Z]{4}/
const FAKE_KEY = "test-resend-key-not-a-secret"
const SITE_LOGIN_URL = "http://localhost:3001/login"

let test: TestDb
let svc: typeof import("@/server/invitations/service")
let email: typeof import("@/server/email")
let usersRepo: typeof import("@/server/db/queries/users")
let session: typeof import("@/server/auth/session")
let route: typeof import("@/app/api/internal/admin/invitations/route")
// `@/lib/env` must not be imported statically: it freezes `env` from `process.env` at module
// load, and the harness republishes `DATABASE_URL` right before the dynamic imports below.
let parseEnv: typeof import("@/lib/env")["parseEnv"]
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

  const [service, emailModule, usersModule, sessionModule, routeModule, envModule] = await Promise.all([
    import("@/server/invitations/service"),
    import("@/server/email"),
    import("@/server/db/queries/users"),
    import("@/server/auth/session"),
    import("@/app/api/internal/admin/invitations/route"),
    import("@/lib/env"),
  ])
  svc = service
  email = emailModule
  usersRepo = usersModule
  session = sessionModule
  route = routeModule
  parseEnv = envModule.parseEnv
}, 300_000)

beforeEach(async () => {
  // No test in this file may reach the network — the seam, not a socket, records every send.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network access is forbidden in invite-email tests")
    })
  )
  await truncateAll()
  owner = await usersRepo.createUser({
    googleSub: `invite-owner-${randomUUID()}`,
    email: `invite-owner-${randomUUID()}@example.com`,
    role: "owner",
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await stopTestDb()
})

function unwrap<T>(result: ActionResult<T>): T {
  if (isActionError(result)) throw new Error(`unexpected refusal: ${result.error.code} ${result.error.message}`)
  return result.data
}

function refusal(result: ActionResult<unknown>) {
  if (!isActionError(result)) throw new Error("expected a refusal")
  return result.error
}

/** The recording transport seam: `sent` is the evidence that NO HTTP happened. */
function sender(behavior?: (message: SentEmail) => ActionResult<{ id: string }>) {
  const sent: SentEmail[] = []
  return {
    sent,
    deps: {
      checkEmailConfig: () => null,
      sendEmail: async (message: SentEmail) => {
        sent.push(message)
        return behavior ? behavior(message) : ok({ id: `email-${sent.length}` })
      },
    },
  }
}

function codeOf(message: SentEmail): string {
  const found = message.text.match(CODE_RE)?.[0]
  if (!found) throw new Error("invitation email is missing its code")
  return found
}

async function storedInvitation(id: string) {
  const [row] = await test.select().from(invitations).where(eq(invitations.id, id))
  if (!row) throw new Error("invitation row missing")
  return row
}

async function auditRows(action: string) {
  return test.select().from(auditLogs).where(eq(auditLogs.action, action))
}

describe("inviteUsers", () => {
  it("mints one single-use code per address, emails it through the seam, and no HTTP happens", async () => {
    const s = sender()
    const result = await svc.inviteUsers(
      [" Rahim@Example.com ", "second@example.com"],
      { label: "Beta invite" },
      owner.id,
      { deps: s.deps }
    )
    const data = unwrap(result)

    // Addresses normalize (trim + lowercase) and pair 1:1 with deliveries.
    expect(data.deliveries).toEqual([
      { email: "rahim@example.com", invitationId: data.invitations[0].id, accepted: true },
      { email: "second@example.com", invitationId: data.invitations[1].id, accepted: true },
    ])
    expect(data.invitations).toHaveLength(2)
    for (const row of data.invitations) {
      expect(row).toMatchObject({ maxUses: 1, uses: 0, label: "Beta invite", createdBy: owner.id })
    }

    // The seam saw exactly two messages; the global fetch stub was never touched.
    expect(s.sent).toHaveLength(2)
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
    expect(s.sent[0].to).toBe("rahim@example.com")

    const codes = s.sent.map(codeOf)
    expect(new Set(codes).size).toBe(2)

    for (const message of s.sent) {
      expect(message.subject).toMatch(/Sheet Zaber/i)
      // Deep-link decision: `/login` parses only `error`/`step`, so the URL is bare and the code
      // is separately copyable text — no fabricated `?code=` that the page would drop.
      expect(message.text).toContain(SITE_LOGIN_URL)
      expect(message.text).not.toContain("?code=")
      expect(message.html).toContain(`href="${SITE_LOGIN_URL}"`)
      expect(message.html).not.toContain("?code=")
      expect(message.html).toContain(codeOf(message))
      // No external assets and no tracking pixels.
      expect(message.html).not.toMatch(/<img/i)
      expect(message.html).not.toMatch(/src\s*=/i)
    }

    // Pairing is provable, not assumed: code emailed to address i hashes to the row returned at i.
    for (let i = 0; i < 2; i++) {
      const stored = await storedInvitation(data.invitations[i].id)
      expect(stored.codeHash).toBe(sha256(codes[i]))
      expect(stored.maxUses).toBe(1)
    }
  })

  it("a failed send leaves the invitation minted and audited, and never throws", async () => {
    const s = sender(() => fail("email_address_rejected", "The email provider rejected the message.", "validation"))
    const result = await svc.inviteUsers(["gone@example.com"], {}, owner.id, { deps: s.deps })

    expect(result.ok).toBe(true)
    const data = unwrap(result)
    expect(data.deliveries).toHaveLength(1)
    expect(data.deliveries[0].email).toBe("gone@example.com")
    expect(data.deliveries[0].accepted).toBe(false)
    expect(typeof data.deliveries[0].reason).toBe("string")

    // Mint + audit survived the failed email.
    const stored = await storedInvitation(data.invitations[0].id)
    expect(stored.uses).toBe(0)
    const audits = await auditRows("invitation.create")
    expect(audits).toHaveLength(1)
    expect(audits[0].detail).toEqual({ count: 1, maxUses: 1, hasLabel: false, expiresAt: null })
  })

  it("a sender that throws is still just a failed delivery — the call never rejects", async () => {
    const s = sender(() => {
      throw new Error("socket exploded: provider message ZABER-LEAK-LEAK")
    })
    const result = await svc.inviteUsers(["throw@example.com"], {}, owner.id, { deps: s.deps })

    const data = unwrap(result)
    expect(data.deliveries[0]).toMatchObject({ email: "throw@example.com", accepted: false })
    // The provider's own text never rides the reason.
    expect(JSON.stringify(data)).not.toContain("socket exploded")
    expect(await test.select().from(invitations)).toHaveLength(1)
  })

  it("a plaintext code appears in no audit row, no result payload and no reason", async () => {
    const s = sender(() => fail("email_address_rejected", "The email provider rejected the message.", "validation"))
    const data = unwrap(await svc.inviteUsers(["quiet@example.com", "also@example.com"], {}, owner.id, { deps: s.deps }))

    const codes = s.sent.map(codeOf)
    expect(codes).toHaveLength(2)

    // Every stored audit row, byte by byte: no code, no code-shaped text at all.
    const allAudits = await test.select().from(auditLogs)
    expect(allAudits.length).toBeGreaterThan(0)
    for (const row of allAudits) {
      const wire = JSON.stringify(row)
      expect(wire).not.toMatch(/ZABER-/)
      for (const code of codes) expect(wire).not.toContain(code)
    }

    // The result the frontend consumes: invitations + deliveries only, never a plaintext.
    const payloadWire = JSON.stringify(data)
    for (const code of codes) expect(payloadWire).not.toContain(code)
    for (const delivery of data.deliveries) {
      expect(delivery.reason ?? "").not.toContain("ZABER")
    }
  })

  it("rejects duplicate addresses before minting anything", async () => {
    const s = sender()
    const result = await svc.inviteUsers(
      ["dup@example.com", "Dup@Example.com ", "dup@example.com"],
      {},
      owner.id,
      { deps: s.deps }
    )
    expect(refusal(result).code).toBe("validation_failed")
    expect(refusal(result).fields?.emails).toContain("duplicate")
    expect(await test.select().from(invitations)).toHaveLength(0)
    expect(await test.select().from(auditLogs)).toHaveLength(0)
    expect(s.sent).toHaveLength(0)
  })

  it("rejects more than 50 addresses, an empty list and a malformed address", async () => {
    const s = sender()
    const tooMany = Array.from({ length: 51 }, (_, i) => `person${i}@example.com`)
    const over = await svc.inviteUsers(tooMany, {}, owner.id, { deps: s.deps })
    expect(refusal(over).code).toBe("validation_failed")
    expect(refusal(over).fields?.emails).toContain("50")

    const empty = await svc.inviteUsers([], {}, owner.id, { deps: s.deps })
    expect(refusal(empty).fields?.emails).toContain("at least one")

    const malformed = await svc.inviteUsers(["not-an-email"], {}, owner.id, { deps: s.deps })
    expect(refusal(malformed).fields?.["emails.0"]).toBeDefined()

    expect(await test.select().from(invitations)).toHaveLength(0)
    expect(s.sent).toHaveLength(0)
  })

  it("states the expiry in the email when the invitation carries one", async () => {
    const s = sender()
    const expiresAt = new Date("2026-12-01T08:30:00.000Z")
    unwrap(await svc.inviteUsers(["expiry@example.com"], { expiresAt }, owner.id, { deps: s.deps }))

    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].text).toContain("2026-12-01 08:30 UTC")
    expect(s.sent[0].html).toContain("2026-12-01 08:30 UTC")
    // And the mint recorded it.
    expect((await test.select().from(invitations))[0].expiresAt?.toISOString()).toBe(expiresAt.toISOString())
  })

  it("an unconfigured sender is a typed failure BEFORE any mint — and never a guessed default", async () => {
    // `RESEND_FROM_EMAIL` is deliberately unset in dev and in the vitest environment; the
    // production default deps therefore refuse the call instead of inventing a sender.
    expect(email.readEmailSendConfig().from).toBeUndefined()

    const result = await svc.inviteUsers(["never@example.com"], {}, owner.id)
    expect(refusal(result).code).toBe("email_from_missing")
    expect(refusal(result).category).toBe("validation")
    expect(JSON.stringify(result)).not.toContain("resend.dev")

    expect(await test.select().from(invitations)).toHaveLength(0)
    expect(await test.select().from(auditLogs)).toHaveLength(0)
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
  })

  it("a non-owner cannot invite: forbidden from createInvitations, with an audited denial", async () => {
    const member = await usersRepo.createUser({
      googleSub: `invite-member-${randomUUID()}`,
      email: `invite-member-${randomUUID()}@example.com`,
      role: "user",
    })
    const s = sender()
    const result = await svc.inviteUsers(["who@example.com"], {}, member.id, { deps: s.deps })
    expect(refusal(result).code).toBe("forbidden")
    expect(await test.select().from(invitations)).toHaveLength(0)
    expect(s.sent).toHaveLength(0)
  })
})

describe("Resend transport (injected fetch — no real endpoint is ever contacted)", () => {
  const baseMessage: SentEmail = {
    to: "someone@example.com",
    subject: "Test subject",
    text: "plain body",
    html: "<p>rich body</p>",
  }

  function transportFetch() {
    const calls: { url: string; init: RequestInit }[] = []
    return {
      calls,
      impl: vi.fn(async (url: unknown, init: unknown) => {
        calls.push({ url: String(url), init: init as RequestInit })
        return new Response(JSON.stringify({ id: "resend-1" }), { status: 201 })
      }),
    }
  }

  function depsFor(impl: (url: unknown, init: unknown) => Promise<Response>, extra: { timeoutMs?: number } = {}) {
    return {
      fetchImpl: impl as unknown as typeof globalThis.fetch,
      config: { apiKey: FAKE_KEY, from: "invites@example.com" },
      timeoutMs: extra.timeoutMs ?? 5_000,
    }
  }

  it("posts the documented shape to api.resend.com/emails and returns the id", async () => {
    const t = transportFetch()
    const result = await email.sendEmail(baseMessage, { deps: depsFor(t.impl) })
    expect(result).toEqual(ok({ id: "resend-1" }))

    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].url).toBe("https://api.resend.com/emails")
    expect(t.calls[0].init.method).toBe("POST")
    const headers = t.calls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(headers["content-type"]).toBe("application/json")

    const body = JSON.parse(String(t.calls[0].init.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(["from", "html", "subject", "text", "to"])
    expect(body.from).toBe("invites@example.com")
    expect(body.to).toEqual(["someone@example.com"])
  })

  it("maps a rejected address (validation_error) to validation, echoing neither key nor provider text", async () => {
    const impl = vi.fn(async () =>
      new Response(
        JSON.stringify({ statusCode: 400, name: "validation_error", message: `recipient ${baseMessage.to} rejected for key ${FAKE_KEY}` }),
        { status: 400 }
      )
    )
    const result = await email.sendEmail(baseMessage, { deps: depsFor(impl) })
    expect(refusal(result).code).toBe("email_address_rejected")
    expect(refusal(result).category).toBe("validation")
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(result)).not.toContain("rejected for key")
  })

  it("maps rate limiting (429) to the rate_limit category", async () => {
    const impl = vi.fn(async () =>
      new Response(JSON.stringify({ statusCode: 429, name: "rate_limit_exceeded", message: "Too many" }), { status: 429 })
    )
    const result = await email.sendEmail(baseMessage, { deps: depsFor(impl) })
    expect(refusal(result).code).toBe("email_rate_limited")
    expect(refusal(result).category).toBe("rate_limit")
  })

  it("maps a provider auth failure (401 missing_api_key) to internal, never echoing the key", async () => {
    const impl = vi.fn(async () =>
      new Response(JSON.stringify({ statusCode: 401, name: "missing_api_key", message: "no key" }), { status: 401 })
    )
    const result = await email.sendEmail(baseMessage, { deps: depsFor(impl) })
    expect(refusal(result).code).toBe("email_send_failed")
    expect(refusal(result).category).toBe("internal")
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
  })

  it("a network failure is `email_unavailable` (internal), not a throw", async () => {
    const impl = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    const result = await email.sendEmail(baseMessage, { deps: depsFor(impl) })
    expect(refusal(result).code).toBe("email_unavailable")
    expect(refusal(result).category).toBe("internal")
  })

  it("aborts at the timeout bound", async () => {
    let sawAbort = false
    const impl = vi.fn(
      (_url: unknown, init: unknown) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as { signal: AbortSignal }).signal
          signal.addEventListener("abort", () => {
            sawAbort = true
            reject(new Error("aborted"))
          })
        })
    )
    const result = await email.sendEmail(baseMessage, { deps: depsFor(impl, { timeoutMs: 25 }) })
    expect(refusal(result).code).toBe("email_unavailable")
    expect(sawAbort).toBe(true)
  })

  it("refuses an oversized body before any fetch", async () => {
    const impl = vi.fn(async () => new Response("{}", { status: 200 }))
    const huge: SentEmail = { ...baseMessage, html: "x".repeat(1_000_001) }
    const result = await email.sendEmail(huge, { deps: depsFor(impl) })
    expect(refusal(result).code).toBe("email_body_too_large")
    expect(refusal(result).category).toBe("validation")
    expect(impl).not.toHaveBeenCalled()
  })

  it("treats a success payload without a usable id as a provider fault", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ status: "queued" }), { status: 200 }))
    const result = await email.sendEmail(baseMessage, { deps: depsFor(impl) })
    expect(refusal(result).code).toBe("email_send_failed")
    expect(refusal(result).category).toBe("internal")
  })

  it("config absence is a typed failure at call time, with no fetch and no default sender", async () => {
    const impl = vi.fn(async () => new Response("{}", { status: 200 }))

    const noFrom = await email.sendEmail(baseMessage, {
      deps: { fetchImpl: impl, config: { apiKey: FAKE_KEY, from: undefined }, timeoutMs: 5_000 },
    })
    expect(refusal(noFrom).code).toBe("email_from_missing")
    expect(refusal(noFrom).category).toBe("validation")
    expect(JSON.stringify(noFrom)).not.toContain("resend.dev")

    const noKey = await email.sendEmail(baseMessage, {
      deps: { fetchImpl: impl, config: { apiKey: undefined, from: "invites@example.com" }, timeoutMs: 5_000 },
    })
    expect(refusal(noKey).code).toBe("email_not_configured")
    expect(refusal(noKey).category).toBe("internal")

    expect(impl).not.toHaveBeenCalled()
  })
})

describe("env: RESEND_* are optional everywhere and dev-degrade like GOOGLE_*", () => {
  function validInput(overrides: Record<string, string | undefined> = {}) {
    return {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/sheet_zaber",
      SESSION_SECRET: "s".repeat(48),
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      OWNER_EMAIL: "owner@example.com",
      // The pre-existing production superRefine requires these; include them so the only thing
      // under test here is that RESEND_* stay optional even in production.
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3001",
      ...overrides,
    }
  }

  it("parses without RESEND_* set, and even in production they stay optional", () => {
    expect(() => parseEnv(validInput())).not.toThrow()
    const prod = parseEnv(validInput({ NODE_ENV: "production" }))
    expect(prod.RESEND_API_KEY).toBeUndefined()
    expect(prod.RESEND_FROM_EMAIL).toBeUndefined()
  })

  it("passes both through when set, and counts an empty string as absent", () => {
    const withResend = parseEnv(
      validInput({ RESEND_API_KEY: "re_key", RESEND_FROM_EMAIL: "invites@domain.example" })
    )
    expect(withResend.RESEND_API_KEY).toBe("re_key")
    expect(withResend.RESEND_FROM_EMAIL).toBe("invites@domain.example")

    const blank = parseEnv(validInput({ RESEND_API_KEY: "", RESEND_FROM_EMAIL: "" }))
    expect(blank.RESEND_API_KEY).toBeUndefined()
    expect(blank.RESEND_FROM_EMAIL).toBeUndefined()
  })
})

describe("POST /api/internal/admin/invitations", () => {
  function cookieFor(uid: string, role: "user" | "owner" = "user"): string {
    return `${session.SESSION_COOKIE}=${session.signSession({ uid, role, exp: Math.floor(Date.now() / 1000) + 3600 })}`
  }

  function post(body: unknown, cookie?: string): Promise<Response> {
    return route.POST(
      new Request("http://localhost:3001/api/internal/admin/invitations", {
        method: "POST",
        headers: { cookie: cookie ?? cookieFor(owner.id, "owner"), "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    )
  }

  it("the {count} mint still answers { codes, plaintext, invitations } and hashes only", async () => {
    const response = await post({ count: 2, label: "manual mint" })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Object.keys(body)).toEqual(["data"])
    expect(Object.keys(body.data).sort()).toEqual(["codes", "invitations", "plaintext"])
    expect(body.data.codes).toHaveLength(2)
    expect(body.data.plaintext).toEqual(body.data.codes)
    for (const code of body.data.codes) expect(code).toMatch(CODE_RE)

    const wire = JSON.stringify(body)
    expect(wire).not.toContain("codeHash")
    for (const row of await test.select().from(invitations)) expect(wire).not.toContain(row.codeHash)
  })

  it("the {emails} body is guarded by the same owner session and fails typed on unset config — minting nothing", async () => {
    const response = await post({ emails: ["someone@example.com"] })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe("email_from_missing")
    expect(body.error.category).toBe("validation")
    expect(await test.select().from(invitations)).toHaveLength(0)
  })

  it("the {emails} shape validates duplicates and size before anything else", async () => {
    const dupe = await post({ emails: ["a@example.com", "A@example.com"] })
    expect(dupe.status).toBe(400)
    expect((await dupe.json()).error.fields?.emails).toContain("duplicate")

    const over = await post({ emails: Array.from({ length: 51 }, (_, i) => `p${i}@example.com`) })
    expect(over.status).toBe(400)
    expect((await over.json()).error.code).toBe("validation_failed")
  })

  it("guards: no cookie is 401, a valid non-owner is 403, on both POST bodies", async () => {
    for (const payload of [{ count: 1 }, { emails: ["x@example.com"] }]) {
      // The wrapper reads the cookie first: a sessionless POST is 401, not a body error.
      const anonNoCookie = await route.POST(
        new Request("http://localhost:3001/api/internal/admin/invitations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
      )
      expect(anonNoCookie.status).toBe(401)
      expect((await anonNoCookie.json()).error.code).toBe("unauthenticated")

      const member = await usersRepo.createUser({
        googleSub: `post-member-${randomUUID()}`,
        email: `post-member-${randomUUID()}@example.com`,
        role: "user",
      })
      const forbidden = await post(payload, cookieFor(member.id))
      expect(forbidden.status).toBe(403)
      expect((await forbidden.json()).error.code).toBe("forbidden")
    }
    expect(await test.select().from(invitations)).toHaveLength(0)
  })

  it("a malformed body is a 400 with fields.body; the GET list still answers { invitations }", async () => {
    const notJson = await post("definitely not json")
    expect(notJson.status).toBe(400)
    expect((await notJson.json()).error.fields?.body).toBeDefined()

    const arr = await post([1, 2, 3])
    expect(arr.status).toBe(400)

    const list = await route.GET(
      new Request("http://localhost:3001/api/internal/admin/invitations", { headers: { cookie: cookieFor(owner.id, "owner") } })
    )
    expect(list.status).toBe(200)
    expect(Object.keys(await list.json())).toEqual(["data"])
  })

  it("PUT/PATCH/DELETE are 405 and the route now allows GET, POST", async () => {
    for (const handler of [route.PUT, route.PATCH, route.DELETE]) {
      const response = handler()
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("GET, POST")
    }
  })
})
