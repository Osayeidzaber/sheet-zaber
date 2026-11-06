/*
 * Consent redirect (authentication-flow.md §1). The state cookie carries the PKCE
 * verifier and `returnTo`; Google only ever sees the one-shot nonce as `state`.
 */
import { randomHex } from "@/lib/crypto"
import { env } from "@/lib/env"
import {
  DEFAULT_RETURN_TO,
  buildAuthUrl,
  buildStateSetHeaders,
  generatePkce,
  redirectWithCookies,
  sanitizeReturnTo,
  signState,
} from "@/server/auth/google-oauth"

export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  // Dev before the credentials are configured: the login screen shows "not configured"
  // instead of crashing (env.ts degrades only for GOOGLE_*).
  if (!env.googleOAuthConfigured) {
    return redirectWithCookies(request.url, "/login?error=oauth_not_configured")
  }

  const { verifier, challenge } = generatePkce()
  const nonce = randomHex(16)
  const returnTo =
    sanitizeReturnTo(new URL(request.url).searchParams.get("next")) ?? DEFAULT_RETURN_TO
  const stateToken = signState({ nonce, verifier, returnTo, link: false })

  return redirectWithCookies(
    request.url,
    buildAuthUrl({ state: nonce, challenge }),
    ...buildStateSetHeaders(stateToken)
  )
}
