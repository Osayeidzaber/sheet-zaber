"use server"

// Adapt forms, returned errors and cache invalidation. The backend actions own
// authentication, ownership, validation and mutations. Their auth errors are data
// the forms can render; Next redirects are also legal in server actions.
import { revalidatePath } from "next/cache"

import { isActionError, type ActionError, type ActionResult } from "@/lib/action-result"
import {
  createApiAction,
  deleteApiAction as deleteApiVerb,
  toggleApiAction as toggleApiVerb,
  updateApiAction,
} from "@/server/actions/apis"

export type ApiFieldErrors = Record<string, string>

export type ApiFormState =
  | { status: "idle" }
  | { status: "error"; message: string; code: string; fields?: ApiFieldErrors }
  | { status: "success"; id: string; created: boolean }

/**
 * The edit form's seed, projected from the §4.6 `ApiConfig` so the client never imports the
 * `server-only` service type. `description`/`primaryKeyColumn` arrive as `""` (a nullable column shown
 * as an empty field), `rateLimitPerHour` as `number | null` (null = platform default).
 */
export type ApiFormInitial = {
  spreadsheetId: string
  name: string
  description: string
  tabTitle: string
  headerRow: number
  primaryKeyColumn: string
  exposedColumns: string[] | null
  permissions: "read" | "read_write"
  allowedOperations: string[]
  rateLimitPerHour: number | null
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key)
  return typeof value === "string" ? value.trim() : ""
}

/** Empty text → `null`, so the user clearing a description / primary key / rate limit really clears it. */
function textOrNull(formData: FormData, key: string): string | null {
  const value = text(formData, key)
  return value === "" ? null : value
}

/** Empty → `null` (platform default); non-empty is forwarded as text for zod to coerce + validate. */
function rateLimitOrNull(formData: FormData): string | null {
  const value = text(formData, "rateLimitPerHour")
  return value === "" ? null : value
}

function exposedColumnsField(formData: FormData): { exposedColumns?: string[] | null } {
  const mode = text(formData, "columnsMode")
  if (mode === "all") return { exposedColumns: null }
  if (mode === "selected") {
    return { exposedColumns: formData.getAll("exposedColumns").filter((v): v is string => typeof v === "string") }
  }
  return {}
}

function buildInput(formData: FormData) {
  return {
    spreadsheetId: text(formData, "spreadsheetId"),
    name: text(formData, "name"),
    description: textOrNull(formData, "description"),
    tabTitle: text(formData, "tabTitle"),
    // headerRow / rateLimitPerHour ride as text: `z.coerce.number()` turns "1"→1 and a stray "" into a
    // real validation error on the field, instead of us silently defaulting and masking a typo.
    headerRow: text(formData, "headerRow"),
    primaryKeyColumn: textOrNull(formData, "primaryKeyColumn"),
    // No mode means the picker never loaded the header row, so an edit leaves the choice alone.
    ...exposedColumnsField(formData),
    permissions: text(formData, "permissions"),
    allowedOperations: formData.getAll("allowedOperations").filter((v): v is string => typeof v === "string"),
    rateLimitPerHour: rateLimitOrNull(formData),
  }
}

function toErrorState(result: ActionError): ApiFormState {
  return {
    status: "error",
    message: result.error.message,
    code: result.error.code,
    ...(result.error.fields === undefined ? {} : { fields: result.error.fields }),
  }
}

/**
 * One create/edit form action. The presence of `apiId` (a hidden field the edit page sets) decides the
 * path — an absent id creates, a present id updates. `updateApiAction` is owner-scoped inside the
 * service (`findApiConfiguration(userId, id)`), so the id is only ever honoured against the caller's
 * own row.
 */
export async function saveApiConfigAction(
  _previous: ApiFormState,
  formData: FormData
): Promise<ApiFormState> {
  const apiId = text(formData, "apiId")
  const input = buildInput(formData)

  const result =
    apiId === "" ? await createApiAction(input) : await updateApiAction(apiId, input)

  if (isActionError(result)) return toErrorState(result)

  revalidatePath("/apis")
  revalidatePath(`/apis/${result.data.id}`)
  revalidatePath(`/apis/${result.data.id}/edit`)
  revalidatePath("/keys")
  revalidatePath("/overview")
  return { status: "success", id: result.data.id, created: apiId === "" }
}

/**
 * `toggleApiVerb` (`src/server/actions/apis.ts:51`), which validates `enabled` itself — anything but a
 * real boolean or `"true"`/`"false"` text is `validation_failed`. Cache refresh is the only thing added
 * here, because the backend lane deliberately carries no `revalidatePath`.
 */
export async function toggleApiFormAction(id: string, enabled: boolean): Promise<ActionResult<never>> {
  const result = await toggleApiVerb(id, enabled)
  if (!isActionError(result)) {
    revalidatePath("/apis")
    revalidatePath(`/apis/${id}`)
    revalidatePath(`/apis/${id}/edit`)
  }
  return result
}

/** `deleteApiVerb` (`src/server/actions/apis.ts:47`); owner-scoped `not_found` is the verb's answer. */
export async function deleteApiFormAction(id: string): Promise<ActionResult<never>> {
  const result = await deleteApiVerb(id)
  if (!isActionError(result)) {
    revalidatePath("/apis")
    revalidatePath(`/apis/${id}`)
    revalidatePath(`/apis/${id}/edit`)
    revalidatePath("/keys")
    revalidatePath("/overview")
  }
  return result
}
