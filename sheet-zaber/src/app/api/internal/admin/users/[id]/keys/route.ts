import { fail } from "@/lib/action-result"
import { listAdminUserKeys } from "@/server/admin/user-detail"
import { methodNotAllowed } from "@/server/http/request"
import { ownerRoute, type InternalContext } from "@/server/http/internal-route"

/*
 * `GET /api/internal/admin/users/{id}/keys` — the owner's view of ANOTHER account's API keys.
 *
 * The id is `InternalContext.path[2]` (`["admin","users","{id}","keys"]`), the same channel
 * `…/admin/users/{id}` uses: no `params` generic is declared, so this file cannot disagree with the
 * route's dynamic segment, and `?user_id=` is never read — a query parameter cannot move the scope.
 *
 * WHAT THIS ROUTE CANNOT LEAK. `api_keys` stores SHA-256 `key_hash` and a display `key_preview`
 * only; the plaintext `sz_live_…` exists at the instant a key is minted and is never stored, so no
 * read path — this one included — can return a secret. The column list in
 * `src/server/db/queries/api-keys.ts` has no `keyHash`, and the payload is rebuilt field by field in
 * `src/server/admin/user-detail.ts`, so `preview` (`sz_live_ab12…last4`) is the closest anything
 * here comes to a value. `tests/admin-detail.test.ts` scans the serialized body for a hash-shaped
 * string, not just the declared keys.
 *
 * Revoked keys ARE listed (`revokedAt` is a payload field and the owner is the reader who needs to
 * see the dead ones). This is a read: it changes nothing, so it audits nothing — `admin/users.ts`'s
 * rule that a refusal writes no audit row is the same rule from the other side.
 */

export const dynamic = "force-dynamic"

/** `["admin","users","{id}","keys"]` — anything else addresses no account and gets the one `not_found`. */
function targetUserId(ctx: InternalContext): string | undefined {
  return ctx.path.length === 4 && ctx.path[3] === "keys" ? ctx.path[2] : undefined
}

const getHandler = ownerRoute((ctx) => {
  const id = targetUserId(ctx)
  // Byte-identical to `admin/users.ts`'s one `not_found`: a malformed id and an absent account are
  // the same answer, and so is a path that does not address one account at all.
  if (id === undefined) return fail("not_found", "No user was found with that id.", "not_found")
  return listAdminUserKeys(id, ctx.user)
})

export function GET(req: Request): Promise<Response> {
  return getHandler(req)
}

export function POST(): Response {
  return methodNotAllowed(["GET"])
}

export function PUT(): Response {
  return methodNotAllowed(["GET"])
}

export function PATCH(): Response {
  return methodNotAllowed(["GET"])
}

export function DELETE(): Response {
  return methodNotAllowed(["GET"])
}
