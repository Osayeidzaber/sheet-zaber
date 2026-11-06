import "server-only"

import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto"

/*
 * Crypto & identifier primitives (architecture.md §8, security.md D8/D10/D11).
 * Node built-ins only — zero dependencies. All functions are synchronous and
 * server-side; nothing here may be imported from client components.
 *
 * - AES-256-GCM payloads are `base64(iv || authTag || ciphertext)` with a
 *   fresh 12-byte IV per encryption; the key is base64 of exactly 32 bytes
 *   (TOKEN_ENCRYPTION_KEY).
 * - Secrets that live in the database (invitation codes, API keys) are
 *   looked up by SHA-256 hash, never stored in plaintext.
 */

const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
/** Standard base64 (padding optional only in that trailing `=` sense); rejects lenient decodes. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
/** Crockford base32 — excludes I, L, O, U so codes survive OCR and retyping. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** Hex string of `bytes` cryptographically random bytes. */
export function randomHex(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new RangeError(`randomHex: bytes must be a positive integer, got ${bytes}`)
  }
  return randomBytes(bytes).toString("hex")
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

/** Decode base64 that must represent exactly 32 bytes; null when malformed. */
function decodeKey32(keyBase64: string): Buffer | null {
  // No `% 4` here: env.ts validates keys with atob, which accepts unpadded
  // base64, and Buffer.from decodes it to the same 32 bytes.
  if (!BASE64_RE.test(keyBase64)) return null
  const key = Buffer.from(keyBase64, "base64")
  return key.length === 32 ? key : null
}

/**
 * AES-256-GCM encrypt → `base64(iv || authTag || ciphertext)`.
 * A fresh random IV is generated per call, so equal plaintexts never share a payload.
 */
export function aesGcmEncrypt(plaintext: string, keyBase64: string): string {
  const key = decodeKey32(keyBase64)
  if (!key) throw new Error("invalid_key")

  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")
}

/**
 * AES-256-GCM decrypt; throws Error("decrypt_failed") on tampered ciphertext,
 * a wrong/malformed key, or malformed input. Plaintext is only returned after
 * the auth tag verifies, so partial data can never escape.
 */
export function aesGcmDecrypt(payloadBase64: string, keyBase64: string): string {
  const key = decodeKey32(keyBase64)
  if (!key) throw new Error("decrypt_failed")
  if (!BASE64_RE.test(payloadBase64) || payloadBase64.length % 4 !== 0) {
    throw new Error("decrypt_failed")
  }

  const payload = Buffer.from(payloadBase64, "base64")
  if (payload.length < IV_LENGTH + AUTH_TAG_LENGTH) throw new Error("decrypt_failed")

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, IV_LENGTH))
    decipher.setAuthTag(payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH))
    return Buffer.concat([
      decipher.update(payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH)),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    // Tampered ciphertext/tag — never surface the original error or partial data.
    throw new Error("decrypt_failed")
  }
}

/**
 * Constant-time string comparison, safe for differing lengths: both sides are
 * hashed to fixed-size digests first, so timingSafeEqual never sees a length
 * mismatch and an early length branch reveals nothing about the content.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const digestOf = (value: string) => createHash("sha256").update(value, "utf8").digest()
  return timingSafeEqual(digestOf(a), digestOf(b))
}

/**
 * Invitation code `ZABER-XXXX-XXXX` (D11). Eight Crockford base32 chars, each
 * mapped from a full random byte via `% 32` — unbiased because 256 = 8 × 32,
 * so no rejection sampling is needed. `hash` is what gets stored.
 */
export function generateInvitationCode(): { plaintext: string; hash: string } {
  const bytes = randomBytes(10)
  let body = ""
  for (let i = 0; i < 8; i++) {
    body += CROCKFORD[bytes[i] % 32]
  }
  const plaintext = `ZABER-${body.slice(0, 4)}-${body.slice(4)}`
  return { plaintext, hash: sha256(plaintext) }
}

/**
 * API key `sz_live_` + 32 lowercase hex (128 bits, D10). Only `hash` is
 * stored; `preview` keeps head and tail visible for UI identification.
 */
export function generateApiKey(): { plaintext: string; hash: string; preview: string } {
  const hex = randomBytes(16).toString("hex")
  const plaintext = `sz_live_${hex}`
  return {
    plaintext,
    hash: sha256(plaintext),
    preview: `sz_live_${hex.slice(0, 4)}…${hex.slice(-4)}`,
  }
}
