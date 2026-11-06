"use server"

/*
 * API-key mutations and the owner-scoped key list (`backend-api-contract.md` §2 "Keys (user)",
 * §4.6, §4.7; `docs/security.md` §2 "hashed API keys").
 *
 * THE SECRET RULE, stated once where it is subtle:
 *  - A READ never carries key material. `listKeysAction` delegates to `listKeyItems`
 *    (`src/server/keys/service.ts:215`), which is the `userId`-free wire shape, and `key_hash` is
 *    excluded column-by-column by the service. So are `revokeKeyAction`'s (no payload at all) and
 *    every guard/validation failure.
 *  - The ONE-TIME plaintext is returned by exactly two verbs — `createKeyAction` and
 *    `regenerateKeyAction` — because §4.6 names those two as the only place a plaintext has ever
 *    existed, and `createKey`/`regenerateKey` are the service signatures that produce it. The brief
 *    for this layer says "never return a secret" and "return the service's ActionResult unchanged";
 *    for these two verbs those sentences collide, and the contract resolves it in favor of the
 *    one-time reveal. Nothing here stores, logs or re-reads that string: there is no
 *    "get the plaintext of key X" verb because none can exist.
 *
 * `input` is `unknown` and `createKeySchema` validates it inside the service (`keys/service.ts:137`);
 * `revokeKey`/`regenerateKey` are owner-scoped (`:157`/`:170`) and answer the same `not_found` for
 * "absent", "not yours" and — because `api_keys.id` is `text`, not a `uuid` column — a malformed id,
 * so this layer validates nothing further and cannot surface a driver error.
 */

import type { ActionResult } from "@/lib/action-result"
import {
  createKey,
  listKeyItems,
  regenerateKey,
  revokeKey,
  type CreatedApiKey,
  type KeyListItem,
} from "@/server/keys/service"

import { userAction } from "./support"

export async function createKeyAction(input: unknown): Promise<ActionResult<CreatedApiKey>> {
  return userAction((session) => createKey(input, session.id))
}

/** §4.7 `revokeKey(id, userId)`; idempotent, and its success payload is empty on purpose. */
export async function revokeKeyAction(id: string): Promise<ActionResult<never>> {
  return userAction((session) => revokeKey(id, session.id))
}

/** §4.7 `regenerateKey(id, userId)`: revoke the old row + INSERT a new one, fresh plaintext once. */
export async function regenerateKeyAction(id: string): Promise<ActionResult<CreatedApiKey>> {
  return userAction((session) => regenerateKey(id, session.id))
}

/** `GET /api/internal/keys` as an action: active keys, `keyPreview` only, no `userId`, no hash. */
export async function listKeysAction(): Promise<ActionResult<KeyListItem[]>> {
  return userAction((session) => listKeyItems(session.id))
}
