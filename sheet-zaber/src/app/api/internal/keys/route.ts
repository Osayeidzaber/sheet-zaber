import { listKeyItems } from "@/server/keys/service"
import { userRoute } from "@/server/http/internal-route"
import { methodNotAllowed } from "@/server/http/request"

/*
 * GET /api/internal/keys (`backend-api-contract.md` §2, §4.6, `security.md` "hashed API keys").
 *
 * The §4.6 key list for the session user: active keys only, newest first. The repository
 * projection leaves `keyHash` off the row and `listKeyItems` drops `userId`, so the wire shape
 * is fixed in the service — this file has no row mapping. The plaintext exists only in
 * createKey/regenerateKey's return and is not reachable from this read path.
 */

export const dynamic = "force-dynamic"

export const GET = userRoute((ctx) => listKeyItems(ctx.user.id))

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
