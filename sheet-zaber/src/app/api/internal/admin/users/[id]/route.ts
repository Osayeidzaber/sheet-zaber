import { z } from "zod"

import { fail, type ActionResult } from "@/lib/action-result"
import { apiLimitPerDaySchema } from "@/lib/schemas"
import { getUserDetail } from "@/server/admin/user-detail"
import {
  deleteUser,
  demoteUser,
  promoteUser,
  setUserApiLimit,
  setUserStatus,
  type AdminUserRow,
} from "@/server/admin/users"
import { methodNotAllowed, readTextBody } from "@/server/http/request"
import { ownerRoute, type InternalContext } from "@/server/http/internal-route"

/*
 * `GET|PATCH|DELETE /api/internal/admin/users/{id}` (`backend-api-contract.md` §2 "Admin", §4.6).
 *
 * The id comes from `InternalContext.path` (`["admin","users","{id}"]`), the same channel
 * `…/apis/{id}/stats` uses: `ownerRoute` hands a handler only the `Request`, so this file declares
 * no `params` generic at all and cannot mismatch the route's dynamic segment. The id is read from
 * the PATH and `?user_id=` is never looked at, so the scope of a detail read cannot be moved by a
 * second, disagreeable query parameter.
 *
 * Nothing is decided here. RBAC, the self-revocation and last-owner guards, the transaction and the
 * audit row all live in `src/server/admin/users.ts`; the GET's rules — `can(role, "user.read")`
 * again, the no-oracle `not_found`, the thirteen-key projection with no secret in it — live in
 * `src/server/admin/user-detail.ts`. This adapter only turns a request into ONE service call, so a
 * server action over the same verbs cannot disagree with the route.
 */

export const dynamic = "force-dynamic"

/** A status/role/quota patch is a handful of bytes; the ceiling is what `readTextBody` needs, not a rule. */
const MAX_BODY_BYTES = 8_192

const patchSchema = z
  .object({
    status: z.enum(["active", "disabled"]),
    role: z.enum(["owner", "user"]),
    // `users.api_limit_per_day` (§1.4): integer 0…10_000_000, `0` = unlimited, and a form or query
    // string coerces — the rule lives in `src/lib/schemas.ts`, so an action cannot drift from here.
    apiLimitPerDay: apiLimitPerDaySchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length === 1, {
    message: "send exactly one of status, role or apiLimitPerDay",
  })

function targetId(ctx: InternalContext): string | undefined {
  return ctx.path.length === 3 ? ctx.path[2] : undefined
}

function invalidBody(fields: Record<string, string>): ActionResult<AdminUserRow> {
  return fail("validation_failed", "The request body is not valid.", "validation", fields)
}

/** zod path → §4.4 `fields`; the object-level refine lands on `body`. */
function fieldsFrom(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body"
    if (!(key in fields)) fields[key] = issue.message
  }
  return fields
}

const getHandler = ownerRoute((ctx) => {
  const id = targetId(ctx)
  // The SAME `not_found` body the service answers for an unreadable id, so a path that does not
  // address exactly one user cannot fall through to a detail read — or become an oracle.
  if (id === undefined) return fail("not_found", "No user was found with that id.", "not_found")
  return getUserDetail(id, ctx.user)
})

const patchHandler = ownerRoute(async (ctx) => {
  const id = targetId(ctx)
  if (id === undefined) return fail("not_found", "No user was found with that id.", "not_found")

  const text = await readTextBody(ctx.req, MAX_BODY_BYTES)
  if (text === null) return invalidBody({ body: `must be at most ${MAX_BODY_BYTES} bytes` })

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return invalidBody({ body: "must be JSON" })
  }

  const parsed = patchSchema.safeParse(raw)
  if (!parsed.success) return invalidBody(fieldsFrom(parsed.error))

  if (parsed.data.status !== undefined) return setUserStatus(id, parsed.data.status, ctx.user)
  // `0` is a legal quota, so the test is `!== undefined` and never truthiness.
  if (parsed.data.apiLimitPerDay !== undefined) {
    return setUserApiLimit(id, parsed.data.apiLimitPerDay, ctx.user)
  }
  if (parsed.data.role === "owner") return promoteUser(id, ctx.user)
  return demoteUser(id, ctx.user)
})

const deleteHandler = ownerRoute((ctx) => {
  const id = targetId(ctx)
  // A body on a DELETE is not read, let alone parsed (`§1.3` refuses body-bearing deletes).
  if (id === undefined) return fail("not_found", "No user was found with that id.", "not_found")
  return deleteUser(id, ctx.user)
})

// One user: read, patched and removed. `GET` is the owner's detail view (`user-detail.ts`), the
// payload the admin panel opens when it clicks a row of `GET /api/internal/admin/users`.
export function GET(req: Request): Promise<Response> {
  return getHandler(req)
}

export function PATCH(req: Request): Promise<Response> {
  return patchHandler(req)
}

export function DELETE(req: Request): Promise<Response> {
  return deleteHandler(req)
}

export function POST(): Response {
  return methodNotAllowed(["GET", "PATCH", "DELETE"])
}

export function PUT(): Response {
  return methodNotAllowed(["GET", "PATCH", "DELETE"])
}
