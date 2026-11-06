import "server-only"

import type { Db } from "../client"

/**
 * Anything that can run queries: the pooled client or an open transaction. Written as a
 * structural `Pick` so a Drizzle transaction handle is assignable without a cast;
 * `asDbLike` is the compile-time proof of that (if it ever stops compiling, the union
 * breaks loudly here instead of in a service).
 */
export type DbLike = Pick<Db, "select" | "insert" | "update" | "delete">

export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export function asDbLike(client: DbLike | DbTx): DbLike {
  return client
}

export type Page = { limit: number; offset: number }
export type Paged<T> = { rows: T[]; total: number }
