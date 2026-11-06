/*
 * The Google callback (authentication-flow.md §1). One-shot state → code exchange →
 * verified ID token, then one of five outcomes: session (existing active user or the
 * `link` re-consent branch), `sz_pending` (unknown identity, invitation-only), or an
 * error redirect. Refresh/access/ID tokens never enter a URL, a log line, or any cookie
 * other than the encrypted `sz_pending`.
 */
import { readUser } from "@/server/auth/guards"
import { buildPendingSetHeaders, pendingExpiry, signPending } from "@/server/auth/pending"
import {
  OAUTH_STATE_COOKIE,
  buildClearStateHeaders,
  getOAuthTransport,
  redirectWithCookies,
  readStateCookie,
  verifyIdentity,
  type ExchangedTokens,
  type GoogleIdentity,
  type OAuthStatePayload,
} from "@/server/auth/google-oauth"
import { SESSION_MAX_AGE_SECONDS, buildSessionSetHeaders, signSession } from "@/server/auth/session"
import { connectGoogle } from "@/server/google/connections"
import {
  findUserByGoogleSub,
  touchLastLogin,
  upsertUserProfile,
} from "@/server/db/queries/users"

export const dynamic = "force-dynamic"

const MS_PER_SECOND = 1000

function readCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie")
  if (!header) return null
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=")
    if (separator === -1) continue
    if (pair.slice(0, separator).trim() !== name) continue
    const value = pair.slice(separator + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleCallback(request)
  } catch {
    // Static detail only: the message of an upstream/DB error is never echoed.
    console.error("[auth/google/callback] sign-in failed")
    return redirectWithCookies(request.url, "/login?error=oauth_failed", ...buildClearStateHeaders())
  }
}

async function handleCallback(request: Request): Promise<Response> {
  const clearState = buildClearStateHeaders()
  const params = new URL(request.url).searchParams
  const state = readStateCookie(readCookieValue(request, OAUTH_STATE_COOKIE))

  // Google sends ?error=access_denied when the user clicks "Cancel" on consent.
  if (params.get("error")) {
    return redirectWithCookies(request.url, "/login?error=oauth_denied", ...clearState)
  }

  // The cookie is the single use proof: a missing/tampered/expired state, or a `state`
  // that is not the cookie's one-shot nonce, is the same generic failure (§1).
  const code = params.get("code")
  const incomingState = params.get("state")
  if (!state || !code || !incomingState || incomingState !== state.nonce) {
    return redirectWithCookies(request.url, "/login?error=oauth_state", ...clearState)
  }

  const identity = await exchangeAndVerify(code, state)
  if (!identity) {
    return redirectWithCookies(request.url, "/login?error=oauth_failed", ...clearState)
  }
  const { exchange, claims } = identity

  if (!claims.emailVerified) {
    return redirectWithCookies(request.url, "/login?error=email_unverified", ...clearState)
  }

  const existing = await findUserByGoogleSub(claims.sub)

  if (state.link) {
    return handleLink(request, state, claims, exchange, existing?.id)
  }

  if (!existing) {
    // Invitation-only: the identity (and its encrypted refresh token) waits in sz_pending
    // so POST /auth/invitation can finish registration without a second consent round trip.
    const pendingToken = signPending({
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      picture: claims.picture,
      exp: pendingExpiry().exp,
      refreshToken: exchange.refreshToken,
      scope: exchange.scope,
    })
    return redirectWithCookies(
      request.url,
      "/login?step=invitation",
      ...buildPendingSetHeaders(pendingToken),
      ...clearState
    )
  }

  if (existing.status !== "active") {
    // Disabled means no session AND no row writes (no touchLastLogin, no connectGoogle).
    return redirectWithCookies(request.url, "/login?error=disabled", ...clearState)
  }

  await touchLastLogin(existing.id)
  await upsertUserProfile({
    userId: existing.id,
    displayName: claims.name ?? existing.email,
    pictureUrl: claims.picture,
  })
  await connectGoogle({
    userId: existing.id,
    googleEmail: claims.email,
    refreshToken: exchange.refreshToken,
    scope: exchange.scope,
  })

  // The cookie role comes from the DB row, never a guess (authentication-flow.md §2).
  const sessionToken = signSession({
    uid: existing.id,
    role: existing.role === "owner" ? "owner" : "user",
    exp: Math.floor(Date.now() / MS_PER_SECOND) + SESSION_MAX_AGE_SECONDS,
  })
  return redirectWithCookies(
    request.url,
    state.returnTo,
    ...buildSessionSetHeaders(sessionToken),
    ...clearState
  )
}

/**
 * Re-consent issued by /auth/google/connect: the grant belongs to the SESSION user, even
 * when the Google account has never signed in here (multiple accounts per user is the
 * design). No pending cookie — the inviter gate applies to identities, not to accounts an
 * existing user adds.
 */
async function handleLink(
  request: Request,
  state: OAuthStatePayload,
  claims: GoogleIdentity,
  exchange: ExchangedTokens,
  existingUserId: string | undefined
): Promise<Response> {
  const clearState = buildClearStateHeaders()
  const session = await readUser(request)
  if (!session) {
    return redirectWithCookies(request.url, "/login", ...clearState)
  }
  if (existingUserId !== undefined && existingUserId !== session.id) {
    // One Google identity belongs to exactly one account; refuse to bridge two accounts
    // and write nothing.
    return redirectWithCookies(request.url, state.returnTo, ...clearState)
  }
  await connectGoogle({
    userId: session.id,
    googleEmail: claims.email,
    refreshToken: exchange.refreshToken,
    scope: exchange.scope,
  })
  return redirectWithCookies(request.url, state.returnTo, ...clearState)
}

async function exchangeAndVerify(
  code: string,
  state: OAuthStatePayload
): Promise<{ exchange: ExchangedTokens; claims: GoogleIdentity } | null> {
  try {
    const transport = getOAuthTransport()
    const exchange = await transport.exchangeCode(code, state.verifier)
    const claims = await verifyIdentity(exchange.idToken, state.nonce, transport)
    return { exchange, claims }
  } catch {
    // A Google-side or claim failure is a generic sign-in error; tokens never reach a log.
    return null
  }
}
