/*
 * Shared action-state shapes for `/spreadsheets` and its detail page.
 *
 * These live in their own module because `./actions.ts` is a `"use server"` file, and such a module
 * may export async functions only (§ hard rules) — yet the client islands need the state type to
 * declare their `useActionState` initial value and to read `error.fields` by name. One plain module
 * serves both sides and holds no logic. Same split as `../admin/action-types.ts`.
 *
 * No secret material appears in any of these types: a tab preview carries Google's own header cells
 * and up to ten records (`src/server/spreadsheets/service.ts:79`), which is data the caller already
 * owns, and neither type holds a token, a connection secret or an owner id.
 */

import type { TabPreview } from "@/server/spreadsheets/service"

/** Field errors keyed by the zod path the spreadsheet service reports (§4.4). */
export type SpreadsheetActionFields = Record<string, string>

/** Connect dialog: `useActionState` state. `success` carries the stored row for the feedback line. */
export type ConnectState =
  | { status: "idle" }
  | { status: "error"; message: string; code: string; fields?: SpreadsheetActionFields }
  | { status: "success"; id: string; title: string }

/** Preview panel: renders `TabPreview` on success, inline field errors on failure. */
export type PreviewState =
  | { status: "idle" }
  | { status: "error"; message: string; code: string; fields?: SpreadsheetActionFields }
  | { status: "success"; tabTitle: string; preview: TabPreview }
