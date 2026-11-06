import "server-only"

import { sha256 } from "@/lib/crypto"
import { findApiConfigurationById } from "@/server/db/queries/api-configurations"
import { findEngineUserQuota } from "@/server/db/queries/engine-support"
import { consumeRateBucket } from "@/server/db/queries/rate-limit"

/*
 * Engine rate limiting (`backend-api-contract.md` §1.4; `security.md` §4 "Rate limiting").
 *
 * Four fixed windows per authenticated AND authorized call — the API owner's USER day window, then
 * (API, key) hour, key day and client IP hour — all counted in `rate_limit_buckets`, because a
 * serverless instance cannot remember anything between requests.
 *
 * Every bucket id is `sha256(...).slice(0, 32)`, exactly like `src/server/invitations/service.ts`
 * builds its keys: a key id, an api id, a user id and an IP are all identifying material, and
 * `rate_limit_buckets.bucket_key` is readable by every surface that can read the table, so it
 * never holds a raw one. `database-schema.md`'s `{scope}:{id}:{window}` example shows a raw
 * `keyId`; the hashing rule in `security.md` §4 is the one this file follows.
 *
 * Placement is the contract: `handleEngineCall` calls this AFTER a key has authenticated AND
 * authorized, so a 401 or a 403 consumes nothing. A denied call still increments the window it
 * tripped (`consumeRateBucket` counts denied callers on purpose); it does not touch the other
 * windows, so an hour-throttled caller cannot burn its day quota while locked out.
 */

export const HOUR_WINDOW_SECONDS = 3600
export const DAY_WINDOW_SECONDS = 86_400
/** §1.4 platform defaults; `api_configurations.rate_limit_per_hour` overrides the hour only. */
export const DEFAULT_HOUR_LIMIT = 1000
export const DEFAULT_DAY_LIMIT = 10_000
/**
 * DEVIATION (§1.4 names only per-key windows): the brief requires an IP-level dimension, so one IP
 * gets the platform hour allowance across ALL keys it presents. A caller behind shared NAT with
 * more than this many requests per hour is the documented trade-off.
 */
export const DEFAULT_IP_HOUR_LIMIT = 1000
/**
 * DEVIATION (§1.4 names no per-user window): the platform owner allocates each normal user a daily
 * allowance ("500 api limit, normally, until i allocate them limitation more or less"), stored in
 * `users.api_limit_per_day` and counted over ALL of that user's APIs and keys combined. `0` in the
 * column means unlimited, and a `role = 'owner'` user is unlimited whatever the column holds —
 * `engineUserDayLimit` below is the only place either rule is decided.
 */
export const DEFAULT_USER_DAY_LIMIT = 500

/** The hashing primitive, kept in one place so the four dimensions cannot drift apart. */
function bucketId(raw: string): string {
  return sha256(raw).slice(0, 32)
}

/** `engine:key:<hash(api|key)>:h3600` — the per-API, per-key hour window. */
export function engineHourBucketKey(apiId: string, keyId: string): string {
  return `engine:key:${bucketId(`${apiId}|${keyId}`)}:h${HOUR_WINDOW_SECONDS}`
}

/** `engine:key:<hash(key)>:d86400` — the key's day window, shared across every API it can call. */
export function engineDayBucketKey(keyId: string): string {
  return `engine:key:${bucketId(keyId)}:d${DAY_WINDOW_SECONDS}`
}

/** `engine:user:<hash(userId)>:d86400` — the API OWNER's day window, across every API and key they own. */
export function engineUserDayBucketKey(userId: string): string {
  return `engine:user:${bucketId(userId)}:d${DAY_WINDOW_SECONDS}`
}

/** `engine:ip:<hash(ip)>:h3600` — the client dimension; the raw IP never reaches the table. */
export function engineIpBucketKey(ip: string): string {
  return `engine:ip:${bucketId(ip)}:h${HOUR_WINDOW_SECONDS}`
}

/** Which window an answer describes: the tripped one when denied, the binding one when allowed. */
export type RateDimension = "user_day" | "api_hour" | "key_day" | "ip_hour" | "unlimited"

export type RateVerdict = {
  allowed: boolean
  /** The binding window's numbers — what `X-RateLimit-*` advertises. */
  limit: number
  remaining: number
  /** Seconds until the denied window resets; `0` when allowed. */
  retryAfterSeconds: number
  /** The window those numbers belong to, so a denial can name itself (see `handle.ts`). */
  dimension: RateDimension
}

/**
 * `api_configurations.rate_limit_per_hour`, falling back to the platform default (§1.4).
 *
 * `EngineApi` deliberately does not carry the column (`apis/service.ts` keeps dashboard-only fields
 * out of the engine's payload), so the override is read here — one primary-key lookup, on the
 * rate-limit path only, after the key authorized. A row we cannot read (deleted API, database
 * trouble) degrades to the default rather than refusing service.
 */
export async function engineHourLimit(apiId: string): Promise<number> {
  try {
    const row = await findApiConfigurationById(apiId)
    const configured = row?.rateLimitPerHour
    return typeof configured === "number" && configured > 0 ? configured : DEFAULT_HOUR_LIMIT
  } catch {
    return DEFAULT_HOUR_LIMIT
  }
}

/**
 * `users.api_limit_per_day` of the user who owns the API being called, or `null` for "unlimited".
 *
 * Two ways to be unlimited, and BOTH are decided HERE — in the engine, never in a route or a UI
 * component — so the rule holds for every caller of `handleEngineCall`:
 *   1. `role = 'owner'`: the platform owner is structurally unlimited whatever the column holds;
 *   2. `api_limit_per_day = 0`: the owner's explicit "no quota" allocation for a normal user.
 *
 * An unlimited caller writes NO `engine:user:` bucket row at all: the bypass is the absence of the
 * dimension, not a very large number, so it cannot be exhausted by a busy day.
 *
 * A read that FAILS is not an allocation: it propagates and the call answers 500. Falling back to
 * 500/day here would silently override a lower limit the owner set. A row that is simply absent (the
 * owner deleted mid-request) has no allocation to override, so it takes the platform default.
 */
export async function engineUserDayLimit(userId: string): Promise<number | null> {
  const row = await findEngineUserQuota(userId)
  if (row === undefined) return DEFAULT_USER_DAY_LIMIT
  if (row.role === "owner" || row.apiLimitPerDay === 0) return null
  return row.apiLimitPerDay
}

/** One consumed window, in the single shape the binding pick compares. */
type AppliedWindow = { dimension: RateDimension; limit: number; remaining: number }

/** Consume every dimension, in order, and answer with the binding one. */
export async function consumeEngineRate(input: {
  apiId: string
  keyId: string
  /** The API's owner (`api_configurations.user_id`): the identity the daily quota counts against. */
  userId: string
  ip: string | null
  hourLimit: number
  dayLimit?: number
  ipLimit?: number
  /** Overrides the `users` read (tests, and any caller that already decided); `null` = unlimited. */
  userDayLimit?: number | null
}): Promise<RateVerdict> {
  // The platform owner is limited by NOTHING: no user, key or IP window is consumed at all.
  if (input.userDayLimit === undefined && (await findEngineUserQuota(input.userId))?.role === "owner") {
    return { allowed: true, limit: 0, remaining: 0, retryAfterSeconds: 0, dimension: "unlimited" }
  }

  const dayLimit = input.dayLimit ?? DEFAULT_DAY_LIMIT
  const userLimit =
    input.userDayLimit === undefined ? await engineUserDayLimit(input.userId) : input.userDayLimit

  // The user window FIRST: an over-quota caller must not burn its per-key and per-IP windows while it
  // is already locked out, and an unlimited caller consumes nothing here.
  const applied: AppliedWindow[] = []
  if (userLimit !== null) {
    const userDay = await consumeRateBucket(
      engineUserDayBucketKey(input.userId),
      DAY_WINDOW_SECONDS,
      userLimit
    )
    if (!userDay.allowed) {
      return {
        allowed: false,
        limit: userLimit,
        remaining: userDay.remaining,
        retryAfterSeconds: userDay.retryAfterSeconds,
        dimension: "user_day",
      }
    }
    applied.push({ dimension: "user_day", limit: userLimit, remaining: userDay.remaining })
  }

  const hour = await consumeRateBucket(
    engineHourBucketKey(input.apiId, input.keyId),
    HOUR_WINDOW_SECONDS,
    input.hourLimit
  )
  if (!hour.allowed) {
    return { allowed: false, limit: input.hourLimit, remaining: hour.remaining, retryAfterSeconds: hour.retryAfterSeconds, dimension: "api_hour" }
  }
  applied.push({ dimension: "api_hour", limit: input.hourLimit, remaining: hour.remaining })

  const day = await consumeRateBucket(engineDayBucketKey(input.keyId), DAY_WINDOW_SECONDS, dayLimit)
  if (!day.allowed) {
    return { allowed: false, limit: dayLimit, remaining: day.remaining, retryAfterSeconds: day.retryAfterSeconds, dimension: "key_day" }
  }
  applied.push({ dimension: "key_day", limit: dayLimit, remaining: day.remaining })

  // An unknown client cannot be bucketed; an anonymous call is limited by its key alone.
  if (input.ip !== null && input.ip.trim() !== "") {
    const ipLimit = input.ipLimit ?? DEFAULT_IP_HOUR_LIMIT
    const ip = await consumeRateBucket(engineIpBucketKey(input.ip), HOUR_WINDOW_SECONDS, ipLimit)
    if (!ip.allowed) {
      return { allowed: false, limit: ipLimit, remaining: ip.remaining, retryAfterSeconds: ip.retryAfterSeconds, dimension: "ip_hour" }
    }
    applied.push({ dimension: "ip_hour", limit: ipLimit, remaining: ip.remaining })
  }

  // All windows are open: advertise the BINDING one — the lowest remaining of the dimensions that
  // actually applied — which is the pair §1.4 puts on `X-RateLimit-*`.
  const binding = applied.reduce((lowest, window) => (window.remaining < lowest.remaining ? window : lowest))
  return { allowed: true, limit: binding.limit, remaining: binding.remaining, retryAfterSeconds: 0, dimension: binding.dimension }
}

/**
 * `Retry-After` only rides a denial (§1.4); the remaining/limit pair rides every response that
 * consumed a bucket, which is every response past authentication and authorization.
 */
export function rateLimitHeaders(verdict: RateVerdict): Record<string, string> {
  // No window applied, so there is no limit to advertise.
  if (verdict.dimension === "unlimited") return {}
  const headers = {
    "X-RateLimit-Limit": String(verdict.limit),
    "X-RateLimit-Remaining": String(verdict.remaining),
  }
  return verdict.allowed ? headers : { ...headers, "Retry-After": String(verdict.retryAfterSeconds) }
}
