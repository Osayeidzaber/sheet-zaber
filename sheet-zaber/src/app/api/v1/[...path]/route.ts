import type { SnippetMethod } from "@/lib/snippets"
import { handleEngineCall, type EngineCall } from "@/server/engine"
import { clientBucketIp, methodNotAllowed } from "@/server/http/request"

/*
 * `/api/v1/**` — a THIN adapter over the engine (`backend-api-contract.md` §1, §4.8).
 *
 * There is no engine logic in this file on purpose: it parses Next's catch-all `params`, builds an
 * `EngineCall` with the `{kind:"bearer"}` arm, and forwards `EngineOutcome.body`/`headers` verbatim.
 * The playground (`src/app/api/internal/playground`) is the sibling adapter over the same function,
 * which is why the two can never disagree about a status, an envelope, or a `Retry-After`.
 */

export const dynamic = "force-dynamic"

/** The verbs the engine serves; `HEAD`/`OPTIONS` are answered 405 with exactly this list. */
const ALLOW = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const

/** Next 16: `params` is a Promise and this is the only shape the route type validator accepts. */
type RouteContext = { params: Promise<{ path?: string[] }> }

const BEARER_SCHEME = /^bearer[ \t]+/i

/** Only absent or blank headers produce missing_key; malformed schemes produce invalid_key. */
function bearerToken(request: Request): string {
  const header = (request.headers.get("authorization") ?? "").trim()
  if (header === "") return ""
  // This sentinel cannot match the engine's API key format.
  if (!BEARER_SCHEME.test(header)) return "invalid_authorization"
  return header.replace(BEARER_SCHEME, "").trim()
}

/** Hostname only: a Referer path or query could hold data. Unparseable values count as absent. */
function originHost(request: Request): string | null {
  const value = request.headers.get("origin") ?? request.headers.get("referer")
  if (!value) return null
  try {
    return new URL(value).hostname.slice(0, 253) || null
  } catch {
    return null
  }
}

async function forward(request: Request, context: RouteContext, method: SnippetMethod): Promise<Response> {
  const { path } = await context.params

  const call: EngineCall = {
    auth: { kind: "bearer", token: bearerToken(request) },
    method,
    // Percent-decoded by Next already; empty segments come from `//` and carry no information.
    pathSegments: (path ?? []).filter((segment) => segment !== ""),
    searchParams: new URL(request.url).searchParams,
    bodyText: method === "GET" ? null : await readBody(request),
    // A bucket dimension only — never logged or stored in the clear (`security.md` §2).
    ip: clientBucketIp(request),
    origin: originHost(request),
  }

  const outcome = await handleEngineCall(call)
  return new Response(outcome.body, { status: outcome.status, headers: outcome.headers })
}

/**
 * The raw text, unread and un-truncated. The engine owns §1.2's 413 `body_too_large` (>1 MB), so
 * clipping the body here would turn a 413 into a 400 `invalid_json` — and a body that cannot be
 * read at all is no body, which the engine answers as its own §1.2 400.
 */
async function readBody(request: Request): Promise<string | null> {
  try {
    const text = await request.text()
    return text === "" ? null : text
  } catch {
    return null
  }
}

export function GET(request: Request, context: RouteContext): Promise<Response> {
  return forward(request, context, "GET")
}

export function POST(request: Request, context: RouteContext): Promise<Response> {
  return forward(request, context, "POST")
}

export function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return forward(request, context, "PATCH")
}

export function PUT(request: Request, context: RouteContext): Promise<Response> {
  return forward(request, context, "PUT")
}

export function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return forward(request, context, "DELETE")
}

/** §4.4 `method_not_allowed`: the path exists, the verb does not — 405 is not 404. */
export function HEAD(): Response {
  return methodNotAllowed([...ALLOW])
}

export function OPTIONS(): Response {
  return methodNotAllowed([...ALLOW])
}
