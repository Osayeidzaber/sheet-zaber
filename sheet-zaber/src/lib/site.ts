/** Public facts search engines and link previews read. `env.ts` requires the URL in production. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(/\/$/, "")
export const SITE_NAME = "Sheet Zaber"
export const SITE_TITLE = "Sheet Zaber: turn a Google Sheets tab into a REST API"
export const SITE_DESCRIPTION =
  "Publish one Google Sheets tab as one REST endpoint: Bearer-key reads and writes, your own Google grant on the data, every limit documented. Private and invitation-only."

/** The dashboard and every handshake route. Kept out of search by robots.ts and page metadata. */
export const PRIVATE_PATHS = [
  "/overview", "/spreadsheets", "/apis", "/keys", "/playground", "/logs", "/analytics", "/settings", "/admin", "/login", "/auth/", "/api/",
]

export const PUBLIC_PATHS = [
  "/", "/docs", "/docs/authentication", "/docs/envelope", "/docs/operations", "/docs/errors", "/docs/rate-limits", "/privacy", "/terms",
]
