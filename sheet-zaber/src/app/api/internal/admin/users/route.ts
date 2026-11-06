import { listUsers } from "@/server/admin/users"
import { methodNotAllowed } from "@/server/http/request"
import { ownerRoute } from "@/server/http/internal-route"

/*
 * `GET /api/internal/admin/users?page&per_page` (`backend-api-contract.md` §2 Admin, §4.6).
 *
 * Owner-only by `ownerRoute`, and the payload is the §4.6 `AdminUserRow` projection built in
 * `src/server/admin/users.ts` — eleven keys per row: id, email, role, status, invitationId,
 * invitationLabel, apiCount, requestTotal, apiLimitPerDay, lastLoginAt, createdAt. `googleSub` is not
 * one of them, and neither is an invitation code or `invitations.code_hash`: the service projects
 * column by column, so a new `users` column cannot join the response by accident.
 */

export const dynamic = "force-dynamic"

function param(ctx: { url: URL }, key: string): string | undefined {
  return ctx.url.searchParams.get(key) ?? undefined
}

const handler = ownerRoute((ctx) => listUsers(ctx.user, param(ctx, "page"), param(ctx, "per_page")))

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
