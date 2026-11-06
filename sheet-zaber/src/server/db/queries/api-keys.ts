import "server-only"

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"

import { db } from "../client"
import { apiKeys, apiRequestLogs } from "../schema"
import type { DbLike, DbTx } from "./types"

export type ApiKeyScope = "read" | "write"

/**
 * `api_keys` row: the server-side view, and the only payload that ever carries `keyHash`
 * (a hash is secret-equivalent — the plaintext `sz_live_…` is never stored, never returned).
 * Drizzle types the JSONB columns as `unknown`; `schema.ts` fixes their content.
 */
export type ApiKeyRow = Omit<typeof apiKeys.$inferSelect, "scopes" | "allowedApiIds"> & {
  scopes: ApiKeyScope[]
  allowedApiIds: string[] | null
}

/** Dashboard-facing view (`backend-api-contract.md` §4.6): the row minus the hash. */
export type ApiKeyMeta = Omit<ApiKeyRow, "keyHash">

/**
 * Every function takes an optional client so a service can run it inside its transaction.
 * Typing the return as `DbLike` is the check that a `DbTx` needs no cast (see `types.ts`).
 */
function client(q?: DbLike | DbTx): DbLike {
  return q ?? db
}

function asRow(row: typeof apiKeys.$inferSelect): ApiKeyRow {
  return row as ApiKeyRow
}

/** Columns the inventory may return: `keyHash` is absent by construction, not by filtering. */
const metaColumns = {
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
}

export async function createApiKey(
  input: {
    userId: string
    name: string
    keyHash: string
    keyPreview: string
    scopes: string[]
    allowedApiIds: string[] | null
    expiresAt: Date | null
  },
  q?: DbLike | DbTx
): Promise<ApiKeyRow> {
  const [row] = await client(q)
    .insert(apiKeys)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      name: input.name,
      keyHash: input.keyHash,
      keyPreview: input.keyPreview,
      scopes: input.scopes,
      allowedApiIds: input.allowedApiIds,
      expiresAt: input.expiresAt,
    })
    .returning()
  return asRow(row)
}

/**
 * Engine auth lookup: unscoped by owner (the bearer of the key is the credential, not a
 * session), but revoked and expired keys are indistinguishable from a missing one
 * (`backend-api-contract.md` §1.1) — no 401 oracle. Expiry is judged by the database clock, so
 * no function instance's own clock can decide whether a lapsed key still works.
 */
export async function findApiKeyByHash(
  keyHash: string,
  q?: DbLike | DbTx
): Promise<ApiKeyRow | undefined> {
  const [row] = await client(q)
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyHash, keyHash),
        isNull(apiKeys.revokedAt),
        // Parenthesised: `and()` does not group a raw SQL chunk, and `OR` binds looser than `AND`.
        sql`(${apiKeys.expiresAt} is null or ${apiKeys.expiresAt} > now())`
      )
    )
    .limit(1)
  return row === undefined ? undefined : asRow(row)
}

/**
 * Owner's inventory: active keys only — a revoked row is history, not a choice — newest first.
 * Expired-but-unrevoked keys stay, so the dashboard can label them instead of hiding them.
 */
export async function listApiKeys(userId: string, q?: DbLike | DbTx): Promise<ApiKeyMeta[]> {
  const rows = await client(q)
    .select(metaColumns)
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt))
  return rows as ApiKeyMeta[]
}

/** Owner-scoped and once-only: the first revoke wins, so `revokedAt` keeps the true timestamp. */
export async function revokeApiKey(userId: string, id: string, q?: DbLike | DbTx): Promise<void> {
  await client(q)
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
}

/**
 * Hot-row guard (`database-schema.md`): one statement, and the WHERE clause is the throttle.
 * A busy key therefore writes at most once a minute, which is why `lastUsedAt` may lag. The
 * window test is parenthesised so it cannot widen past `id` and refresh a different key's row.
 */
export async function touchKeyUsed(id: string, q?: DbLike | DbTx): Promise<void> {
  await client(q)
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, id),
        sql`(${apiKeys.lastUsedAt} is null or ${apiKeys.lastUsedAt} < now() - interval '1 minute')`
      )
    )
}

/**
 * The owner-admin inventory of ANOTHER account's keys
 * (`GET /api/internal/admin/users/{id}/keys`).
 *
 * Two deliberate differences from `listApiKeys`, the session user's own dashboard list:
 * - revoked rows are INCLUDED, because `revokedAt` is a field the owner reads; a key the owner
 *   has to notice is precisely the one a self-service list hides;
 * - `requestCount` rides along, so the panel can see which credential of that account is live
 *   without clicking through each one.
 *
 * `metaColumns` is REUSED rather than re-written: `keyHash` is absent from it by construction, and
 * a second column list would be a second place that could forget that rule.
 *
 * The count is a SECOND statement, grouped — not a correlated subquery, deliberately. Drizzle
 * renders a `${column}` inside a raw chunk UNQUALIFIED when the outer select has no join, so
 * `(select count(*) … where r.api_key_id = ${apiKeys.id})` becomes `= "id"`, and Postgres resolves
 * that to the subquery's own `api_request_logs.id` (a bigint) → `operator does not exist:
 * text = bigint`. Two typed round-trips beat a fragment that only works by accident of the FROM
 * clause. `api_request_logs.api_key_id` is `ON DELETE SET NULL`, so a removed key simply stops
 * appearing in the grouped result rather than counting for the wrong credential.
 */
export type AdminApiKeyRow = ApiKeyMeta & { requestCount: number }

export async function listApiKeysForAdmin(
  userId: string,
  q?: DbLike | DbTx
): Promise<AdminApiKeyRow[]> {
  const keys = await client(q)
    .select(metaColumns)
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt))

  const ids = keys.map((key) => key.id)
  // No keys, no second statement: an empty `IN ()` is a syntax error waiting to be papered over.
  const usage =
    ids.length === 0
      ? []
      : await client(q)
          .select({ apiKeyId: apiRequestLogs.apiKeyId, total: sql<number>`count(*)::int` })
          .from(apiRequestLogs)
          .where(inArray(apiRequestLogs.apiKeyId, ids))
          .groupBy(apiRequestLogs.apiKeyId)

  const countOf = new Map(usage.map((row) => [row.apiKeyId, row.total]))
  return keys.map((key) => ({
    ...(key as ApiKeyMeta),
    requestCount: countOf.get(key.id) ?? 0,
  }))
}
