import { overview } from "@/server/logs/service"
import { methodNotAllowed } from "@/server/http/request"
import { userRoute, type InternalContext } from "@/server/http/internal-route"

/*
 * `GET /api/internal/analytics/overview?from&to` (`backend-api-contract.md` §2).
 *
 * DEFAULT WINDOW: when neither `from` nor `to` is given, the service answers for the LAST 30 DAYS
 * (`DEFAULT_OVERVIEW_DAYS` in `src/server/logs/service.ts`); an absent `to` never bounds the
 * future, so a row cannot age out of the chart mid-request. A `user` session's totals are its own;
 * an `owner` sees the platform, or one account with `?user_id=`.
 */

export const dynamic = "force-dynamic"

function query(ctx: InternalContext): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {}
  for (const key of new Set(ctx.url.searchParams.keys())) {
    const values = ctx.url.searchParams.getAll(key)
    params[key] = values.length === 1 ? values[0] : values
  }
  return params
}

const handler = userRoute((ctx) => overview(ctx.user, query(ctx)))

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
