import { fail, type ActionError } from "@/lib/action-result"
import {
  createInvitations,
  inviteUsers,
  listInvitationsForAdmin,
  type CreateInvitationsPayload,
  type InviteUsersPayload,
} from "@/server/invitations/service"
import { methodNotAllowed, readTextBody } from "@/server/http/request"
import { ownerRoute } from "@/server/http/internal-route"

/*
 * `/api/internal/admin/invitations` (`backend-api-contract.md` §2 Admin, §4.5).
 *
 * GET — `listInvitationsForAdmin`: §4.5 admin payload (status + redemptions join). Its repository
 * projection lists columns explicitly, so `invitations.code_hash` cannot arrive even by a
 * `select()` slip.
 *
 * POST — two documented bodies, owner-only (`ownerRoute`):
 *   `{ "emails": [ … ], "label"?, "maxUses"?, "expiresAt"? }` → `inviteUsers`: mints one
 *     single-use code per address (capped at 50, zod-validated, duplicates refused), then emails
 *     each code. Success is `{ data: { invitations, deliveries } }` — NO plaintext in this body;
 *     the only place the code appears is the email itself.
 *   `{ "count", "label"?, "maxUses"?, "expiresAt"? }` → the plain `createInvitations` mint (§2
 *     "returns plaintext codes once"). Success is `{ data: { codes, plaintext, invitations } }`.
 * Both bodies are validated by the service's zod schemas — this file only dispatches, so a route
 * and a future server action cannot drift apart (§4.7). PUT/PATCH/DELETE keep 405.
 */

export const dynamic = "force-dynamic"

/** Same ceiling the other admin write routes use; 50 addresses + memo fit well inside it. */
const MAX_BODY_BYTES = 8_192

type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false; error: ActionError }

async function readJsonBody(req: Request): Promise<JsonBody> {
  const text = await readTextBody(req, MAX_BODY_BYTES)
  if (text === null) {
    return { ok: false, error: fail("validation_failed", "Request body is too large.", "validation", { body: "too large" }) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: fail("validation_failed", "Request body is not valid JSON.", "validation", { body: "invalid JSON" }) }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: fail("validation_failed", "Request body must be a JSON object.", "validation", {
        body: "must be a JSON object",
      }),
    }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** An unparseable expiry becomes an Invalid Date, which the service schema rejects — never dropped. */
function coerceDate(value: unknown): Date | null | undefined {
  if (value === null || value === undefined) return undefined
  return value instanceof Date ? value : new Date(String(value))
}

const listHandler = ownerRoute(() => listInvitationsForAdmin())

/** One route, two documented bodies: the success arm is the union of the two payloads (§4.4). */
const postHandler = ownerRoute<InviteUsersPayload | CreateInvitationsPayload>(async (ctx) => {
  const parsed = await readJsonBody(ctx.req)
  if (!parsed.ok) return parsed.error
  const body = parsed.value

  if ("emails" in body) {
    const { emails, ...options } = body
    return inviteUsers(emails, options, ctx.user.id, { req: ctx.req })
  }

  // `count` reaches `createInvitationsSchema` raw: absent or non-numeric fails there with
  // `fields.count`, and the §4.5 mint answers with its own typed envelope.
  return createInvitations(
    {
      count: Number(body.count),
      label: body.label as string | null | undefined,
      maxUses: body.maxUses as number | undefined,
      expiresAt: coerceDate(body.expiresAt),
    },
    ctx.user.id,
    { req: ctx.req }
  )
})

export function GET(req: Request): Promise<Response> {
  return listHandler(req)
}

export function POST(req: Request): Promise<Response> {
  return postHandler(req)
}
export function PUT(): Response {
  return methodNotAllowed(["GET", "POST"])
}
export function PATCH(): Response {
  return methodNotAllowed(["GET", "POST"])
}
export function DELETE(): Response {
  return methodNotAllowed(["GET", "POST"])
}
