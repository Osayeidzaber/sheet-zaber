import { listLogs } from "@/server/logs/service"
import { methodNotAllowed } from "@/server/http/request"
import { userRoute, type InternalContext } from "@/server/http/internal-route"

/*
 * `GET /api/internal/logs?apiId&method&status&from&to&page&per_page&user_id`
 * (`backend-api-contract.md` §2 "Logs & analytics (user: own; owner: all)").
 *
 * A thin adapter: the query string is handed over verbatim and NOTHING is decided here. Scope,
 * validation and the 400-vs-500 rule all live in `src/server/logs/service.ts`, so a server action
 * over the same service cannot disagree with this route.
 */

export const dynamic = "force-dynamic"

function query(ctx: InternalContext): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {}
  for (const key of new Set(ctx.url.searchParams.keys())) {
    const all = ctx.url.searchParams.getAll(key)
    params[key] = all.length === 1 ? all[0] : all
  }
  return params
}

const handler = userRoute((ctx) => listLogs(ctx.user, query(ctx)))

export function GET(req: Request): Promise<Response> {
  return handler(req)
}

// GET-only surface: an unexported method would answer Next's own 405, not the envelope (§4.4).
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
