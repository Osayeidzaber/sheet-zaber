import "server-only"

import { createHash, createHmac, randomBytes } from "node:crypto"

import { OAuth2Client } from "google-auth-library"

import { timingSafeEqualStr } from "@/lib/crypto"
import { env } from "@/lib/env"

/*
 * Google sign-in boundary (authentication-flow.md §1, google-integration.md §1–§2).
 * PKCE S256, a one-shot HMAC state cookie, strict ID-token claim enforcement, and an
 * injectable transport so tests never reach Google. Token material leaves this module
 * only as decoded `GoogleIdentity` claims or an encrypted `sz_pending` payload — never
 * in a URL, a response body, or a log line.
 */

export type GoogleIdentity = {
  sub: string
  email: string
  emailVerified: boolean
  name: string | null
  picture: string | null
}

/** Consent scopes (google-integration.md §1). `drive.file` covers only files picked in the Picker. */
export const GOOGLE_OAUTH_SCOPES: readonly string[] = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
]

/** Landing page after a successful sign-in (`authentication-flow.md` §1). */
export const DEFAULT_RETURN_TO = "/overview"

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const ALLOWED_ISSUERS: readonly string[] = ["accounts.google.com", "https://accounts.google.com"]
const MS_PER_SECOND = 1000

const isProduction = process.env.NODE_ENV === "production"
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

/* PKCE --------------------------------------------------------------------- */

/** RFC 7636 S256 pair: 32 random bytes → 43-char base64url verifier (within 43..128). */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url")
  return { verifier, challenge }
}

export function buildAuthUrl(input: {
  state: string
  challenge: string
  /** overrides for pure tests; production always uses the validated env values. */
  clientId?: string
  redirectUri?: string
}): string {
  const clientId = input.clientId ?? env.GOOGLE_CLIENT_ID
  if (!clientId) throw new Error("oauth_not_configured")
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: input.redirectUri ?? `${env.NEXT_PUBLIC_SITE_URL}/auth/google/callback`,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    // §1: offline + consent guarantees a refresh token on EVERY grant, not only the first.
    access_type: "offline",
    // select_account so a second Google account can be chosen rather than the signed-in one reused.
    prompt: "select_account consent",
    include_granted_scopes: "true",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    // The state value doubles as the ID-token nonce; Google only echoes a nonce we sent.
    nonce: input.state,
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

/** Same-site path only; absolute URLs, protocol-relative and backslash tricks drop to null. */
export function sanitizeReturnTo(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/")) return null
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null
  if (/[^\x21-\x7e]/.test(raw)) return null
  return raw
}

/* State cookie -------------------------------------------------------------- */

const isProductionCookie = isProduction ? "__Host-" : ""

export const OAUTH_STATE_COOKIE: string = `${isProductionCookie}sz_oauth_state`
export const OAUTH_STATE_MAX_AGE_SECONDS = 600

export type OAuthStatePayload = {
  /** one-shot value Google round-trips as `state` (and signs into the ID token's nonce). */
  nonce: string
  /** PKCE verifier lives ONLY in this HttpOnly cookie — it never passes through the URL. */
  verifier: string
  returnTo: string
  /** issued by /auth/google/connect: the callback links the grant to the session user. */
  link: boolean
  /** unix seconds */
  exp: number
}

function signSegment(segment: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(segment, "utf8").digest("base64url")
}

function decodeSegment(segment: string): string | null {
  if (!BASE64URL_RE.test(segment)) return null
  const decoded = Buffer.from(segment, "base64url")
  if (decoded.toString("base64url") !== segment) return null
  return decoded.toString("utf8")
}

function canonicalStateJson(payload: OAuthStatePayload): string {
  return JSON.stringify({
    nonce: payload.nonce,
    verifier: payload.verifier,
    returnTo: payload.returnTo,
    link: payload.link,
    exp: payload.exp,
  })
}

export function signState(input: {
  nonce: string
  verifier: string
  returnTo: string
  link?: boolean
  /** unix seconds; defaults to now + 10 minutes. */
  exp?: number
}): string {
  const value: OAuthStatePayload = {
    nonce: input.nonce,
    verifier: input.verifier,
    returnTo: input.returnTo,
    link: input.link === true,
    exp: input.exp ?? Math.floor(Date.now() / MS_PER_SECOND) + OAUTH_STATE_MAX_AGE_SECONDS,
  }
  const segment = Buffer.from(canonicalStateJson(value), "utf8").toString("base64url")
  return `${segment}.${signSegment(segment)}`
}

/** Signature, shape and `exp` only; a bad cookie is indistinguishable from a missing one. */
export function readStateCookie(token: string | null | undefined): OAuthStatePayload | null {
  if (!token) return null
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [segment, signature] = parts
  if (!BASE64URL_RE.test(segment) || !BASE64URL_RE.test(signature)) return null
  if (!timingSafeEqualStr(signSegment(segment), signature)) return null

  const json = decodeSegment(segment)
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null

  const value = parsed as Partial<OAuthStatePayload>
  if (typeof value.nonce !== "string" || value.nonce.length === 0) return null
  if (typeof value.verifier !== "string" || value.verifier.length === 0) return null
  if (typeof value.returnTo !== "string" || !value.returnTo.startsWith("/")) return null
  if (typeof value.link !== "boolean") return null
  if (typeof value.exp !== "number" || !Number.isFinite(value.exp)) return null
  if (value.exp <= Math.floor(Date.now() / MS_PER_SECOND)) return null

  return {
    nonce: value.nonce,
    verifier: value.verifier,
    returnTo: value.returnTo,
    link: value.link,
    exp: value.exp,
  }
}

function stateAttributes(maxAgeSeconds: number): string {
  return [
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    ...(isProduction ? ["Secure"] : []),
  ].join("; ")
}

export function buildStateSetHeaders(token: string): string[] {
  return [`${OAUTH_STATE_COOKIE}=${token}; ${stateAttributes(OAUTH_STATE_MAX_AGE_SECONDS)}`]
}

export function buildClearStateHeaders(): string[] {
  return [`${OAUTH_STATE_COOKIE}=; ${stateAttributes(0)}`]
}

/* ID-token claims ----------------------------------------------------------- */

export type GoogleOAuthErrorCode =
  | "malformed_token"
  | "invalid_iss"
  | "invalid_aud"
  | "expired"
  | "nonce_mismatch"
  | "missing_sub"
  | "missing_email"

/** Static messages only — claim values and token material never reach the message. */
export class GoogleOAuthError extends Error {
  readonly reason: GoogleOAuthErrorCode

  constructor(reason: GoogleOAuthErrorCode, message: string) {
    super(message)
    this.name = "GoogleOAuthError"
    this.reason = reason
  }
}

/** Decode the payload segment WITHOUT verification — signature checks belong to the transport. */
export function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  const parts = idToken.split(".")
  if (parts.length !== 3) throw new GoogleOAuthError("malformed_token", "Malformed ID token.")
  const json = decodeSegment(parts[1])
  if (json === null) throw new GoogleOAuthError("malformed_token", "Malformed ID token.")
  let claims: unknown
  try {
    claims = JSON.parse(json)
  } catch {
    throw new GoogleOAuthError("malformed_token", "Malformed ID token.")
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    throw new GoogleOAuthError("malformed_token", "Malformed ID token.")
  }
  return claims as Record<string, unknown>
}

/**
 * authentication-flow.md §1 / google-integration.md §1: `iss`, `aud`, `exp` and `nonce`
 * are mandatory; `email_verified` is surfaced, never assumed true.
 */
export function enforceIdTokenClaims(
  claims: Record<string, unknown>,
  nonce: string,
  audience: string | undefined = env.GOOGLE_CLIENT_ID
): GoogleIdentity {
  if (typeof claims.iss !== "string" || !ALLOWED_ISSUERS.includes(claims.iss)) {
    throw new GoogleOAuthError("invalid_iss", "ID token issuer is not Google.")
  }
  if (!audience || claims.aud !== audience) {
    throw new GoogleOAuthError("invalid_aud", "ID token audience does not match this client.")
  }
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / MS_PER_SECOND)) {
    throw new GoogleOAuthError("expired", "ID token has expired.")
  }
  if (claims.nonce !== nonce) {
    throw new GoogleOAuthError("nonce_mismatch", "ID token nonce does not match the state cookie.")
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new GoogleOAuthError("missing_sub", "ID token carries no subject.")
  }
  if (typeof claims.email !== "string" || claims.email.length === 0) {
    throw new GoogleOAuthError("missing_email", "ID token carries no email.")
  }

  return {
    sub: claims.sub,
    email: claims.email,
    // Anything but literal `true` reads as unverified; the flow aborts on false (§1).
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
  }
}

/* Transport ------------------------------------------------------------------ */

export type ExchangedTokens = { idToken: string; refreshToken: string; scope: string }

/** The whole Google side of sign-in, injectable so tests run without network. */
export type OAuthTransport = {
  exchangeCode(code: string, verifier: string): Promise<ExchangedTokens>
  verifyIdToken(idToken: string, nonce: string): Promise<GoogleIdentity>
}

export const googleOAuthTransport: OAuthTransport = {
  exchangeCode: async (code, verifier) => {
    const client = new OAuth2Client(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      `${env.NEXT_PUBLIC_SITE_URL}/auth/google/callback`
    )
    const { tokens } = await client.getToken({ code, codeVerifier: verifier })
    if (!tokens.id_token || !tokens.refresh_token) {
      throw new GoogleOAuthError("malformed_token", "Google did not return an ID/refresh token.")
    }
    return {
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
      // Google echoes the granted scopes; the fallback keeps the row truthful when it omits them.
      scope: tokens.scope ?? GOOGLE_OAUTH_SCOPES.join(" "),
    }
  },
  verifyIdToken: async (idToken, nonce) => {
    const client = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID })
    const payload = ticket.getPayload()
    if (!payload) throw new GoogleOAuthError("malformed_token", "ID token signature is invalid.")
    return enforceIdTokenClaims(payload as unknown as Record<string, unknown>, nonce)
  },
}

let activeTransport: OAuthTransport = googleOAuthTransport

export function getOAuthTransport(): OAuthTransport {
  return activeTransport
}

/**
 * Test seam: `null` restores the real transport. Only test code may pass a fake —
 * production always uses `googleOAuthTransport`.
 */
export function setOAuthTransport(transport: OAuthTransport | null): void {
  activeTransport = transport ?? googleOAuthTransport
}

/**
 * Verify an ID token through the transport (signature) and then enforce every claim
 * against the token bytes here, so no injected transport can hand back an identity
 * Google did not actually attest (`email_verified` included). Production never passes
 * `audience`; it is the pure-test seam, same as in `enforceIdTokenClaims`.
 */
export async function verifyIdentity(
  idToken: string,
  nonce: string,
  transport: OAuthTransport = getOAuthTransport(),
  audience: string | undefined = env.GOOGLE_CLIENT_ID
): Promise<GoogleIdentity> {
  await transport.verifyIdToken(idToken, nonce)
  return enforceIdTokenClaims(decodeIdTokenClaims(idToken), nonce, audience)
}

/* Response helper ------------------------------------------------------------ */

/**
 * 302 with extra Set-Cookie headers. A plain Response because `Response.redirect()`
 * returns immutable headers; the location is resolved against the request URL so
 * routes can pass app-relative paths.
 */
export function redirectWithCookies(
  requestUrl: string,
  location: string,
  ...setCookieHeaders: string[]
): Response {
  const response = new Response(null, {
    status: 302,
    headers: { location: new URL(location, requestUrl).toString() },
  })
  for (const header of setCookieHeaders) {
    response.headers.append("set-cookie", header)
  }
  return response
}
