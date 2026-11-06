import { createHmac } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

import { env } from "@/lib/env"
import {
  buildClearSessionHeaders,
  buildSessionSetHeaders,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  signSession,
  verifySession,
  type SessionPayload,
} from "@/server/auth/session"

/*
 * backend-api-contract.md §4.1 / authentication-flow.md §2.
 * session.ts is pure crypto: no database, no request context, never throws.
 */

const nowSeconds = () => Math.floor(Date.now() / 1000)
const validPayload = (over: Partial<SessionPayload> = {}): SessionPayload => ({
  uid: "user-1",
  role: "user",
  exp: nowSeconds() + 3600,
  ...over,
})

function segments(token: string): [string, string] {
  const [payload, signature] = token.split(".")
  return [payload, signature]
}

function payloadJson(token: string): string {
  return Buffer.from(segments(token)[0], "base64url").toString("utf8")
}

function encode(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url")
}

function tokenWith(payload: string, signature: string): string {
  return `${payload}.${signature}`
}

function signWithSecret(payloadSegment: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadSegment, "utf8").digest("base64url")
}

describe("signSession", () => {
  it("emits base64url(payload) + \".\" + base64url(HMAC-SHA256) over those exact bytes", () => {
    const token = signSession(validPayload())
    const [payloadSegment, signature] = segments(token)

    expect(token).toContain(".")
    expect(token.split(".")).toHaveLength(2)
    expect(payloadSegment).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(signature).toBe(signWithSecret(payloadSegment, env.SESSION_SECRET))
  })

  it("serialises with a canonical key order regardless of input order", () => {
    const forward = signSession({ uid: "u", role: "owner", exp: 1_800_000_000 })
    const shuffled = signSession({ exp: 1_800_000_000, role: "owner", uid: "u" })
    expect(shuffled).toBe(forward)
    expect(payloadJson(forward)).toBe('{"uid":"u","role":"owner","exp":1800000000}')
  })

  it("round-trips both roles", () => {
    for (const role of ["user", "owner"] as const) {
      const payload = validPayload({ role })
      expect(verifySession(signSession(payload))).toEqual(payload)
    }
  })
})

describe("verifySession", () => {
  it("accepts a freshly signed token and returns exactly {uid, role, exp}", () => {
    const result = verifySession(signSession(validPayload({ uid: "abc", role: "owner" })))
    expect(result).toEqual({ uid: "abc", role: "owner", exp: result?.exp })
    expect(Object.keys(result ?? {}).sort()).toEqual(["exp", "role", "uid"])
  })

  it("rejects a tampered payload but keeps a well-formed signature segment", () => {
    const token = signSession(validPayload({ role: "user" }))
    const signature = segments(token)[1]
    const escalated = tokenWith(encode('{"uid":"user-1","role":"owner","exp":9999999999}'), signature)

    expect(verifySession(token)?.role).toBe("user")
    expect(payloadJson(escalated)).toContain('"owner"')
    expect(verifySession(escalated)).toBeNull()
  })

  it("rejects a tampered signature", () => {
    const token = signSession(validPayload())
    const [payloadSegment, signature] = segments(token)
    const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A")

    expect(verifySession(tokenWith(payloadSegment, flipped))).toBeNull()
    expect(verifySession(tokenWith(payloadSegment, ""))).toBeNull()
    expect(verifySession(tokenWith(payloadSegment, signWithSecret(payloadSegment, "a-different-secret")))).toBeNull()
  })

  it("rejects an expired exp and accepts a future one", () => {
    expect(verifySession(signSession(validPayload({ exp: nowSeconds() - 1 })))).toBeNull()
    expect(verifySession(signSession(validPayload({ exp: nowSeconds() })))).toBeNull()
    expect(verifySession(signSession(validPayload({ exp: nowSeconds() + 3600 })))).not.toBeNull()
  })

  it("rejects structurally broken tokens without throwing", () => {
    const garbage = [
      "",
      ".",
      "no-dot-at-all",
      "a.b.c",
      "....",
      "!!!.abc",
      `${encode("{}")}.`,
      `.${signWithSecret("", env.SESSION_SECRET)}`,
      tokenWith("AAAAAAAAAAAA", signWithSecret("AAAAAAAAAAAA", env.SESSION_SECRET)),
    ]
    for (const token of garbage) {
      expect(() => verifySession(token)).not.toThrow()
      expect(verifySession(token)).toBeNull()
    }
    expect(verifySession(undefined)).toBeNull()
    expect(verifySession(null)).toBeNull()
  })

  it("rejects payloads that decode but are not a valid session", () => {
    const signatureFor = (json: string) => {
      const payloadSegment = encode(json)
      return tokenWith(payloadSegment, signWithSecret(payloadSegment, env.SESSION_SECRET))
    }
    const malformed = [
      "{not json",
      "[]",
      '"a string"',
      "null",
      JSON.stringify({ uid: "u", role: "user" }),
      JSON.stringify({ uid: "u", exp: 9_999_999_999 }),
      JSON.stringify({ role: "user", exp: 9_999_999_999 }),
      JSON.stringify({ uid: "", role: "user", exp: 9_999_999_999 }),
      JSON.stringify({ uid: 42, role: "user", exp: 9_999_999_999 }),
      JSON.stringify({ uid: "u", role: "admin", exp: 9_999_999_999 }),
      JSON.stringify({ uid: "u", role: 1, exp: 9_999_999_999 }),
      JSON.stringify({ uid: "u", role: "user", exp: "9999999999" }),
      JSON.stringify({ uid: "u", role: "user", exp: null }),
      JSON.stringify({ uid: "u", role: "user", exp: Number.NaN }),
      JSON.stringify({ uid: "u", role: "user", exp: Infinity }),
    ]
    for (const json of malformed) {
      expect(verifySession(signatureFor(json)), `accepted: ${json}`).toBeNull()
    }
  })

  it("authenticates the signature only — it never consults the database", async () => {
    vi.resetModules()
    vi.stubEnv("DATABASE_URL", "postgresql://nobody:nobody@127.0.0.1:1/unreachable")
    const detached = await import("@/server/auth/session")

    const payload = validPayload({ uid: "no-such-row" })
    expect(detached.verifySession(detached.signSession(payload))).toEqual(payload)

    vi.unstubAllEnvs()
    vi.resetModules()
  })
})

describe("session constants", () => {
  it("SESSION_COOKIE is sz_session outside production and __Host-sz_session in production", async () => {
    expect(SESSION_COOKIE).toBe("sz_session")

    vi.resetModules()
    const dev = await import("@/server/auth/session")
    expect(dev.SESSION_COOKIE).toBe("sz_session")

    vi.resetModules()
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("GOOGLE_CLIENT_ID", "production-test-client-id")
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "production-test-client-secret")
    const prod = await import("@/server/auth/session")
    expect(prod.SESSION_COOKIE).toBe("__Host-sz_session")

    vi.unstubAllEnvs()
    vi.resetModules()
    const backToDev = await import("@/server/auth/session")
    expect(backToDev.SESSION_COOKIE).toBe("sz_session")
  })

  it("SESSION_MAX_AGE_SECONDS is seven days", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(604800)
  })
})

describe("Set-Cookie builders", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("carries the documented attributes and the default Max-Age", () => {
    const [value, ...rest] = buildSessionSetHeaders("token-value")
    expect(rest).toHaveLength(0)
    expect(value).toContain("sz_session=token-value")
    expect(value).toContain("HttpOnly")
    expect(value).toContain("SameSite=Lax")
    expect(value).toContain("Path=/")
    expect(value).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`)
    expect(value).not.toContain("Secure")
  })

  it("honours an explicit maxAgeSeconds", () => {
    const [value] = buildSessionSetHeaders("token-value", 60)
    expect(value).toContain("Max-Age=60")
    expect(value).not.toContain("Max-Age=604800")
  })

  it("adds Secure and the __Host- prefix only in production", async () => {
    vi.resetModules()
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("GOOGLE_CLIENT_ID", "production-test-client-id")
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "production-test-client-secret")
    const prod = await import("@/server/auth/session")
    const [value] = prod.buildSessionSetHeaders("token-value")

    expect(value).toContain("__Host-sz_session=token-value")
    expect(value).toContain("Secure")
    expect(value).toContain("HttpOnly")
    expect(value).toContain("SameSite=Lax")
    expect(value).toContain("Path=/")
    expect(value).toContain("Max-Age=604800")
  })

  it("clears with Max-Age=0 using the same attributes", () => {
    const [value] = buildClearSessionHeaders()
    expect(value).toContain("sz_session=;")
    expect(value).toContain("Max-Age=0")
    expect(value).toContain("HttpOnly")
    expect(value).toContain("SameSite=Lax")
    expect(value).toContain("Path=/")
    expect(value).not.toContain("Secure")
  })

  it("clears the __Host- name with Secure in production", async () => {
    vi.resetModules()
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("GOOGLE_CLIENT_ID", "production-test-client-id")
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "production-test-client-secret")
    const prod = await import("@/server/auth/session")
    const [value] = prod.buildClearSessionHeaders()

    expect(value).toContain("__Host-sz_session=;")
    expect(value).toContain("Max-Age=0")
    expect(value).toContain("Secure")
  })
})
