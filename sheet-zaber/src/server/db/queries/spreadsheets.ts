import "server-only"

import { and, asc, desc, eq } from "drizzle-orm"

import { db } from "../client"
import { registeredSpreadsheets } from "../schema"
import type { DbLike, DbTx } from "./types"

/*
 * `registered_spreadsheets` repository (`google-integration.md` §3).
 *
 * `tabs` is the snapshot captured by `spreadsheets.get` at registration; the API-config layer
 * matches a request's `tab_title` against it, so the shape below is contract, not storage detail.
 */

/** `[{ id: gid, title, rows, columns }]` — the JSONB snapshot documented in §3 step 4. */
export type SpreadsheetTab = { id: number; title: string; rows: number; columns: number }

/** The schema's `jsonb` column has no `$type`, so the snapshot is narrowed here (schema is frozen). */
export type RegisteredSpreadsheetRow = Omit<
  typeof registeredSpreadsheets.$inferSelect,
  "tabs"
> & { tabs: SpreadsheetTab[] }
export type RegisteredSpreadsheetStatus = "active" | "inaccessible"

/**
 * Every function takes an optional client so a service can run it inside its transaction.
 * Typing the return as `DbLike` is the check that a `DbTx` needs no cast (see `types.ts`).
 */
function client(q?: DbLike | DbTx): DbLike {
  return q ?? db
}

/**
 * `(user_id, google_sheet_id)` is the unique key, so re-registering the same sheet updates in
 * place under one id: a later verification with a *different* account re-points `connection_id`,
 * and `status` resets to `active` because the `spreadsheets.get` that produced these tabs just
 * proved access.
 */
export async function upsertSpreadsheet(
  input: {
    userId: string
    connectionId: string
    googleSheetId: string
    title: string
    tabs: SpreadsheetTab[]
  },
  q?: DbLike | DbTx
): Promise<RegisteredSpreadsheetRow> {
  const [row] = await client(q)
    .insert(registeredSpreadsheets)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      connectionId: input.connectionId,
      googleSheetId: input.googleSheetId,
      title: input.title,
      tabs: input.tabs,
      status: "active",
    })
    .onConflictDoUpdate({
      target: [registeredSpreadsheets.userId, registeredSpreadsheets.googleSheetId],
      set: {
        connectionId: input.connectionId,
        title: input.title,
        tabs: input.tabs,
        status: "active",
        updatedAt: new Date(),
      },
    })
    .returning()
  return row as RegisteredSpreadsheetRow
}

export async function listSpreadsheets(
  userId: string,
  q?: DbLike | DbTx
): Promise<RegisteredSpreadsheetRow[]> {
  const rows = await client(q)
    .select()
    .from(registeredSpreadsheets)
    .where(eq(registeredSpreadsheets.userId, userId))
    .orderBy(desc(registeredSpreadsheets.createdAt), asc(registeredSpreadsheets.id))
  return rows as RegisteredSpreadsheetRow[]
}

/** Owner-scoped and status-blind: an `inaccessible` sheet still has to be visible to be fixed. */
export async function findSpreadsheet(
  userId: string,
  id: string,
  q?: DbLike | DbTx
): Promise<RegisteredSpreadsheetRow | undefined> {
  const [row] = await client(q)
    .select()
    .from(registeredSpreadsheets)
    .where(and(eq(registeredSpreadsheets.userId, userId), eq(registeredSpreadsheets.id, id)))
    .limit(1)
  return row as RegisteredSpreadsheetRow | undefined
}

/** `inaccessible` is set when Google stops answering for this sheet; the row is kept. */
export async function setSpreadsheetStatus(
  id: string,
  status: RegisteredSpreadsheetStatus,
  q?: DbLike | DbTx
): Promise<void> {
  await client(q)
    .update(registeredSpreadsheets)
    .set({ status, updatedAt: new Date() })
    .where(eq(registeredSpreadsheets.id, id))
}

/**
 * Refreshed snapshot ("Refresh tabs"); a sheet renamed upstream carries the new `title`. Google just
 * answered, so this also clears `inaccessible`: otherwise restored access would keep failing.
 */
export async function updateSpreadsheetTabs(
  id: string,
  tabs: SpreadsheetTab[],
  title?: string,
  q?: DbLike | DbTx
): Promise<void> {
  // Built conditionally so an absent `title` keeps the stored one instead of nulling it.
  const set: { tabs: SpreadsheetTab[]; status: RegisteredSpreadsheetStatus; updatedAt: Date; title?: string } = {
    tabs,
    status: "active",
    updatedAt: new Date(),
  }
  if (title !== undefined) set.title = title

  await client(q).update(registeredSpreadsheets).set(set).where(eq(registeredSpreadsheets.id, id))
}

export async function deleteSpreadsheet(
  userId: string,
  id: string,
  q?: DbLike | DbTx
): Promise<void> {
  await client(q)
    .delete(registeredSpreadsheets)
    .where(
      and(eq(registeredSpreadsheets.userId, userId), eq(registeredSpreadsheets.id, id))
    )
}
