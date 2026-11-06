/*
 * Form POST only (backend-api-contract.md §2): a GET logout would make sessions
 * droppable by any reachable link or image crawl.
 */
import { buildClearSessionHeaders } from "@/server/auth/session"
import { redirectWithCookies } from "@/server/auth/google-oauth"

export const dynamic = "force-dynamic"

export async function POST(request: Request): Promise<Response> {
  return redirectWithCookies(request.url, "/login", ...buildClearSessionHeaders())
}
