import { ok } from "@/lib/action-result"
import { listConnectionsForUser } from "@/server/google/connections"
import { userRoute } from "@/server/http/internal-route"
import { methodNotAllowed } from "@/server/http/request"

/*
 * GET /api/internal/connections (`backend-api-contract.md` §2, §4.6).
 *
 * One list serves the account picker AND the reconnect banner: the §4.6 `Connection`
 * carries `status`, so `reauth_required` rows need no second round trip (the old
 * `…/connections/status` variant is dropped). Owner-scoped only — `listConnectionsForUser`
 * takes the `readUser` id, and there is deliberately no "all connections" view, even for
 * an owner. `refreshTokenEnc`/`userId` never leave the repository row.
 */

export const dynamic = "force-dynamic"

export const GET = userRoute(async (ctx) => ok(await listConnectionsForUser(ctx.user.id)))

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
