import "server-only"

import { and, desc, eq } from "drizzle-orm"

import { db } from "../client"
import { auditLogs } from "../schema"
import { type DbLike, type DbTx } from "./types"

export type AuditRow = typeof auditLogs.$inferSelect

/**
 * Every function takes an optional client so a service can run it inside its transaction.
 * `q` returns directly rather than through `asDbLike(q)` (the `users.ts` shape): that helper
 * narrows `Db | DbTx`, so a plain `DbLike` arm stops compiling against it; the declared
 * `DbLike` return type keeps the same assignability proof for `DbTx`.
 */
function client(q?: DbLike | DbTx): DbLike {
  return q === undefined ? db : q
}

/** Append one row. `actorId: null` is legal (`owner.bootstrap` and other system rows). */
export async function writeAudit(
  input: {
    actorId: string | null
    action: string
    subjectType?: string | null
    subjectId?: string | null
    detail?: Record<string, unknown>
  },
  q?: DbLike | DbTx
): Promise<AuditRow> {
  const [row] = await client(q)
    .insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      actorId: input.actorId,
      action: input.action,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      detail: input.detail ?? {},
    })
    .returning()
  return row
}

/** Newest first; only the provided filters are combined. `and()` drops undefined conditions. */
export async function listAudit(
  filter: { actorId?: string; subjectType?: string; subjectId?: string; limit: number },
  q?: DbLike | DbTx
): Promise<AuditRow[]> {
  return client(q)
    .select()
    .from(auditLogs)
    .where(
      and(
        filter.actorId !== undefined ? eq(auditLogs.actorId, filter.actorId) : undefined,
        filter.subjectType !== undefined ? eq(auditLogs.subjectType, filter.subjectType) : undefined,
        filter.subjectId !== undefined ? eq(auditLogs.subjectId, filter.subjectId) : undefined
      )
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(filter.limit)
}
