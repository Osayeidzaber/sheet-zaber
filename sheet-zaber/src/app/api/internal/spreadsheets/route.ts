import { userRoute } from "@/server/http/internal-route"
import { methodNotAllowed } from "@/server/http/request"
import { listSpreadsheetsForUser } from "@/server/spreadsheets/service"

/*
 * GET /api/internal/spreadsheets (`backend-api-contract.md` §2, §4.6).
 * The §4.6 `Spreadsheet[]` for the session user; `?connection_id=` narrows it. Listing, the
 * `userId` projection and the filter all live in the service — this file has no row mapping.
 */

export const dynamic = "force-dynamic"

export const GET = userRoute((ctx) =>
  listSpreadsheetsForUser(ctx.user.id, ctx.url.searchParams.get("connection_id"))
)

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
