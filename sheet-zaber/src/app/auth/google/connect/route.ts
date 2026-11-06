/*
 * Re-consent entry point ("Connect Google" / reconnect banner, google-integration.md §6).
 * Same consent redirect as /auth/google, but the state cookie is flagged `link`, so the
 * callback attaches the new grant to the SESSION user instead of minting `sz_pending`.
 */
import { randomHex } from "@/lib/crypto"
import { env } from "@/lib/env"
import { readUser } from "@/server/auth/guards"
import {
  buildAuthUrl,
  buildStateSetHeaders,
  generatePkce,
  redirectWithCookies,
  sanitizeReturnTo,
  signState,
} from "@/server/auth/google-oauth"

export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  const user = await readUser(request)
  if (!user) {
    return redirectWithCookies(request.url, "/login")
  }
  if (!env.googleOAuthConfigured) {
    return redirectWithCookies(request.url, "/login?error=oauth_not_configured")
  }

  const { verifier, challenge } = generatePkce()
  const nonce = randomHex(16)
  const returnTo = sanitizeReturnTo(new URL(request.url).searchParams.get("next")) ?? "/overview"
  const stateToken = signState({ nonce, verifier, returnTo, link: true })

  return redirectWithCookies(
    request.url,
    buildAuthUrl({ state: nonce, challenge }),
    ...buildStateSetHeaders(stateToken)
  )
}
