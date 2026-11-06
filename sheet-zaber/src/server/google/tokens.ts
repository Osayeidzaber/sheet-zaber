import "server-only"

import { OAuth2Client } from "google-auth-library"

import { aesGcmDecrypt, aesGcmEncrypt } from "@/lib/crypto"
import { env } from "@/lib/env"
import { markConnectionStatus, type GoogleConnectionRow } from "@/server/db/queries/google-connections"

/*
 * Google token lifecycle (google-integration.md §2). Refresh tokens live in the database
 * ONLY as AES-256-GCM ciphertext (`google_connections.refresh_token_enc`); access tokens
 * are never persisted — the in-process cache below is their only home. No token material
 * or ciphertext may ever enter a log line, an error message, or a response body.
 */

/** Typed refresh failure: every cause ends the same documented way — `reauth_required`. */
export class GoogleAuthError extends Error {
  readonly reason: "decrypt_failed" | "refresh_failed" | "not_configured"

  constructor(reason: "decrypt_failed" | "refresh_failed" | "not_configured", message: string) {
    super(message)
    this.name = "GoogleAuthError"
    this.reason = reason
  }
}

const REAUTH_MESSAGE = "The Google connection needs re-authorization."

/** `base64(iv || authTag || ciphertext)` under TOKEN_ENCRYPTION_KEY. */
export function encryptRefreshToken(plain: string): string {
  return aesGcmEncrypt(plain, env.TOKEN_ENCRYPTION_KEY)
}

/** Throws `Error("decrypt_failed")` on any tampering; partial plaintext never escapes. */
export function decryptRefreshToken(payload: string): string {
  return aesGcmDecrypt(payload, env.TOKEN_ENCRYPTION_KEY)
}

/**
 * Injectable refresh boundary — the one Google call this module makes. Fakes only ever
 * receive their own fixture strings, so tests need neither network nor real tokens.
 */
export type RefreshTransport = (
  refreshToken: string
) => Promise<{ accessToken: string; expiresAt?: number }>

const defaultRefreshTransport: RefreshTransport = async (refreshToken) => {
  if (!env.googleOAuthConfigured) {
    throw new GoogleAuthError("not_configured", REAUTH_MESSAGE)
  }
  const client = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)
  client.setCredentials({ refresh_token: refreshToken })
  // v11 returns the token here and keeps the expiry on the client's credentials.
  const refreshed = await client.getAccessToken()
  if (!refreshed.token) throw new Error("Google returned no access token")
  return { accessToken: refreshed.token, expiresAt: client.credentials.expiry_date ?? undefined }
}

/** §2: "never persisted — in-process cache keyed by connection id … ≤ 50 min used". */
const ACCESS_TOKEN_MAX_LIFETIME_MS = 50 * 60 * 1000

type CachedAccessToken = { accessToken: string; expiresAt: number }

const accessTokenCache = new Map<string, CachedAccessToken>()

export function evictAccessToken(connectionId: string): void {
  accessTokenCache.delete(connectionId)
}

export function clearAccessTokenCache(): void {
  accessTokenCache.clear()
}

async function markReauth(connectionId: string): Promise<void> {
  evictAccessToken(connectionId)
  try {
    await markConnectionStatus(connectionId, "reauth_required")
  } catch {
    // An unreachable database must not mask the typed auth failure.
  }
}

/**
 * Decrypt → refresh → return the access token, caching it in-process only. On any
 * failure (decryption, invalid_grant, revoked) the row goes to `reauth_required` and a
 * typed `GoogleAuthError` is thrown (§2 — dashboard shows the reconnect banner).
 */
export async function getAccessToken(
  connection: GoogleConnectionRow,
  transport: RefreshTransport = defaultRefreshTransport
): Promise<string> {
  const cached = accessTokenCache.get(connection.id)
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken

  let refreshToken: string
  try {
    refreshToken = decryptRefreshToken(connection.refreshTokenEnc)
  } catch {
    await markReauth(connection.id)
    throw new GoogleAuthError("decrypt_failed", REAUTH_MESSAGE)
  }

  let fresh: { accessToken: string; expiresAt?: number }
  try {
    fresh = await transport(refreshToken)
  } catch {
    await markReauth(connection.id)
    throw new GoogleAuthError("refresh_failed", REAUTH_MESSAGE)
  }

  const expiresAt = Math.min(
    fresh.expiresAt ?? Date.now() + ACCESS_TOKEN_MAX_LIFETIME_MS,
    Date.now() + ACCESS_TOKEN_MAX_LIFETIME_MS
  )
  accessTokenCache.set(connection.id, { accessToken: fresh.accessToken, expiresAt })
  return fresh.accessToken
}
