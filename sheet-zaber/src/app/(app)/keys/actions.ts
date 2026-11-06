"use server"

// Form adapters over authenticated key actions. Plaintext is projected only for
// the create/regenerate reveal; no list, URL, storage or log receives it here.
import { revalidatePath } from "next/cache"

import { isActionError, ok, type ActionResult } from "@/lib/action-result"
import { listApisAction } from "@/server/actions/apis"
import {
  createKeyAction as createKeyVerb,
  regenerateKeyAction as regenerateKeyVerb,
  revokeKeyAction as revokeKeyVerb,
} from "@/server/actions/keys"
import type { ApiKeyScope, CreatedApiKey } from "@/server/keys/service"

/** Field errors keyed by the zod path the service reports (`backend-api-contract.md` §4.4). */
export type KeyActionFields = {
  name?: string
  scopes?: string
  allowedApiIds?: string
  expiresAt?: string
}

/**
 * The one-time credential view the reveal panel renders. `plaintext` is the only field that ever
 * leaves the server once; `expiresAt` is ISO text so the payload stays plainly serializable.
 */
export type RevealedKey = {
  id: string
  name: string
  keyPreview: string
  scopes: ApiKeyScope[]
  allowedApiIds: string[] | null
  expiresAt: string | null
  plaintext: string
}

/** `useActionState` state for the create form. */
export type CreateKeyState =
  | { status: "idle" }
  | { status: "error"; message: string; code: string; fields?: KeyActionFields }
  | { status: "created"; key: RevealedKey }

function fieldOf(formData: FormData, key: string): string {
  const value = formData.get(key)
  return typeof value === "string" ? value.trim() : ""
}

function fieldsOf(value: Record<string, string> | undefined): KeyActionFields {
  return {
    ...(value?.name === undefined ? {} : { name: value.name }),
    ...(value?.scopes === undefined ? {} : { scopes: value.scopes }),
    ...(value?.allowedApiIds === undefined ? {} : { allowedApiIds: value.allowedApiIds }),
    ...(value?.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
  }
}

/** Field-by-field on purpose: an un-listed column cannot sneak into the reveal by accident. */
function toRevealedKey(key: CreatedApiKey): RevealedKey {
  return {
    id: key.id,
    name: key.name,
    keyPreview: key.keyPreview,
    scopes: key.scopes,
    allowedApiIds: key.allowedApiIds,
    expiresAt: key.expiresAt === null ? null : key.expiresAt.toISOString(),
    plaintext: key.plaintext,
  }
}

function errorState(message: string, fields: KeyActionFields): CreateKeyState {
  return { status: "error", code: "validation_failed", message, fields }
}

/**
 * The checkbox list is rendered only while the restriction toggle is on, so an absent
 * `allowedApiIds` means exactly one thing: `null` = all of this user's APIs (§4.6).
 *
 * A restricted key with ZERO endpoints could be stored, and `authorizeKeyCall`
 * (`src/server/keys/service.ts:250`) would then refuse every call it makes — a silently dead
 * credential. The form refuses that combination instead, and every submitted id must be one the
 * caller actually owns (ids come from `listApisAction`, so a tampered body is rejected rather than
 * trusted). Neither rule touches storage: the service still owns the schema validation.
 */
export async function createKeyFormAction(
  _previous: CreateKeyState,
  formData: FormData
): Promise<CreateKeyState> {
  const scopes = formData
    .getAll("scopes")
    .filter((value): value is string => typeof value === "string")
  const restricted = fieldOf(formData, "restricted") === "yes"
  const allowedApiIds = formData
    .getAll("allowedApiIds")
    .filter((value): value is string => typeof value === "string")
  const expiresAt = fieldOf(formData, "expiresAt")

  // Preserve the form's restriction guard: the backend schema accepts an empty
  // restriction list, which would create a key unable to call any endpoint.
  if (restricted && allowedApiIds.length === 0) {
    return errorState("The API key input is not valid.", {
      allowedApiIds: "Pick at least one endpoint, or leave the restriction off for all endpoints.",
    })
  }

  if (restricted) {
    const apis = await listApisAction()
    if (isActionError(apis)) {
      return { status: "error", message: apis.error.message, code: apis.error.code }
    }
    const ownedIds = apis.data.map((api) => api.id)
    const foreign = allowedApiIds.filter((id) => !ownedIds.includes(id))
    if (foreign.length > 0) {
      return errorState("The API key input is not valid.", {
        allowedApiIds: "One or more selected endpoints are no longer yours. Reload and pick again.",
      })
    }
  }

  const input: Record<string, unknown> = {
    name: fieldOf(formData, "name"),
    scopes,
    allowedApiIds: restricted ? allowedApiIds : null,
  }
  if (expiresAt !== "") input.expiresAt = expiresAt

  const result = await createKeyVerb(input)
  if (isActionError(result)) {
    return {
      status: "error",
      message: result.error.message,
      code: result.error.code,
      fields: fieldsOf(result.error.fields),
    }
  }

  revalidatePath("/keys")
  revalidatePath("/overview")
  return { status: "created", key: toRevealedKey(result.data) }
}

/**
 * `revokeKeyVerb` (`src/server/actions/keys.ts:43`), owner-scoped and idempotent server-side. The
 * return carries the id ONLY — a revocation cannot produce key material of any kind.
 */
export async function revokeKeyFormAction(id: string): Promise<ActionResult<{ id: string }>> {
  const result = await revokeKeyVerb(id)
  if (isActionError(result)) return result

  revalidatePath("/keys")
  revalidatePath("/overview")
  return ok({ id })
}

/**
 * `regenerateKeyVerb` (`src/server/actions/keys.ts:48`): revoke the old row + INSERT a new one, so
 * the old `sz_live_…` stops working immediately and the audit trail survives. The fresh plaintext
 * is returned once, through the same one-time reveal as creation.
 */
export async function regenerateKeyFormAction(id: string): Promise<ActionResult<RevealedKey>> {
  const result = await regenerateKeyVerb(id)
  if (isActionError(result)) return result

  revalidatePath("/keys")
  revalidatePath("/overview")
  return ok(toRevealedKey(result.data))
}
