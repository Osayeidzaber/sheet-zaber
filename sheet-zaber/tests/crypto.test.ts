import { randomBytes } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  generateApiKey,
  generateInvitationCode,
  randomHex,
  sha256,
  timingSafeEqualStr,
} from "@/lib/crypto"

/**
 * Pure primitives over node:crypto — no env, no database.
 * Keys below are base64 of exactly 32 bytes, as TOKEN_ENCRYPTION_KEY requires.
 */
function keyBase64(): string {
  return randomBytes(32).toString("base64")
}

function errorMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected the call to throw, but it did not")
}

describe("randomHex", () => {
  it("returns lowercase hex of exactly 2*bytes chars", () => {
    for (const size of [1, 8, 16, 32]) {
      expect(randomHex(size)).toMatch(new RegExp(`^[0-9a-f]{${size * 2}}$`))
    }
  })

  it("returns a different value on every call", () => {
    expect(randomHex(16)).not.toBe(randomHex(16))
  })

  it("rejects non-positive or non-integer sizes", () => {
    expect(errorMessage(() => randomHex(0))).not.toBe("")
    expect(errorMessage(() => randomHex(1.5))).not.toBe("")
  })
})

describe("sha256", () => {
  it("matches the known vector for 'abc'", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  it("is deterministic and empty-string stable", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256("token")).toBe(sha256("token"))
  })
})

describe("aesGcmEncrypt / aesGcmDecrypt", () => {
  it("round-trips plaintext, including unicode and empty strings", () => {
    const key = keyBase64()
    for (const plaintext of ["hello world", "", "µ€🔐", "a".repeat(10_000)]) {
      expect(aesGcmDecrypt(aesGcmEncrypt(plaintext, key), key)).toBe(plaintext)
    }
  })

  it("uses a fresh random IV per call — same input yields different payloads", () => {
    const key = keyBase64()
    const a = aesGcmEncrypt("same input", key)
    const b = aesGcmEncrypt("same input", key)
    expect(a).not.toBe(b)
    // IV is the first 12 bytes of the decoded payload.
    const ivOf = (payload: string) => Buffer.from(payload, "base64").subarray(0, 12).toString("hex")
    expect(ivOf(a)).not.toBe(ivOf(b))
    expect(ivOf(a)).toHaveLength(24)
  })

  it("rejects tampered ciphertext with decrypt_failed", () => {
    const key = keyBase64()
    const payload = Buffer.from(aesGcmEncrypt("secret payload", key), "base64")
    // Flip one bit in the ciphertext section (after 12-byte IV + 16-byte tag).
    payload[payload.length - 1] ^= 0x01
    expect(errorMessage(() => aesGcmDecrypt(payload.toString("base64"), key))).toBe(
      "decrypt_failed"
    )
  })

  it("rejects a tampered auth tag with decrypt_failed", () => {
    const key = keyBase64()
    const payload = Buffer.from(aesGcmEncrypt("secret payload", key), "base64")
    payload[12] ^= 0x01 // first byte of the auth tag
    expect(errorMessage(() => aesGcmDecrypt(payload.toString("base64"), key))).toBe(
      "decrypt_failed"
    )
  })

  it("rejects the wrong key with decrypt_failed and never leaks plaintext", () => {
    const payload = aesGcmEncrypt("top secret", keyBase64())
    const message = errorMessage(() => aesGcmDecrypt(payload, keyBase64()))
    expect(message).toBe("decrypt_failed")
    expect(message).not.toContain("top secret")
  })

  it("rejects non-base64 payloads with decrypt_failed", () => {
    const key = keyBase64()
    expect(errorMessage(() => aesGcmDecrypt("not base64 at all!!!", key))).toBe("decrypt_failed")
    expect(errorMessage(() => aesGcmDecrypt("!!!!", key))).toBe("decrypt_failed")
    // Decodes fine but is shorter than IV+tag.
    expect(errorMessage(() => aesGcmDecrypt("AAAAAAAAAAAA", key))).toBe("decrypt_failed")
    expect(errorMessage(() => aesGcmDecrypt("", key))).toBe("decrypt_failed")
  })

  it("rejects a key that is not base64 of exactly 32 bytes", () => {
    const validKey = keyBase64()
    const shortKey = Buffer.alloc(31, 7).toString("base64")
    expect(errorMessage(() => aesGcmEncrypt("x", shortKey))).toBe("invalid_key")
    expect(errorMessage(() => aesGcmDecrypt(aesGcmEncrypt("x", validKey), shortKey))).toBe(
      "decrypt_failed"
    )
  })
})

describe("timingSafeEqualStr", () => {
  it("accepts identical strings and rejects differing ones", () => {
    expect(timingSafeEqualStr("ZABER-448T-APGG", "ZABER-448T-APGG")).toBe(true)
    expect(timingSafeEqualStr("ZABER-448T-APGG", "ZABER-448T-APGH")).toBe(false)
  })

  it("handles empty strings and differing lengths without throwing", () => {
    expect(timingSafeEqualStr("", "")).toBe(true)
    expect(timingSafeEqualStr("", "a")).toBe(false)
    expect(timingSafeEqualStr("a", "")).toBe(false)
    expect(timingSafeEqualStr("short", "much longer value")).toBe(false)
  })
})

describe("generateInvitationCode", () => {
  it("produces ZABER-XXXX-XXXX in Crockford base32 (no I/L/O/U)", () => {
    const { plaintext, hash } = generateInvitationCode()
    expect(plaintext).toMatch(/^ZABER-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(plaintext).not.toMatch(/[IOU]/)
    expect(plaintext).not.toContain("L")
    expect(hash).toBe(sha256(plaintext))
    expect(hash).toHaveLength(64)
  })

  it("only uses the 32-character Crockford alphabet", () => {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    for (let i = 0; i < 50; i++) {
      const body = generateInvitationCode().plaintext.slice(6).replace(/-/g, "")
      for (const char of body) {
        expect(alphabet).toContain(char)
      }
    }
  })

  it("generates 1000 unique codes", () => {
    const codes = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      codes.add(generateInvitationCode().plaintext)
    }
    expect(codes.size).toBe(1000)
  })

  it("hash is stable across re-derivation from the plaintext", () => {
    const { plaintext, hash } = generateInvitationCode()
    expect(sha256(plaintext)).toBe(hash)
    expect(sha256(plaintext)).toBe(hash)
  })
})

describe("generateApiKey", () => {
  it("produces sz_live_ + 32 lowercase hex and a sha256 hash", () => {
    const { plaintext, hash } = generateApiKey()
    expect(plaintext).toMatch(/^sz_live_[0-9a-f]{32}$/)
    expect(hash).toBe(sha256(plaintext))
  })

  it("preview shows sz_live_ + first4…last4 and masks the middle", () => {
    const { plaintext, preview } = generateApiKey()
    const hex = plaintext.slice("sz_live_".length)
    expect(preview).toBe(`sz_live_${hex.slice(0, 4)}…${hex.slice(-4)}`)
    // Exactly 4 + 4 secret chars visible; nothing from the middle 24.
    const middle = hex.slice(4, 28)
    expect(preview).not.toContain(middle)
    expect(preview.length).toBe("sz_live_".length + 4 + 1 + 4)
  })

  it("generates unique keys across calls", () => {
    const keys = new Set<string>()
    for (let i = 0; i < 200; i++) {
      keys.add(generateApiKey().plaintext)
    }
    expect(keys.size).toBe(200)
  })
})
