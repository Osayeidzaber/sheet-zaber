import { usageByApi } from "@/server/logs/service"
import { methodNotAllowed } from "@/server/http/request"
import { userRoute } from "@/server/http/internal-route"

/*
 * `GET /api/internal/analytics/apis` (`backend-api-contract.md` §2). No query parameters: the
 * per-API totals are the whole window, scoped server-side (own APIs for a `user`, every API with
 * logs for an `owner`). Each row is exactly `{ apiId, name, count, errors }`.
 */

export const dynamic = "force-dynamic"

const handler = userRoute((ctx) => usageByApi(ctx.user))

export function GET(req: Request): Promise<Response> {
  return handler(req)
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
