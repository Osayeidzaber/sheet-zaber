import "server-only"

import { and, desc, eq } from "drizzle-orm"

import type { SnippetMethod } from "@/lib/snippets"

import { db } from "../client"
import { apiConfigurations } from "../schema"
import type { DbLike, DbTx } from "./types"

export type ApiPermissions = "read" | "read_write"

/**
 * `api_configurations` row. `id` is the public `{api_id}` (backend-api-contract.md §1.3), so
 * this payload serves the engine as well as the dashboard. Drizzle types the JSONB column as
 * `unknown`; the table's documented content is a subset of `METHOD_VALUES` (`schema.ts`).
 */
export type ApiConfigurationRow = Omit<
  typeof apiConfigurations.$inferSelect,
  "allowedOperations"
> & {
  allowedOperations: SnippetMethod[]
}

/**
 * Write surface (`enabled` is absent — it changes only through `setApiEnabled`, and
 * `userId` is added by the caller). The nullable members accept `null` deliberately: the
 * dashboard clears a description or falls back to the platform rate limit.
 */
export type ApiConfigInput = {
  spreadsheetId: string
  name: string
  description?: string | null
  tabTitle: string
  headerRow: number
  primaryKeyColumn?: string | null
  exposedColumns?: string[] | null
  permissions: ApiPermissions
  allowedOperations: SnippetMethod[]
  rateLimitPerHour?: number | null
}

/**
 * Every function takes an optional client so a service can run it inside its transaction.
 * Typing the return as `DbLike` is the check that a `DbTx` needs no cast (see `types.ts`).
 */
function client(q?: DbLike | DbTx): DbLike {
  return q ?? db
}

function asRow(row: typeof apiConfigurations.$inferSelect): ApiConfigurationRow {
  return row as ApiConfigurationRow
}

/**
 * INSERT only: no ownership probe on `spreadsheetId`, because the FK is plain
 * (`database-schema.md`) — a foreign spreadsheet satisfies it, ownership is an app-layer
 * check, and ON DELETE CASCADE is the documented outcome. Constraint violations surface the
 * raw driver error so callers can branch on `constraint`.
 */
export async function createApiConfiguration(
  input: ApiConfigInput & { userId: string },
  q?: DbLike | DbTx
): Promise<ApiConfigurationRow> {
  const [row] = await client(q)
    .insert(apiConfigurations)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      spreadsheetId: input.spreadsheetId,
      name: input.name,
      description: input.description ?? null,
      tabTitle: input.tabTitle,
      headerRow: input.headerRow,
      primaryKeyColumn: input.primaryKeyColumn ?? null,
      exposedColumns: input.exposedColumns ?? null,
      permissions: input.permissions,
      allowedOperations: input.allowedOperations,
      rateLimitPerHour: input.rateLimitPerHour ?? null,
    })
    .returning()
  return asRow(row)
}

/** Dashboard lookup: a row the user does not own reads as absent (`security.md` §3 item 4). */
export async function findApiConfiguration(
  userId: string,
  id: string,
  q?: DbLike | DbTx
): Promise<ApiConfigurationRow | undefined> {
  const [row] = await client(q)
    .select()
    .from(apiConfigurations)
    .where(and(eq(apiConfigurations.userId, userId), eq(apiConfigurations.id, id)))
    .limit(1)
  return row === undefined ? undefined : asRow(row)
}

/**
 * Engine lookup: deliberately UNscoped — `{api_id}` is the public uuid and the caller has no
 * session, only a key. Authorization (key owner/scope) happens above this function, never here.
 */
export async function findApiConfigurationById(
  id: string,
  q?: DbLike | DbTx
): Promise<ApiConfigurationRow | undefined> {
  const [row] = await client(q)
    .select()
    .from(apiConfigurations)
    .where(eq(apiConfigurations.id, id))
    .limit(1)
  return row === undefined ? undefined : asRow(row)
}

export async function listApiConfigurations(
  userId: string,
  q?: DbLike | DbTx
): Promise<ApiConfigurationRow[]> {
  const rows = await client(q)
    .select()
    .from(apiConfigurations)
    .where(eq(apiConfigurations.userId, userId))
    .orderBy(desc(apiConfigurations.createdAt))
  return rows.map((row) => asRow(row))
}

/**
 * PATCH semantics: a key absent from `patch` keeps its column, an explicit `null` writes NULL
 * (the three nullable columns are exactly how a user clears a description, a primary key or a
 * per-API rate limit). Owner-scoped, so a foreign `id` changes nothing and returns `undefined`.
 */
export async function updateApiConfiguration(
  userId: string,
  id: string,
  patch: Partial<ApiConfigInput>,
  q?: DbLike | DbTx
): Promise<ApiConfigurationRow | undefined> {
  const set: Partial<typeof apiConfigurations.$inferInsert> = { updatedAt: new Date() }
  if (patch.spreadsheetId !== undefined) set.spreadsheetId = patch.spreadsheetId
  if (patch.name !== undefined) set.name = patch.name
  if (patch.description !== undefined) set.description = patch.description
  if (patch.tabTitle !== undefined) set.tabTitle = patch.tabTitle
  if (patch.headerRow !== undefined) set.headerRow = patch.headerRow
  if (patch.primaryKeyColumn !== undefined) set.primaryKeyColumn = patch.primaryKeyColumn
  if (patch.exposedColumns !== undefined) set.exposedColumns = patch.exposedColumns
  if (patch.permissions !== undefined) set.permissions = patch.permissions
  if (patch.allowedOperations !== undefined) set.allowedOperations = patch.allowedOperations
  if (patch.rateLimitPerHour !== undefined) set.rateLimitPerHour = patch.rateLimitPerHour

  const [row] = await client(q)
    .update(apiConfigurations)
    .set(set)
    .where(and(eq(apiConfigurations.userId, userId), eq(apiConfigurations.id, id)))
    .returning()
  return row === undefined ? undefined : asRow(row)
}

/** `toggleApi` writes (`backend-api-contract.md` §4.7); the engine sees the new value immediately. */
export async function setApiEnabled(
  userId: string,
  id: string,
  enabled: boolean,
  q?: DbLike | DbTx
): Promise<void> {
  await client(q)
    .update(apiConfigurations)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(apiConfigurations.userId, userId), eq(apiConfigurations.id, id)))
}

export async function deleteApiConfiguration(
  userId: string,
  id: string,
  q?: DbLike | DbTx
): Promise<void> {
  await client(q)
    .delete(apiConfigurations)
    .where(and(eq(apiConfigurations.userId, userId), eq(apiConfigurations.id, id)))
}
