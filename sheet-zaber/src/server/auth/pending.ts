import "server-only"

import { createHmac } from "node:crypto"

import { aesGcmDecrypt, aesGcmEncrypt, timingSafeEqualStr } from "@/lib/crypto"
import { env } from "@/lib/env"

/*
 * The pending-registration cookie (authentication-flow.md §1): a signed, 10-minute proof
 * of a verified Google identity that has not been issued a session yet. Only
 * POST /auth/invitation consumes it, and every guarded code path ignores it — holding
 * `sz_pending` grants no access. The Google tokens inside are AES-256-GCM encrypted with
 * TOKEN_ENCRYPTION_KEY before they ever reach the browser.
 */

export type PendingIdentity = {
  sub: string
  email: string
  name: string | null
  picture: string | null
  exp: number
  refreshToken: string
  scope: string
}

const isProduction = process.env.NODE_ENV === "production"

export const PENDING_COOKIE: string = isProduction ? "__Host-sz_pending" : "sz_pending"
export const PENDING_MAX_AGE_SECONDS = 600

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const MS_PER_SECOND = 1000

type CookieShape = {
  sub: string
  email: string
  name: string | null
  picture: string | null
  exp: number
  /** base64(iv ‖ tag ‖ ciphertext) of `{"refreshToken":…,"scope":…}` */
  tok: string
}

function sign(segment: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(segment, "utf8").digest("base64url")
}

function decodeSegment(segment: string): string | null {
  if (!BASE64URL_RE.test(segment)) return null
  const decoded = Buffer.from(segment, "base64url")
  if (decoded.toString("base64url") !== segment) return null
  return decoded.toString("utf8")
}

export function signPending(identity: PendingIdentity): string {
  const tok = aesGcmEncrypt(
    JSON.stringify({ refreshToken: identity.refreshToken, scope: identity.scope }),
    env.TOKEN_ENCRYPTION_KEY
  )
  const value: CookieShape = {
    sub: identity.sub,
    email: identity.email,
    name: identity.name,
    picture: identity.picture,
    exp: identity.exp,
    tok,
  }
  const segment = Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
  return `${segment}.${sign(segment)}`
}

/** Signature, shape and `exp` only; a bad cookie is indistinguishable from a missing one. */
export function verifyPending(token: string | null | undefined): PendingIdentity | null {
  if (!token) return null
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [segment, signature] = parts
  if (!BASE64URL_RE.test(segment) || !BASE64URL_RE.test(signature)) return null
  if (!timingSafeEqualStr(sign(segment), signature)) return null

  const json = decodeSegment(segment)
  if (json === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null

  const value = parsed as Partial<CookieShape>
  if (typeof value.sub !== "string" || value.sub.length === 0) return null
  if (typeof value.email !== "string" || value.email.length === 0) return null
  if (typeof value.exp !== "number" || !Number.isFinite(value.exp)) return null
  if (typeof value.tok !== "string" || value.tok.length === 0) return null
  if (value.name !== null && typeof value.name !== "string") return null
  if (value.picture !== null && typeof value.picture !== "string") return null
  if (value.exp <= Math.floor(Date.now() / MS_PER_SECOND)) return null

  let tokens: unknown
  try {
    tokens = JSON.parse(aesGcmDecrypt(value.tok, env.TOKEN_ENCRYPTION_KEY))
  } catch {
    // A re-signed-but-undeclared payload or a rotated TOKEN_ENCRYPTION_KEY: treat as no cookie.
    return null
  }
  const parsedTokens = tokens as { refreshToken?: unknown; scope?: unknown }
  if (typeof parsedTokens.refreshToken !== "string" || typeof parsedTokens.scope !== "string") {
    return null
  }

  return {
    sub: value.sub,
    email: value.email,
    name: value.name ?? null,
    picture: value.picture ?? null,
    exp: value.exp,
    refreshToken: parsedTokens.refreshToken,
    scope: parsedTokens.scope,
  }
}

function attributes(maxAgeSeconds: number): string {
  return [
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    ...(isProduction ? ["Secure"] : []),
  ].join("; ")
}

export function buildPendingSetHeaders(token: string): string[] {
  return [`${PENDING_COOKIE}=${token}; ${attributes(PENDING_MAX_AGE_SECONDS)}`]
}

export function buildClearPendingHeaders(): string[] {
  return [`${PENDING_COOKIE}=; ${attributes(0)}`]
}

/** `exp` as unix seconds, `maxAge` as cookie seconds — one place that does the math. */
export function pendingExpiry(now: number = Date.now()): { exp: number; maxAge: number } {
  return { exp: Math.floor(now / MS_PER_SECOND) + PENDING_MAX_AGE_SECONDS, maxAge: PENDING_MAX_AGE_SECONDS }
}
