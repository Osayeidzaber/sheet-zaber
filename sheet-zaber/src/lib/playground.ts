import type { ActionResult } from "@/lib/action-result"
import type { SnippetMethod } from "@/lib/snippets"

/*
 * The playground's wire shape (`backend-api-contract.md` §4.8). Client-importable: no
 * `server-only`, no key material, and nothing here that the browser is not allowed to see.
 *
 * `playgroundRequestSchema` in `src/lib/schemas.ts` is this type's validator. The service assigns
 * the parsed value to `PlaygroundRequest`, so the schema and the type cannot drift silently —
 * widening one without the other is a compile error, not a runtime surprise.
 */

export type PlaygroundRequest = {
  /** `api_keys.id`, owned by the session user. There is no key field: the proxy injects it. */
  apiKeyId: string
  method: SnippetMethod
  /** Path after `/api/v1`, e.g. `"{apiId}"`, `"{apiId}/{record}"`, `"{apiId}/search"`, `"{apiId}/range/A1:D20"`. */
  path: string
  query?: Record<string, string | string[]>
  /** An `Authorization` header here is ignored, never forwarded (`security.md` §4). */
  headers?: Record<string, string>
  /** Raw JSON text exactly as typed; the engine validates it. */
  bodyJson?: string
}

export type PlaygroundResponse = {
  /** The engine's status, verbatim — a 404/409/422/429 is a successful playground call. */
  status: number
  durationMs: number
  headers: Record<string, string>
  /** The engine's body verbatim; `§1.2`'s envelope on a non-2xx. */
  body: string
}

export type PlaygroundResult = ActionResult<PlaygroundResponse>
