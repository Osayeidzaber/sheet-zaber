"use server"

/*
 * API-configuration CRUD (`backend-api-contract.md` §2 "APIs (user)", §4.6, §4.7).
 *
 * Every verb takes the session user id as its LAST argument and returns the service's envelope
 * unchanged. `input` stays `unknown` on create/update (§4.7 convention) because
 * `apiConfigSchema` / `apiConfigUpdateSchema` in `src/lib/schemas.ts` run INSIDE
 * `src/server/apis/service.ts:201`/`:220` — a typed wrapper here would only tempt a caller to
 * skip validation, and the spreadsheet-ownership, tab-snapshot, permissions/operations and D9
 * primary-key rules all live there too.
 *
 * The only input this layer validates itself is `toggleApi`'s `enabled`, because no shared schema
 * covers it: a client-shaped object is never trusted, so anything but a real boolean (or the
 * `"true"`/`"false"` text a hidden input carries) is `validation_failed`, not a truthy coercion.
 * Ids are not validated here at all — `id` is a `text` column, so a malformed one names no row and
 * the service answers its own `not_found`, exactly as the route does (`support.ts`).
 */

import { z } from "zod"

import { fail, type ActionResult } from "@/lib/action-result"
import {
  createApi,
  deleteApi,
  getApi,
  listApis,
  toggleApi,
  updateApi,
  type ApiConfig,
} from "@/server/apis/service"

import { userAction } from "./support"

const enabledSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true")

export async function createApiAction(input: unknown): Promise<ActionResult<ApiConfig>> {
  return userAction((session) => createApi(input, session.id))
}

export async function updateApiAction(id: string, input: unknown): Promise<ActionResult<ApiConfig>> {
  return userAction((session) => updateApi(id, input, session.id))
}

export async function deleteApiAction(id: string): Promise<ActionResult<never>> {
  return userAction((session) => deleteApi(id, session.id))
}

export async function toggleApiAction(id: string, enabled: unknown): Promise<ActionResult<never>> {
  const parsed = enabledSchema.safeParse(enabled)
  if (!parsed.success) {
    return fail("validation_failed", "The action input is not valid.", "validation", {
      enabled: "must be true or false",
    })
  }
  return userAction((session) => toggleApi(id, parsed.data, session.id))
}

export async function getApiAction(id: string): Promise<ActionResult<ApiConfig>> {
  return userAction((session) => getApi(id, session.id))
}

/** `GET /api/internal/apis` as an action: the §4.6 `ApiConfig[]` owned by the session user. */
export async function listApisAction(): Promise<ActionResult<ApiConfig[]>> {
  return userAction((session) => listApis(session.id))
}
