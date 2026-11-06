import { ok } from "@/lib/action-result"
import { listApis } from "@/server/apis/service"
import { userRoute } from "@/server/http/internal-route"
import { methodNotAllowed } from "@/server/http/request"

/*
 * GET /api/internal/apis (`backend-api-contract.md` §2, §4.6).
 *
 * The §4.6 `ApiConfig` list owned by the session user — the service already scopes by
 * `user_id` and returns the ActionResult envelope, so a failure passes straight through.
 * `?spreadsheet_id=` narrows it further, applied here after the service call (no extra
 * repository function). `userId` is not part of the payload; there is nothing secret to
 * drop, but the key set is exactly §4.6.
 */

export const dynamic = "force-dynamic"

export const GET = userRoute(async (ctx) => {
  const result = await listApis(ctx.user.id)
  if (!result.ok) return result

  const spreadsheetId = ctx.url.searchParams.get("spreadsheet_id") || null
  return ok(
    spreadsheetId === null
      ? result.data
      : result.data.filter((api) => api.spreadsheetId === spreadsheetId)
  )
})

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
