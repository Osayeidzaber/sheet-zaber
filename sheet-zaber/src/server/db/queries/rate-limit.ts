import "server-only"

import { sql } from "drizzle-orm"

import { db } from "../client"
import { rateLimitBuckets } from "../schema"
import { type DbLike, type DbTx } from "./types"

export type RateBucketResult = {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

/**
 * Every function takes an optional client so a service can run it inside its transaction.
 * `DbLike` is a structural `Pick` of `Db`, so a `DbTx` is already assignable — no cast.
 */
function client(q?: DbLike | DbTx): DbLike {
  return q === undefined ? db : q
}

/**
 * Fixed-window counter in ONE round-trip: the upsert's row lock serialises concurrent
 * consumes, and the CASE decides reset-vs-increment from the window the stored row holds.
 * `windowStart` is read back from the RETURNING row (never from the app clock) so a
 * rollover cannot drift.
 */
export async function consumeRateBucket(
  bucketKey: string,
  windowSeconds: number,
  limit: number,
  q?: DbLike | DbTx
): Promise<RateBucketResult> {
  const elapsed = sql`${rateLimitBuckets.windowStart} <= now() - make_interval(secs => ${windowSeconds}::int)`

  const [row] = await client(q)
    .insert(rateLimitBuckets)
    .values({ bucketKey, count: 1, windowStart: new Date() })
    .onConflictDoUpdate({
      target: rateLimitBuckets.bucketKey,
      set: {
        count: sql`CASE WHEN ${elapsed} THEN 1 ELSE ${rateLimitBuckets.count} + 1 END`,
        windowStart: sql`CASE WHEN ${elapsed} THEN now() ELSE ${rateLimitBuckets.windowStart} END`,
      },
    })
    .returning({ count: rateLimitBuckets.count, windowStart: rateLimitBuckets.windowStart })

  const count = row?.count ?? 1
  const allowed = count <= limit
  // Denied callers still consume a slot, so `count` overshoots `limit` on purpose;
  // `remaining` is what we advertise, and it is never negative.
  const remaining = Math.max(0, limit - count)

  let retryAfterSeconds = 0
  if (!allowed && row) {
    const msLeft = row.windowStart.getTime() + windowSeconds * 1_000 - Date.now()
    retryAfterSeconds = Math.min(windowSeconds, Math.max(1, Math.ceil(msLeft / 1_000)))
  }

  return { allowed, remaining, retryAfterSeconds }
}
