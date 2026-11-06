import { createHash } from "node:crypto"

import { describe, expect, it, afterEach } from "vitest"

import {
  GOOGLE_OAUTH_SCOPES,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_SECONDS,
  GoogleOAuthError,
  buildAuthUrl,
  buildClearStateHeaders,
  buildStateSetHeaders,
  decodeIdTokenClaims,
  enforceIdTokenClaims,
  generatePkce,
  getOAuthTransport,
  googleOAuthTransport,
  readStateCookie,
  sanitizeReturnTo,
  setOAuthTransport,
  signState,
  verifyIdentity,
  type GoogleIdentity,
} from "@/server/auth/google-oauth"
import {
  GoogleAuthError,
  decryptRefreshToken,
  encryptRefreshToken,
} from "@/server/google/tokens"

/*
 * Pure-unit tests for the Google sign-in boundary: PKCE, the one-shot state cookie,
 * the consent URL parameter set, ID-token claim enforcement, and refresh-token
 * encryption. No database, no network, no real Google anywhere in this file.
 */

const CLIENT_ID = "unit-test-client-id"
const NONCE = "n".repeat(32)
const FUTURE = Math.floor(Date.now() / 1000) + 3600

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

/** Unsigned JWT: three segments, signature never verified — these are fixtures, not grants. */
function makeIdToken(claims: Record<string, unknown>): string {
  return [b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })), b64url(JSON.stringify(claims)), "sig"].join(".")
}

function validClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "accounts.google.com",
    aud: CLIENT_ID,
    sub: "1122334455",
    email: "someone@example.com",
    email_verified: true,
    name: "Someone",
    picture: "https://example.test/avatar.png",
    nonce: NONCE,
    exp: FUTURE,
    ...over,
  }
}

describe("generatePkce", () => {
  it("derives the S256 challenge as unpadded base64url of sha256(verifier)", () => {
    const { verifier, challenge } = generatePkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash("sha256").update(verifier, "utf8").digest("base64url"))
  })

  it("issues a fresh verifier per call", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier)
  })
})

describe("buildAuthUrl", () => {
  const url = new URL(buildAuthUrl({ state: "st-1", challenge: "ch-1", clientId: CLIENT_ID }))

  it("targets Google's authorize endpoint with the v1 identity+spreadsheets scope", () => {
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    const scopes = (url.searchParams.get("scope") ?? "").split(" ")
    expect(scopes).toEqual([...GOOGLE_OAUTH_SCOPES])
    // Only drive.file is requested, so nothing can browse a person's Drive.
    expect(url.searchParams.get("scope")).not.toContain("drive.readonly")
  })

  it("requests offline+consent grants and the S256 PKCE challenge", () => {
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("select_account consent")
    expect(url.searchParams.get("include_granted_scopes")).toBe("true")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("code_challenge")).toBe("ch-1")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe("st-1")
    // The state doubles as the ID-token nonce — verifyIdentity enforces it downstream.
    expect(url.searchParams.get("nonce")).toBe("st-1")
  })

  it("sends the callback at the configured site root", () => {
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3001/auth/google/callback")
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
  })

  it("refuses to build a URL without a client id", () => {
    expect(() => buildAuthUrl({ state: "s", challenge: "c", clientId: "" })).toThrow(
      /oauth_not_configured/
    )
  })
})

describe("sanitizeReturnTo", () => {
  it("keeps same-site paths and drops everything else", () => {
    expect(sanitizeReturnTo("/overview?tab=settings")).toBe("/overview?tab=settings")
    expect(sanitizeReturnTo("https://evil.example/x")).toBeNull()
    expect(sanitizeReturnTo("//evil.example")).toBeNull()
    expect(sanitizeReturnTo("/\\evil.example")).toBeNull()
    expect(sanitizeReturnTo("overview")).toBeNull()
    expect(sanitizeReturnTo(null)).toBeNull()
  })
})

describe("state cookie sign/read", () => {
  const payload = {
    nonce: NONCE,
    verifier: "v".repeat(43),
    returnTo: "/overview",
    link: false,
  }

  it("round-trips every field", () => {
    const read = readStateCookie(signState(payload))
    expect(read).not.toBeNull()
    expect(read?.nonce).toBe(NONCE)
    expect(read?.verifier).toBe(payload.verifier)
    expect(read?.returnTo).toBe("/overview")
    expect(read?.link).toBe(false)
    expect(read?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it("carries the link flag for the re-consent branch", () => {
    expect(readStateCookie(signState({ ...payload, link: true }))?.link).toBe(true)
  })

  it("rejects tampered payloads and re-signed forgeries", () => {
    const signed = signState(payload)
    const [segment, signature] = signed.split(".")
    const flippedSegment = (segment[0] === "A" ? "B" : "A") + segment.slice(1)
    expect(readStateCookie(`${flippedSegment}.${signature}`)).toBeNull()
    expect(readStateCookie(`${segment}.${signature.slice(0, -2)}AA`)).toBeNull()
    // Resigning an edited payload without the secret still fails: the signature drops off.
    expect(readStateCookie(`${b64url(JSON.stringify({ ...payload, exp: FUTURE }))}.x`)).toBeNull()
  })

  it("rejects expired and malformed tokens", () => {
    expect(readStateCookie(signState({ ...payload, exp: FUTURE - 7200 }))).toBeNull()
    expect(readStateCookie("garbage")).toBeNull()
    expect(readStateCookie(undefined)).toBeNull()
  })

  it("builds HttpOnly SameSite headers and a 10-minute max age", () => {
    const set = buildStateSetHeaders(signState(payload))
    expect(set).toHaveLength(1)
    expect(set[0]).toContain(`${OAUTH_STATE_COOKIE}=`)
    expect(set[0]).toContain("HttpOnly")
    expect(set[0]).toContain("SameSite=Lax")
    expect(set[0]).toContain(`Max-Age=${OAUTH_STATE_MAX_AGE_SECONDS}`)
    expect(OAUTH_STATE_MAX_AGE_SECONDS).toBeLessThanOrEqual(600)

    const clear = buildClearStateHeaders()
    expect(clear[0]).toContain(`${OAUTH_STATE_COOKIE}=; `)
    expect(clear[0]).toContain("Max-Age=0")
  })
})

describe("enforceIdTokenClaims", () => {
  it("surfaces email_verified instead of assuming it", () => {
    const identity = enforceIdTokenClaims(
      decodeIdTokenClaims(makeIdToken(validClaims({ email_verified: false }))),
      NONCE,
      CLIENT_ID
    )
    expect(identity.emailVerified).toBe(false)
    expect(identity.sub).toBe("1122334455")
    expect(identity.name).toBe("Someone")
  })

  it("accepts both documented issuers and rejects anything else", () => {
    for (const iss of ["accounts.google.com", "https://accounts.google.com"]) {
      expect(() => enforceIdTokenClaims(validClaims({ iss }), NONCE, CLIENT_ID)).not.toThrow()
    }
    expect(() => enforceIdTokenClaims(validClaims({ iss: "https://evil.example" }), NONCE, CLIENT_ID)).toThrow(
      GoogleOAuthError
    )
    expect(() => enforceIdTokenClaims(validClaims({ iss: "https://evil.example" }), NONCE, CLIENT_ID)).toThrow(
      /issuer/
    )
  })

  it("enforces aud, exp, nonce and the required subject claims", () => {
    expect(() => enforceIdTokenClaims(validClaims({ aud: "other-client" }), NONCE, CLIENT_ID)).toThrow(
      /audience/
    )
    expect(() => enforceIdTokenClaims(validClaims({ exp: 1 }), NONCE, CLIENT_ID)).toThrow(/expired/)
    expect(() => enforceIdTokenClaims(validClaims({ nonce: "different" }), NONCE, CLIENT_ID)).toThrow(
      /nonce/
    )
    expect(() => enforceIdTokenClaims(validClaims({ sub: "" }), NONCE, CLIENT_ID)).toThrow(/subject/)
    expect(() => enforceIdTokenClaims(validClaims({ email: undefined }), NONCE, CLIENT_ID)).toThrow(/email/)
    expect(() => enforceIdTokenClaims(validClaims(), NONCE, undefined)).toThrow(/audience/)
  })

  it("never echoes claim values in the error message", () => {
    try {
      enforceIdTokenClaims(validClaims({ aud: "super-secret-audience" }), NONCE, CLIENT_ID)
      expect.unreachable("claim enforcement did not throw")
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleOAuthError)
      expect((error as Error).message).not.toContain("super-secret-audience")
      expect((error as GoogleOAuthError).reason).toBe("invalid_aud")
    }
  })

  it("rejects malformed ID tokens at the decode step", () => {
    expect(() => decodeIdTokenClaims("not-a-jwt")).toThrow(/Malformed/)
    expect(() => decodeIdTokenClaims("a.%%%.c")).toThrow(/Malformed/)
  })
})

describe("verifyIdentity with a fake transport", () => {
  afterEach(() => {
    setOAuthTransport(null)
  })

  it("enforces claims from the token itself, not from what the transport returned", async () => {
    const rogueIdentity: GoogleIdentity = {
      sub: "attacker-sub",
      email: "attacker@example.com",
      emailVerified: true,
      name: null,
      picture: null,
    }
    const fake = {
      exchangeCode: async () => ({ idToken: "", refreshToken: "", scope: "" }),
      verifyIdToken: async () => rogueIdentity,
    }
    // The returned identity comes from the signed token's claims, never from the transport.
    const identity = await verifyIdentity(makeIdToken(validClaims()), NONCE, fake, CLIENT_ID)
    expect(identity.sub).toBe("1122334455")
    expect(identity.email).toBe("someone@example.com")
    expect(identity.emailVerified).toBe(true)

    const wrongAudience = makeIdToken(validClaims({ aud: "other-client" }))
    await expect(verifyIdentity(wrongAudience, NONCE, fake, CLIENT_ID)).rejects.toThrow(/audience/)
    const wrongNonce = makeIdToken(validClaims({ nonce: "other" }))
    await expect(verifyIdentity(wrongNonce, NONCE, fake, CLIENT_ID)).rejects.toThrow(/nonce/)
  })

  it("fails when the transport's signature check fails", async () => {
    const failing = {
      exchangeCode: async () => ({ idToken: "", refreshToken: "", scope: "" }),
      verifyIdToken: async () => {
        throw new Error("certificate fetch failed")
      },
    }
    await expect(verifyIdentity(makeIdToken(validClaims()), NONCE, failing)).rejects.toThrow(
      /certificate/
    )
  })

  it("exposes a swappable transport seam that restores the real one", () => {
    expect(getOAuthTransport()).toBe(googleOAuthTransport)
    setOAuthTransport({
      exchangeCode: async () => ({ idToken: "", refreshToken: "", scope: "" }),
      verifyIdToken: async () => {
        throw new Error("never reaches Google")
      },
    })
    expect(getOAuthTransport()).not.toBe(googleOAuthTransport)
    setOAuthTransport(null)
    expect(getOAuthTransport()).toBe(googleOAuthTransport)
  })
})

describe("encryptRefreshToken / decryptRefreshToken", () => {
  const fixture = "fake-refresh-token-never-a-real-grant"

  it("round-trips and produces opaque, distinct ciphertexts", () => {
    const once = encryptRefreshToken(fixture)
    const twice = encryptRefreshToken(fixture)
    // Fresh 12-byte IV per call: the same plaintext never shares a payload.
    expect(once).not.toBe(twice)
    expect(once).not.toContain(fixture)
    expect(Buffer.from(once, "base64").toString("utf8")).not.toContain(fixture)
    expect(decryptRefreshToken(once)).toBe(fixture)
    expect(decryptRefreshToken(twice)).toBe(fixture)
  })

  it("throws on a tampered payload, never returning partial plaintext", () => {
    const payload = encryptRefreshToken(fixture)
    const chars = payload.split("")
    const flip = chars.length - 8 // inside the ciphertext, away from padding
    chars[flip] = chars[flip] === "A" ? "B" : "A"
    expect(() => decryptRefreshToken(chars.join(""))).toThrow(/decrypt_failed/)
    expect(() => decryptRefreshToken("!!!not-base64!!!")).toThrow(/decrypt_failed/)
    expect(() => decryptRefreshToken("")).toThrow(/decrypt_failed/)
  })

  it("GoogleAuthError is typed and carries a static message", () => {
    const error = new GoogleAuthError("refresh_failed", "The Google connection needs re-authorization.")
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("GoogleAuthError")
    expect(error.reason).toBe("refresh_failed")
  })
})
