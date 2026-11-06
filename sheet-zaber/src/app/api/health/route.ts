/*
 * Liveness probe for uptime checks and e2e smoke tests.
 * Deliberately dependency-free: it must answer even when the database is down.
 */
export function GET(): Response {
  return Response.json({ ok: true })
}
