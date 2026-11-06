import "server-only"

import { fail } from "@/lib/action-result"
import { userRoute } from "@/server/http/internal-route"
import { clientIp, methodNotAllowed, readTextBody } from "@/server/http/request"
import { runPlaygroundRequest } from "@/server/playground/service"

/*
 * `POST /api/internal/playground` (`backend-api-contract.md` §2 "Playground (user)", §4.8).
 *
 * A thin adapter, exactly like every other `/api/internal/**` route: `userRoute` owns the session
 * guard, the `{data}` envelope and the category→status map, so this file contains no guard code and
 * no SQL. It owns only the two things that are genuinely about being an HTTP handler — the byte
 * ceiling and the JSON text — and then hands ONE parsed value to the playground service.
 *
 * The ceiling is checked on the RAW text before `JSON.parse`, so an oversized payload costs no
 * parse and no engine call. `playgroundRequestSchema` caps `bodyJson` at 1 MB; this constant is
 * that cap plus the slack the JSON envelope around it needs, and it is also the only bound on the
 * fields the schema leaves unbounded (`query`/`headers`), because those are counted as text here.
 *
 * The refusal is `validation_failed` (→ 400), the same shape `admin/users/{id}` uses for its own
 * ceiling: `CATEGORY_STATUS` in `src/lib/action-result.ts` publishes no 413, and `userRoute` maps
 * only categories, so 413 is not reachable from this wrapper. `security.md` §2's "1.1 MB → 413"
 * rule belongs to the engine's own POST body check on `/api/v1`, not to this internal route.
 */

export const dynamic = "force-dynamic"

const MAX_BODY_BYTES = 1_100_000

function invalidBody(fields: Record<string, string>) {
  return fail("validation_failed", "The playground request is not valid.", "validation", fields)
}

export const POST = userRoute(async (ctx) => {
  const text = await readTextBody(ctx.req, MAX_BODY_BYTES)
  if (text === null) return invalidBody({ body: `must be at most ${MAX_BODY_BYTES} bytes` })

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return invalidBody({ body: "must be JSON" })
  }

  // The session id is the LAST argument and the IP is a bucket dimension only (§4.7, §2 security.md).
  return runPlaygroundRequest(raw, ctx.user.id, clientIp(ctx.req))
})

// POST-only surface: an unexported method would answer Next's own 405, not the envelope (§4.4).
export function GET(): Response {
  return methodNotAllowed(["POST"])
}
export function PUT(): Response {
  return methodNotAllowed(["POST"])
}
export function PATCH(): Response {
  return methodNotAllowed(["POST"])
}
export function DELETE(): Response {
  return methodNotAllowed(["POST"])
}
