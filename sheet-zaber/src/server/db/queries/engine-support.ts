import "server-only"

import { and, eq, isNull, sql } from "drizzle-orm"

import { db } from "../client"
import { apiKeys, users } from "../schema"
import type { ApiKeyScope } from "./api-keys"
import type { UserRole } from "./users"
import type { DbLike, DbTx } from "./types"

/*
 * The two reads the public engine (`/api/v1`) needs that no existing repository offers
 * (`backend-api-contract.md` §4.8's playground arm, §1.4's per-user daily quota). Everything else
 * the engine reads — the API row (`apis/service.ts#resolveEngineApi`), the tab snapshot
 * (`queries/spreadsheets.ts#findSpreadsheet`) and the rate override
 * (`queries/api-configurations.ts#findApiConfigurationById`) — already exists and is reused, so this
 * file stays two functions wide.
 */

/** A key row addressed by id, for the in-process `keyId` arm (§4.8). */
export type EngineKeyRow = {
  id: string
  userId: string
  name: string
  scopes: ApiKeyScope[]
  allowedApiIds: string[] | null
}

/**
 * `api_keys.id` AND `user_id` in ONE statement, so a key owned by someone else is indistinguishable
 * from a nonexistent one and answers byte-identically to a wrong bearer token — the playground must
 * not be an existence oracle for other users' keys (`security.md` §3 item 2).
 *
 * `key_hash` is absent by construction, not filtered: the engine has no use for a secret-equivalent
 * column, and a plaintext key never exists anywhere outside the create response (§4.8). The
 * revoked/expired blindness mirrors `findApiKeyByHash`, evaluated on the DATABASE clock so both auth
 * arms expire at the same instant and a dead key reads exactly like a missing one.
 */
export async function findEngineKeyByIdAndOwner(
  apiKeyId: string,
  ownerId: string,
  q?: DbLike | DbTx
): Promise<EngineKeyRow | undefined> {
  if (apiKeyId.trim() === "" || ownerId.trim() === "") return undefined

  const [row] = await client(q)
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      name: apiKeys.name,
      scopes: apiKeys.scopes,
      allowedApiIds: apiKeys.allowedApiIds,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, apiKeyId),
        eq(apiKeys.userId, ownerId),
        isNull(apiKeys.revokedAt),
        // Parenthesised: `and()` does not group a raw SQL chunk, and `OR` binds looser than `AND`.
        sql`(${apiKeys.expiresAt} is null or ${apiKeys.expiresAt} > now())`
      )
    )
    .limit(1)

  if (row === undefined) return undefined

  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    scopes: row.scopes as ApiKeyScope[],
    allowedApiIds: row.allowedApiIds as string[] | null,
  }
}

/** Every function takes an optional client so a service can run it inside its transaction. */
function client(q?: DbLike | DbTx): DbLike {
  return q === undefined ? db : q
}

/** The two `users` columns the per-user daily quota is decided from — nothing else. */
export type EngineUserQuota = {
  id: string
  role: UserRole
  apiLimitPerDay: number
}

/**
 * The API owner's quota row (`backend-api-contract.md` §1.4).
 *
 * The engine limits a caller by the USER WHO OWNS THE API (`api_configurations.user_id`), across all
 * that user's APIs and keys combined, so this is the one lookup that answers both halves of the rule:
 * the number (`api_limit_per_day`, `0` = unlimited) and the role (`owner` = structurally unlimited,
 * enforced in `engine/ratelimit.ts` and nowhere else).
 *
 * `email`, `status` and every other column are absent BY CONSTRUCTION: the engine has no use for them,
 * and a quota read must not become a way to pull identity material onto the hot request path. The
 * result is `undefined` for a missing id — an API whose owner row vanished — which the caller answers
 * with the platform default rather than a refusal.
 */
export async function findEngineUserQuota(
  userId: string,
  q?: DbLike | DbTx
): Promise<EngineUserQuota | undefined> {
  if (userId.trim() === "") return undefined

  const [row] = await client(q)
    .select({ id: users.id, role: users.role, apiLimitPerDay: users.apiLimitPerDay })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (row === undefined) return undefined

  return { id: row.id, role: row.role === "owner" ? "owner" : "user", apiLimitPerDay: row.apiLimitPerDay }
}
