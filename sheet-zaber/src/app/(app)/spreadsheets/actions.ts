"use server"

// Form adapters over the authenticated spreadsheet actions. Google clients,
// credentials, ownership and domain validation stay in the backend.
import { revalidatePath } from "next/cache"

import { isActionError, type ActionError, type ActionResult } from "@/lib/action-result"
import {
  previewSpreadsheetTabAction as previewTabVerb,
  refreshSpreadsheetTabsAction as refreshTabsVerb,
  registerSpreadsheetAction as registerSpreadsheetVerb,
  removeSpreadsheetAction as removeSpreadsheetVerb,
} from "@/server/actions/spreadsheets"

import type { ConnectState, PreviewState } from "./action-types"

export type { ConnectState, PreviewState, SpreadsheetActionFields } from "./action-types"

function fieldOf(formData: FormData, key: string): string {
  const value = formData.get(key)
  return typeof value === "string" ? value.trim() : ""
}

function errorState(error: ActionError): Extract<ConnectState, { status: "error" }> {
  return {
    status: "error",
    message: error.error.message,
    code: error.error.code,
    ...(error.error.fields === undefined ? {} : { fields: error.error.fields }),
  }
}

/* ---------------------------------------------------------------- connect (paste URL / ID) */

/**
 * `registerSpreadsheetVerb` (`src/server/actions/spreadsheets.ts:38`). The `connectionId` is only
 * forwarded when the picker actually chose one: the service's schema runs `z.uuid()` on it, so
 * forwarding `""` would trip a field error on a field the user never saw — blank means "let the
 * server pick your newest connection", matching the service's own fallback.
 */
export async function connectSpreadsheetAction(
  _previous: ConnectState,
  formData: FormData
): Promise<ConnectState> {
  const url = fieldOf(formData, "url")
  const connectionId = fieldOf(formData, "connectionId")

  const result = await registerSpreadsheetVerb(
    connectionId === "" ? { url } : { url, connectionId }
  )
  if (isActionError(result)) return errorState(result)

  revalidatePath("/spreadsheets")
  revalidatePath(`/spreadsheets/${result.data.id}`)
  revalidatePath("/apis", "layout")
  revalidatePath("/overview")
  return { status: "success", id: result.data.id, title: result.data.title }
}

/* ---------------------------------------------------------------- refresh tabs */

/**
 * `refreshTabsVerb` (`src/server/actions/spreadsheets.ts:45`): re-reads the snapshot and marks the
 * row `inaccessible` on a 403/404. A dead grant comes back `google_reauth_required`, which the button
 * renders as the real re-consent link (`/auth/google/connect`) rather than an invented retry.
 */
export async function refreshSpreadsheetTabsFormAction(
  id: string
): Promise<ActionResult<{ tabs: import("@/server/spreadsheets/service").SpreadsheetTab[] }>> {
  const result = await refreshTabsVerb(id)
  // A Google failure can still mark the sheet inaccessible or the grant stale.
  if (!isActionError(result) || result.error.category === "google") {
    revalidatePath("/spreadsheets")
    revalidatePath(`/spreadsheets/${id}`)
    revalidatePath("/settings")
    revalidatePath("/apis", "layout")
  }
  return result
}

/* ---------------------------------------------------------------- preview a tab (real header + records) */

/**
 * `previewTabVerb` (`src/server/actions/spreadsheets.ts:56`). `headerRow` arrives as a form string;
 * the verb types it as `number` and the service zod-coerces inside itself, so a blank or a typo still
 * surfaces as the service's `validation_failed` on `headerRow` rather than a silently defaulted 0.
 */
export async function previewSpreadsheetTabFormAction(
  _previous: PreviewState,
  formData: FormData
): Promise<PreviewState> {
  const spreadsheetId = fieldOf(formData, "spreadsheetId")
  const tabTitle = fieldOf(formData, "tabTitle")
  const headerRow = Number(fieldOf(formData, "headerRow"))

  const result = await previewTabVerb({ spreadsheetId, tabTitle, headerRow })
  if (isActionError(result)) return errorState(result)

  return { status: "success", tabTitle, preview: result.data }
}

/* ---------------------------------------------------------------- remove / disconnect */

/**
 * `removeSpreadsheetVerb` (`src/server/actions/spreadsheets.ts:65`) — owner-scoped delete; the DB
 * cascades this user's APIs. The id is the caller's own row id from the detail page, but the service
 * re-checks ownership against the session, so a forged id changes nothing.
 */
export async function removeSpreadsheetFormAction(id: string): Promise<ActionResult<{ id: string }>> {
  const result = await removeSpreadsheetVerb(id)
  if (!isActionError(result)) {
    revalidatePath("/spreadsheets")
    revalidatePath(`/spreadsheets/${id}`)
    revalidatePath("/apis", "layout")
    revalidatePath("/keys")
    revalidatePath("/overview")
  }
  return result
}
