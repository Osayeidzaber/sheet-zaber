/*
 * The numbers this page labels as "elevated" or "at cap" are declared here once, so a caption can
 * point at the rule instead of implying it. They are presentation thresholds chosen by this page —
 * not platform limits — except the two reference limits, which mirror DEFAULT_HOUR_LIMIT and
 * DEFAULT_DAY_LIMIT in `src/server/engine/ratelimit.ts`. Rolling log totals are comparisons,
 * not readings of that engine's fixed-window counters or per-user/IP allowances.
 */

/** Engine default: 1000 requests/hour per endpoint and key, fixed window. */
export const DEFAULT_REQUESTS_PER_HOUR = 1000
/** `backend-api-contract.md` §1.4: 10000 requests/day per key, fixed window. */
export const DEFAULT_REQUESTS_PER_DAY = 10000

/** An error rate at or above this is called elevated — and only when there is enough traffic to judge. */
export const ELEVATED_ERROR_RATE_PERCENT = 25
/** Below this many requests a percentage is noise, so nothing is labelled from it. */
export const MIN_ERROR_RATE_SAMPLE = 20

/** `failed / requests` as a percentage, or `null` when there is nothing to divide. */
export function errorRatePercent(requests: number, failed: number): number | null {
  if (!Number.isFinite(requests) || requests <= 0) return null
  return (failed / requests) * 100
}

/** True only when the sample is big enough AND the rate reaches the threshold. */
export function isElevatedErrorRate(requests: number, failed: number): boolean {
  const rate = errorRatePercent(requests, failed)
  return rate !== null && requests >= MIN_ERROR_RATE_SAMPLE && rate >= ELEVATED_ERROR_RATE_PERCENT
}
