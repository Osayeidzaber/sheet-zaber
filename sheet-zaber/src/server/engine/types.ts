import "server-only"

import type { SnippetMethod } from "@/lib/snippets"
import type { EngineApi } from "@/server/apis/service"
import type { SheetTab, SheetsClient } from "@/server/google/sheets"

/*
 * The public data engine's vocabulary (`backend-api-contract.md` §1).
 *
 * These types are the boundary between the wire (`/api/v1/**`), the in-process caller (the
 * playground, which imports `handleEngineCall` directly) and the grid. Nothing here may widen
 * toward the dashboard: `EngineApi`/`SheetsClient` are imported type-only so this file adds no
 * runtime dependency, and no type below carries key material, a hash, or a row number that the
 * wire is not allowed to see.
 */

/** One record as the client sees it: header key → cell text. Values are always strings (§1.3). */
export type EngineRecord = Record<string, string>

/**
 * `gridRow` is the 1-based row in the sheet grid. It NEVER crosses the wire (§1.5): it exists so
 * a write can be aimed at the right row, and the outcome builder only ever serialises `record`.
 */
export type EngineRow = { gridRow: number; record: EngineRecord }

/**
 * The whole-tab projection of one API's tab. `tab` is the registered tab (declared
 * `rows`/`columns` and Google's gid) and is what a range bounds check and a row delete aim at.
 */
export type EngineTable = { headers: string[]; rows: EngineRow[]; tab: SheetTab }

/** §1.2's success `meta`. Exactly these five keys, in this order — a contract test pins it. */
export type EngineMeta = {
  api_id: string
  count: number
  limit: number | null
  offset: number
  duration_ms: number
}

/**
 * How the caller proved who it is (§1.1; §4.8's playground mechanism).
 * - `bearer`: the credential carried by `Authorization: Bearer …`. `""` means the header was
 *   absent or not a Bearer scheme, which is `missing_key`, not `invalid_key`.
 * - `keyId`: an `api_keys.id` plus the session owner, for the in-process playground only — a
 *   plaintext key cannot be re-derived from a row (`api_keys` stores a hash), so the playground
 *   authenticates by row id. `ownerId` is checked in the same statement as `apiKeyId`, so a
 *   foreign id is indistinguishable from a nonexistent one: both arms reach the same 401 bytes.
 */
export type EngineAuth =
  | { kind: "bearer"; token: string }
  | { kind: "keyId"; apiKeyId: string; ownerId: string }

export type EngineCall = {
  auth: EngineAuth
  method: SnippetMethod
  /** Path segments after `/api/v1`, percent-decoded: [] | [api] | [api, record] | [api, "search"] | [api, "range", a1]. */
  pathSegments: string[]
  searchParams: URLSearchParams
  /** Raw JSON text as it arrived, or null. Never parsed here, never logged (§1.5). */
  bodyText: string | null
  /** Client IP (`x-forwarded-for`): a bucket dimension only, never logged or stored (§2 security.md). */
  ip: string | null
  /** Hostname from the Origin or Referer header, kept in the log. Never a path or query. */
  origin?: string | null
}

/**
 * The complete HTTP answer, ready to send. `body` is the §1.2 envelope ALREADY serialised, so the
 * playground and the route handler forward the same bytes and cannot re-format them (§4.8).
 */
export type EngineOutcome = {
  status: number
  body: string
  headers: Record<string, string>
}

/**
 * THE SEAM: `sheetsFor` is the engine's only route to Google, and `handleEngineCall`'s second
 * argument replaces it — `tests/helpers/fake-sheets.ts` is injected as the real client, so no
 * engine test opens a socket (`architecture.md` §5 keeps `googleapis` inside `src/server/google/*`).
 */
export type EngineDeps = {
  sheetsFor(api: EngineApi): Promise<SheetsClient>
}
