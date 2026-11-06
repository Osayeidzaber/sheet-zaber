import "server-only"

/*
 * Request-scoped helpers shared by every route handler. Dependency-light: a route can import
 * them without pulling in the DB.
 */

/**
 * First `x-forwarded-for` hop, then `x-real-ip`; `null` when the proxy chain said nothing.
 * Only ever used as a *bucket dimension*, never logged or stored in the clear
 * (`security.md` §2).
 */
export function clientIp(req: Request): string | null {
  // A host-controlled header wins outright: a client can prepend anything to x-forwarded-for.
  const trusted = process.env.CLIENT_IP_HEADER
  if (trusted) return req.headers.get(trusted)?.trim() || null

  const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  if (first) return first
  return req.headers.get("x-real-ip")?.trim() || null
}

/**
 * The throttling identity: an unknown client shares ONE bucket instead of escaping the per-IP limit,
 * so stripped forwarding headers cannot turn the dimension off.
 */
export function clientBucketIp(req: Request): string {
  return clientIp(req) ?? "unknown-client"
}

/** Raw `Cookie` header reader; routes must not assume Next's `cookies()` is available. */
export function readCookie(req: Request, name: string): string | null {
  for (const pair of (req.headers.get("cookie") ?? "").split(";")) {
    const separator = pair.indexOf("=")
    if (separator === -1) continue
    if (pair.slice(0, separator).trim() !== name) continue
    const value = pair.slice(separator + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}

export function json(
  body: unknown,
  status: number,
  headers?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

/** `Allow` list for a method-switch fallthrough; 405 is not 404 — the path exists. */
export function methodNotAllowed(allow: string[]): Response {
  return json(
    { error: { code: "method_not_allowed", message: "Method not allowed.", category: "validation" } },
    405,
    { allow: allow.join(", ") }
  )
}

/** Text body with a hard ceiling, so a playground or engine call cannot stream unbounded input. */
export async function readTextBody(req: Request, maxBytes: number): Promise<string | null> {
  const text = await req.text()
  if (Buffer.byteLength(text, "utf8") > maxBytes) return null
  return text
}
