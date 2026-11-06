import "server-only"

import { and, eq } from "drizzle-orm"

import type { ActionResult } from "@/lib/action-result"
import { fail, internalError, ok } from "@/lib/action-result"
import { createKeySchema } from "@/lib/schemas"
import { generateApiKey, sha256 } from "@/lib/crypto"
import type { SnippetMethod } from "@/lib/snippets"
import { db } from "@/server/db/client"
import { apiKeys } from "@/server/db/schema"
import type { ApiKeyMeta, ApiKeyRow, ApiKeyScope } from "@/server/db/queries/api-keys"
import {
  createApiKey,
  findApiKeyByHash,
  listApiKeys,
  revokeApiKey,
  touchKeyUsed,
} from "@/server/db/queries/api-keys"
import type { ApiPermissions } from "@/server/db/queries/api-configurations"

/*
 * API-key service (`backend-api-contract.md` §2, §4.6/§4.7; `security.md` "hashed API keys").
 *
 * Storage rule: `api_keys` holds SHA-256 `key_hash` + `key_preview` ONLY. The plaintext
 * `sz_live_…` exists in exactly one place — the return value of `createKey` / `regenerateKey` —
 * and no read path in this module can produce it: `authenticateKey` maps the row to a narrow
 * shape, and the by-id lookup below selects columns explicitly so `keyHash` cannot be read even
 * by accident (a hash is secret-equivalent). A consequence for the playground (§4.8): it must
 * authenticate by `api_keys.id`, because the plaintext can never be re-injected from a row.
 */

export type { ApiKeyMeta, ApiKeyScope }

/** §4.6: `ApiKeyMeta` plus the one-time plaintext. */
export type CreatedApiKey = ApiKeyMeta & { plaintext: string }

/**
 * The engine's authenticated-principal view of a key. Deliberately minimal — no hash, no
 * preview, no timestamps — so the data path cannot read key material of any kind.
 */
export type EngineKey = {
  id: string
  userId: string
  scopes: ApiKeyScope[]
  allowedApiIds: string[] | null
  name: string
}

/** The slice of an API the authorization decision reads (§4.6 `EngineApi` satisfies it). */
export type AuthorizeApi = {
  id: string
  userId: string
  permissions: ApiPermissions
  allowedOperations: SnippetMethod[]
}

export type AuthorizeDecision = { ok: true } | { ok: false; code: string }

const WRITE_METHODS: readonly SnippetMethod[] = ["POST", "PATCH", "PUT", "DELETE"]

/** "Absent" and "not yours" are one envelope — the revoke/regenerate paths share it. */
function notFound(): ActionResult<never> {
  return fail("not_found", "No API key was found with that id.", "not_found")
}

function validationFailed(fields: Record<string, string>): ActionResult<never> {
  return fail("validation_failed", "The API key input is not valid.", "validation", fields)
}

/** zod's path → the `fields` map §4.4 defines; array indices report on their field. */
function zodFields(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.filter((segment) => typeof segment !== "number")
    const key = path.length > 0 ? path.map(String).join(".") : "input"
    if (!(key in fields)) fields[key] = issue.message
  }
  return fields
}

/**
 * The §4.6 meta. Every field is named, so `keyHash` is absent BY CONSTRUCTION — the payload
 * cannot grow a hash by accident, which is the whole storage rule of this table.
 */
function toMeta(row: ApiKeyRow): ApiKeyMeta {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    keyPreview: row.keyPreview,
    scopes: row.scopes,
    allowedApiIds: row.allowedApiIds,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  }
}

/**
 * Owner-scoped by-id read. The repository has no `findApiKeyById` (and this task may not add
 * one), and `listApiKeys` hides revoked rows — which regenerate must still be able to read.
 * The column list is the guarantee: `keyHash` is not selected, so it cannot leak.
 */
async function findOwnedKey(userId: string, id: string): Promise<ApiKeyMeta | undefined> {
  const [row] = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      name: apiKeys.name,
      keyPreview: apiKeys.keyPreview,
      scopes: apiKeys.scopes,
      allowedApiIds: apiKeys.allowedApiIds,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .limit(1)

  if (row === undefined) return undefined
  return {
    ...row,
    scopes: row.scopes as ApiKeyScope[],
    allowedApiIds: row.allowedApiIds as string[] | null,
  }
}

export async function createKey(
  input: unknown,
  userId: string
): Promise<ActionResult<CreatedApiKey>> {
  try {
    const parsed = createKeySchema.safeParse(input)
    if (!parsed.success) return validationFailed(zodFields(parsed.error))

    const key = generateApiKey()
    const row = await createApiKey({
      userId,
      name: parsed.data.name,
      keyHash: key.hash,
      keyPreview: key.preview,
      scopes: parsed.data.scopes,
      allowedApiIds: parsed.data.allowedApiIds,
      expiresAt: parsed.data.expiresAt ?? null,
    })

    return ok({ ...toMeta(row), plaintext: key.plaintext })
  } catch {
    return internalError()
  }
}

export async function revokeKey(id: string, userId: string): Promise<ActionResult<never>> {
  try {
    const row = await findOwnedKey(userId, id)
    if (row === undefined) return notFound()
    // Idempotent like `revokeInvitation`: a revoked row is already the requested end state, and
    // the repository's conditional UPDATE is what keeps the ORIGINAL timestamp.
    if (row.revokedAt === null) await revokeApiKey(userId, id)
    return ok(undefined as never)
  } catch {
    return internalError()
  }
}

export async function regenerateKey(
  id: string,
  userId: string
): Promise<ActionResult<CreatedApiKey>> {
  try {
    const old = await findOwnedKey(userId, id)
    if (old === undefined) return notFound()

    // Revoke + INSERT (never mutate a hash) so the audit trail of the old credential survives.
    await revokeApiKey(userId, id)

    const key = generateApiKey()
    const row = await createApiKey({
      userId,
      name: old.name,
      keyHash: key.hash,
      keyPreview: key.preview,
      scopes: old.scopes,
      allowedApiIds: old.allowedApiIds,
      // A lapsed expiry must not be copied onto the replacement: that would mint a dead key.
      expiresAt: old.expiresAt !== null && old.expiresAt.getTime() > Date.now() ? old.expiresAt : null,
    })

    return ok({ ...toMeta(row), plaintext: key.plaintext })
  } catch {
    return internalError()
  }
}

export async function listKeys(userId: string): Promise<ActionResult<ApiKeyMeta[]>> {
  try {
    return ok(await listApiKeys(userId))
  } catch {
    return internalError()
  }
}

/** §4.6 dashboard key row: the repository view without `userId` — the list is already session-scoped. */
export type KeyListItem = Omit<ApiKeyMeta, "userId">

/**
 * The wire shape for `GET /api/internal/keys`, projected HERE rather than in a route so no future
 * consumer can serialize a key list with an owner id on it. Field-by-field on purpose: an
 * un-listed column cannot sneak through.
 */
export async function listKeyItems(userId: string): Promise<ActionResult<KeyListItem[]>> {
  const result = await listKeys(userId)
  if (!result.ok) return result
  return ok(
    result.data.map((meta) => ({
      id: meta.id,
      name: meta.name,
      keyPreview: meta.keyPreview,
      scopes: meta.scopes,
      allowedApiIds: meta.allowedApiIds,
      expiresAt: meta.expiresAt,
      revokedAt: meta.revokedAt,
      lastUsedAt: meta.lastUsedAt,
      createdAt: meta.createdAt,
    }))
  )
}

/**
 * Engine authentication (`backend-api-contract.md` §1.1): hash the bearer token and look the
 * hash up. No constant-time compare is needed — the DB matches on hash equality and an unknown
 * hash is indistinguishable from a revoked or expired one, all of them `null` (no 401 oracle).
 */
export async function authenticateKey(plaintext: string): Promise<EngineKey | null> {
  const row = await findApiKeyByHash(sha256(plaintext))
  if (row === undefined) return null

  return {
    id: row.id,
    userId: row.userId,
    scopes: row.scopes,
    allowedApiIds: row.allowedApiIds,
    name: row.name,
  }
}

/**
 * The engine's WHOLE authorization decision: pure, total, side-effect-free, and ordered — the
 * order is the contract, because the first failing rule names the code the client sees.
 *
 *  1. ownership        `key.userId !== api.userId`                    → `api_not_found`  (404)
 *     — the cross-user answer is the SAME code as an unknown api id, and it comes first so a
 *     restricted key cannot probe another user's APIs either (`security.md` §3 item 2).
 *  2. key restriction  `allowedApiIds !== null && !includes(api.id)` → `key_restricted` (403)
 *  3. api operations   `method ∉ api.allowedOperations`               → `operation_not_allowed` (403)
 *  4. api permissions  `permissions === "read"` and `method` writes   → `operation_not_allowed` (403)
 *  5. key scopes       GET needs `read`, a write verb needs `write`   → `key_scope_insufficient` (403)
 *
 * API-shape refusals (3, 4) precede key-scope refusals (5): a read-only API refuses a write for
 * EVERY key, so the reason cannot depend on which key arrived.
 *
 * Out of scope by design: `api_disabled` / `google_sheet_inaccessible` (the API was never
 * resolved — see `resolveEngineApi`), rate limiting (a bucket, not a decision), and
 * `write_requires_primary_key` — the engine checks `EngineApi.primaryKeyColumn` when it addresses
 * a `{record}`, since a list+filter write needs no PK.
 */
export function authorizeKeyCall(
  key: EngineKey,
  api: AuthorizeApi,
  method: SnippetMethod
): AuthorizeDecision {
  if (key.userId !== api.userId) return { ok: false, code: "api_not_found" }
  if (key.allowedApiIds !== null && !key.allowedApiIds.includes(api.id)) {
    return { ok: false, code: "key_restricted" }
  }

  const isWrite = WRITE_METHODS.includes(method)
  if (!api.allowedOperations.includes(method)) return { ok: false, code: "operation_not_allowed" }
  if (isWrite && api.permissions !== "read_write") return { ok: false, code: "operation_not_allowed" }

  const requiredScope: ApiKeyScope = isWrite ? "write" : "read"
  if (!key.scopes.includes(requiredScope)) return { ok: false, code: "key_scope_insufficient" }

  return { ok: true }
}

/**
 * The engine's "this key was just used" write. A thin pass-through to the repository's
 * one-per-minute throttle (the WHERE clause IS the throttle), kept here so the engine imports
 * every key-facing primitive from this module and never handles a hash.
 */
export async function markKeyUsed(keyId: string): Promise<void> {
  await touchKeyUsed(keyId)
}
