import "server-only"

import { and, eq } from "drizzle-orm"

import type { ActionResult } from "@/lib/action-result"
import { fail, internalError, ok } from "@/lib/action-result"
import { apiConfigSchema, apiConfigUpdateSchema } from "@/lib/schemas"
import type { SnippetMethod } from "@/lib/snippets"
import { db } from "@/server/db/client"
import { apiConfigurations, registeredSpreadsheets } from "@/server/db/schema"
import type {
  ApiConfigInput,
  ApiConfigurationRow,
  ApiPermissions,
} from "@/server/db/queries/api-configurations"
import {
  createApiConfiguration,
  deleteApiConfiguration,
  findApiConfiguration,
  listApiConfigurations,
  setApiEnabled,
  updateApiConfiguration,
} from "@/server/db/queries/api-configurations"
import type { SpreadsheetTab } from "@/server/db/queries/spreadsheets"
import { findSpreadsheet } from "@/server/db/queries/spreadsheets"

/*
 * Owner-facing API-configuration service (`backend-api-contract.md` §4.6/§4.7) plus the one
 * ENGINE-facing lookup wave 3 resolves `{api_id}` through.
 *
 * Invariants (documented in `database-schema.md` §api_configurations, D9 and §1.3):
 *   - the referenced spreadsheet belongs to the caller (`findSpreadsheet` is owner-scoped);
 *   - `tabTitle` matches a tab of the SNAPSHOT, case-sensitively — `tabs` is what
 *     `spreadsheets.get` captured, so a tab renamed upstream is invisible until refresh;
 *   - `permissions` and `allowedOperations` agree: `read` may not advertise a write verb,
 *     `read_write` must advertise at least one;
 *   - PATCH/PUT/DELETE require a non-empty `primaryKeyColumn` (D9 — the engine addresses rows by
 *     PK value, never by row number);
 *   - `headerRow >= 1`.
 * A foreign id and a missing id produce the SAME envelope, so nothing here is an existence
 * oracle (`security.md` §3 items 2 and 4).
 */

/** §4.6 — re-exported, not re-declared: the repository types are the single source of truth. */
export type { ApiConfigInput, ApiPermissions }

/** Verbs that write; `GET` is the only read verb (`backend-api-contract.md` §1.3). */
const WRITE_METHODS: readonly SnippetMethod[] = ["POST", "PATCH", "PUT", "DELETE"]
/** D9: these need `primaryKeyColumn` before the engine can address a row. */
const PK_REQUIRED_METHODS: readonly SnippetMethod[] = ["PATCH", "PUT", "DELETE"]

const PATCH_KEYS = [
  "spreadsheetId",
  "name",
  "description",
  "tabTitle",
  "headerRow",
  "primaryKeyColumn",
  "exposedColumns",
  "permissions",
  "allowedOperations",
  "rateLimitPerHour",
] as const

/**
 * The dashboard payload (§4.6 `ApiConfig`): no `userId`, nothing else. `id` is the public
 * `{api_id}`, and `enabled` is readable here but writable only through `toggleApi`.
 */
export type ApiConfig = {
  id: string
  spreadsheetId: string
  name: string
  description: string | null
  tabTitle: string
  headerRow: number
  primaryKeyColumn: string | null
  exposedColumns: string[] | null
  permissions: ApiPermissions
  allowedOperations: SnippetMethod[]
  enabled: boolean
  rateLimitPerHour: number | null
  createdAt: Date
  updatedAt: Date
}

/**
 * The engine's entire view of an API — deliberately narrow so `googleSheetId`/`connectionId`
 * are available for the Google call while `name`, `description`, `enabled` and the timestamps
 * stay out of the hot path (and out of any response a bug could echo).
 */
export type EngineApi = {
  id: string
  userId: string
  spreadsheetId: string
  googleSheetId: string
  connectionId: string
  tabTitle: string
  headerRow: number
  primaryKeyColumn: string | null
  exposedColumns: string[] | null
  permissions: ApiPermissions
  allowedOperations: SnippetMethod[]
}

/** The five columns the invariants are computed over (the rest never breaks a rule). */
type InvariantValues = Pick<
  ApiConfigInput,
  "tabTitle" | "headerRow" | "primaryKeyColumn" | "exposedColumns" | "permissions" | "allowedOperations"
>

/** `not_found` for "absent" and "not yours" alike — one call site, byte-identical message. */
function notFound(): ActionResult<never> {
  return fail("not_found", "No API was found with that id.", "not_found")
}

/** `validation_failed` carrying the per-field messages §4.4 requires (`fields` = zod path). */
function validationFailed(fields: Record<string, string>): ActionResult<never> {
  return fail("validation_failed", "The API configuration is not valid.", "validation", fields)
}

/**
 * zod's path → the `fields` map §4.4 defines. Array indices are dropped (`allowedOperations.1`
 * reports on `allowedOperations`) because that is the key a form can highlight.
 */
function zodFields(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.filter((segment) => typeof segment !== "number")
    const key = path.length > 0 ? path.map(String).join(".") : "input"
    if (!(key in fields)) fields[key] = issue.message
  }
  return fields
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function tabTitles(tabs: SpreadsheetTab[]): string[] {
  return tabs.map((tab) => tab.title)
}

/**
 * Every violated invariant at once, keyed by field. `tabs === null` skips the tab rule only
 * where the caller proved neither the sheet nor the tab title moved.
 */
function invariantFields(values: InvariantValues, tabs: SpreadsheetTab[] | null): Record<string, string> {
  const fields: Record<string, string> = {}

  if (!Number.isInteger(values.headerRow) || values.headerRow < 1) {
    fields.headerRow = "headerRow must be a whole row number of 1 or greater"
  }
  if (tabs !== null && !tabs.some((tab) => tab.title === values.tabTitle)) {
    fields.tabTitle = `tabTitle must match one of this spreadsheet's tabs exactly: ${tabTitles(tabs)
      .slice(0, 12)
      .join(", ")}`
  }

  const writeOps = values.allowedOperations.filter((method) => WRITE_METHODS.includes(method))
  if (values.permissions === "read" && writeOps.length > 0) {
    fields.allowedOperations = `a read-only API cannot allow ${writeOps.join(", ")} — set permissions to read_write`
  }
  if (values.permissions === "read_write" && writeOps.length === 0) {
    fields.permissions = "read_write requires at least one write operation (POST, PATCH, PUT or DELETE)"
  }

  const needsPrimaryKey = values.allowedOperations.some((method) =>
    PK_REQUIRED_METHODS.includes(method)
  )
  if (needsPrimaryKey && (values.primaryKeyColumn ?? "").length === 0) {
    fields.primaryKeyColumn = "PATCH, PUT and DELETE need a primary key column (decision D9)"
  }

  // A hidden key could be probed one guess at a time through GET /{record}.
  const key = values.primaryKeyColumn ?? ""
  if (key !== "" && values.exposedColumns && !values.exposedColumns.includes(key)) {
    fields.exposedColumns = "The primary key column must be one of the exposed columns"
  }

  return fields
}

/**
 * The schema's `permissions` column is plain `text`, so this is the narrowing point (the
 * repository narrows `allowedOperations` the same way). Anything unexpected degrades to `read`,
 * the least-privileged answer.
 */
function asPermissions(value: string): ApiPermissions {
  return value === "read_write" ? "read_write" : "read"
}

function toApiConfig(row: ApiConfigurationRow): ApiConfig {
  return {
    id: row.id,
    spreadsheetId: row.spreadsheetId,
    name: row.name,
    description: row.description,
    tabTitle: row.tabTitle,
    headerRow: row.headerRow,
    primaryKeyColumn: row.primaryKeyColumn,
    exposedColumns: row.exposedColumns ?? null,
    permissions: asPermissions(row.permissions),
    allowedOperations: row.allowedOperations,
    enabled: row.enabled,
    rateLimitPerHour: row.rateLimitPerHour,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function createApi(input: unknown, userId: string): Promise<ActionResult<ApiConfig>> {
  try {
    const parsed = apiConfigSchema.safeParse(input)
    if (!parsed.success) return validationFailed(zodFields(parsed.error))

    // The FK is plain, so a foreign sheet would INSERT happily — the owner-scoped read is the check.
    const spreadsheet = await findSpreadsheet(userId, parsed.data.spreadsheetId)
    if (spreadsheet === undefined) return notFound()

    const fields = invariantFields(parsed.data, spreadsheet.tabs)
    if (Object.keys(fields).length > 0) return validationFailed(fields)

    const row = await createApiConfiguration({ ...parsed.data, userId })
    return ok(toApiConfig(row))
  } catch {
    return internalError()
  }
}

export async function updateApi(
  id: string,
  input: unknown,
  userId: string
): Promise<ActionResult<ApiConfig>> {
  try {
    const current = await findApiConfiguration(userId, id)
    if (current === undefined) return notFound()

    if (!isPlainObject(input)) return validationFailed({ input: "a configuration object is required" })
    const parsed = apiConfigUpdateSchema.safeParse(input)
    if (!parsed.success) return validationFailed(zodFields(parsed.error))

    /*
     * `apiConfigUpdateSchema` is `apiConfigSchema.partial()`, and partial() in zod 4 still REPLAYS
     * a field's default when the key is absent. Forwarding the parsed object verbatim would
     * therefore rewrite `permissions`/`allowedOperations`/`headerRow` on every name-only patch, so
     * the patch is rebuilt from the keys the caller actually sent (the repository's PATCH
     * semantics then decide what is written).
     */
    const patch: Partial<ApiConfigInput> = {}
    const provided = parsed.data as Record<string, unknown>
    const target = patch as Record<string, unknown>
    for (const key of PATCH_KEYS) {
      if (input[key] !== undefined && key in provided) target[key] = provided[key]
    }

    const merged: InvariantValues & { spreadsheetId: string } = {
      spreadsheetId: current.spreadsheetId,
      tabTitle: current.tabTitle,
      headerRow: current.headerRow,
      primaryKeyColumn: current.primaryKeyColumn,
      exposedColumns: current.exposedColumns ?? null,
      permissions: asPermissions(current.permissions),
      allowedOperations: current.allowedOperations,
    }
    Object.assign(merged, patch)

    // The tab rule is re-checked only when the (sheet, tab) pair moved, and a moved sheet must
    // still be the caller's — an `inaccessible` sheet is allowed here so a broken API stays editable.
    const sheetMoved = patch.spreadsheetId !== undefined && patch.spreadsheetId !== current.spreadsheetId
    const tabMoved = patch.tabTitle !== undefined && patch.tabTitle !== current.tabTitle
    let tabs: SpreadsheetTab[] | null = null
    if (sheetMoved || tabMoved) {
      const spreadsheet = await findSpreadsheet(userId, merged.spreadsheetId)
      if (spreadsheet === undefined) return notFound()
      tabs = spreadsheet.tabs
    }

    const fields = invariantFields(merged, tabs)
    if (Object.keys(fields).length > 0) return validationFailed(fields)
    if (Object.keys(patch).length === 0) return ok(toApiConfig(current))

    const row = await updateApiConfiguration(userId, id, patch)
    if (row === undefined) return notFound()
    return ok(toApiConfig(row))
  } catch {
    return internalError()
  }
}

export async function deleteApi(id: string, userId: string): Promise<ActionResult<never>> {
  try {
    if ((await findApiConfiguration(userId, id)) === undefined) return notFound()
    await deleteApiConfiguration(userId, id)
    return ok(undefined as never)
  } catch {
    return internalError()
  }
}

export async function toggleApi(
  id: string,
  enabled: boolean,
  userId: string
): Promise<ActionResult<never>> {
  try {
    if ((await findApiConfiguration(userId, id)) === undefined) return notFound()
    await setApiEnabled(userId, id, enabled)
    return ok(undefined as never)
  } catch {
    return internalError()
  }
}

export async function getApi(id: string, userId: string): Promise<ActionResult<ApiConfig>> {
  try {
    const row = await findApiConfiguration(userId, id)
    return row === undefined ? notFound() : ok(toApiConfig(row))
  } catch {
    return internalError()
  }
}

export async function listApis(userId: string): Promise<ActionResult<ApiConfig[]>> {
  try {
    const rows = await listApiConfigurations(userId)
    return ok(rows.map(toApiConfig))
  } catch {
    return internalError()
  }
}

/**
 * The engine's API resolver (`backend-api-contract.md` §1.3 `{api_id}`). Total for wave 3:
 *
 * - any string in, `EngineApi | null` out; a malformed id simply misses the PK lookup;
 * - returns a row ONLY when `api_configurations.enabled` is true and the parent
 *   `registered_spreadsheets` row is still `status = 'active'` — a disabled API or an
 *   `inaccessible` sheet both read as absent (→ `404 api_not_found` / `api_disabled` upstream);
 * - one join, one round trip, and the column list above is the whole payload: `name`,
 *   `description`, `enabled`, `rateLimitPerHour` and the timestamps never reach the engine, so a
 *   leak from the data path cannot expose dashboard-only fields;
 * - infrastructure failures PROPAGATE rather than becoming `null`: an outage must not be
 *   reported to clients as "this API does not exist".
 *
 * Authorization (key scope/owner) is NOT here — see `keys/service.ts#authorizeKeyCall`.
 */
export async function resolveEngineApi(apiId: string): Promise<EngineApi | null> {
  const [row] = await db
    .select({
      id: apiConfigurations.id,
      userId: apiConfigurations.userId,
      spreadsheetId: apiConfigurations.spreadsheetId,
      googleSheetId: registeredSpreadsheets.googleSheetId,
      connectionId: registeredSpreadsheets.connectionId,
      tabTitle: apiConfigurations.tabTitle,
      headerRow: apiConfigurations.headerRow,
      primaryKeyColumn: apiConfigurations.primaryKeyColumn,
      exposedColumns: apiConfigurations.exposedColumns,
      permissions: apiConfigurations.permissions,
      allowedOperations: apiConfigurations.allowedOperations,
    })
    .from(apiConfigurations)
    .innerJoin(
      registeredSpreadsheets,
      eq(apiConfigurations.spreadsheetId, registeredSpreadsheets.id)
    )
    .where(
      and(
        eq(apiConfigurations.id, apiId),
        eq(apiConfigurations.enabled, true),
        eq(registeredSpreadsheets.status, "active")
      )
    )
    .limit(1)

  if (row === undefined) return null

  return {
    id: row.id,
    userId: row.userId,
    spreadsheetId: row.spreadsheetId,
    googleSheetId: row.googleSheetId,
    connectionId: row.connectionId,
    tabTitle: row.tabTitle,
    headerRow: row.headerRow,
    primaryKeyColumn: row.primaryKeyColumn,
    exposedColumns: row.exposedColumns ?? null,
    permissions: asPermissions(row.permissions),
    allowedOperations: row.allowedOperations as SnippetMethod[],
  }
}
