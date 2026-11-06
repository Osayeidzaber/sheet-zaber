import "server-only"

import { writeAudit } from "@/server/db/queries/audit"
import type { DbLike, DbTx } from "@/server/db/queries/types"

/*
 * The single audit entry point every mutating service uses (`security.md` §2 "audit logging",
 * `authentication-flow.md` §3). Two jobs, nothing else:
 *
 * 1. transaction awareness — `q` is the caller's open `DbTx`, so the audit row commits or
 *    rolls back with the change it describes;
 * 2. secret scrubbing — `audit_logs.detail` is readable by the owner UI and outlives every
 *    request, so a code, hash, token or third-party email must never reach it, even by an
 *    accidental `detail: { code }` at a call site. Keys whose NAME implies a secret are
 *    dropped; values whose SHAPE implies one (an invitation code, a 32+ hex digest, a long
 *    base64 blob = ciphertext) are replaced with a marker so the attempt still leaves evidence.
 */

export type AuditAction =
  | "user.disable"
  | "user.enable"
  | "user.promote"
  | "user.demote"
  | "user.delete"
  | "user.limit"
  | "invitation.create"
  | "invitation.revoke"
  | "invitation.redeem"
  | "api_key.revoke_admin"
  | "settings.update"
  | "owner.bootstrap"

export type AuditInput = {
  actorId: string | null
  action: AuditAction
  subjectType?: string
  subjectId?: string
  detail?: Record<string, unknown>
}

const REDACTED = "[redacted]"

/** Key NAMES that are always secret material here, matched case- and separator-insensitively. */
const SECRET_KEY_RE =
  /(code|hash|token|secret|password|passwd|credential|authorization|cookie|session|email|apikey|api_?key|refresh|bearer)/i

/** Value SHAPES of secret material: `ZABER-…`, a ≥32-char hex digest, a long base64 payload. */
const SECRET_VALUE_RES: readonly RegExp[] = [
  /^ZABER-[0-9A-Z]-[0-9A-Z]{4}-[0-9A-Z]{4}$/i,
  /^ZABER-[0-9A-Z]{4}-[0-9A-Z]{4}$/i,
  /^[0-9a-f]{32,}$/i,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
]

function looksSecret(value: unknown): boolean {
  return typeof value === "string" && SECRET_VALUE_RES.some((pattern) => pattern.test(value))
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (looksSecret(item) ? REDACTED : scrub(item)))
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key)) continue
      out[key] = looksSecret(entry) ? REDACTED : scrub(entry)
    }
    return out
  }
  return value
}

/**
 * Append one audit row. Pass the transaction handle when the write belongs to a larger unit
 * of work; omit it for a standalone one. Never throws for secret-shaped input — it redacts.
 */
export async function recordAudit(input: AuditInput, q?: DbLike | DbTx): Promise<void> {
  const detail = scrub(input.detail ?? {}) as Record<string, unknown>
  await writeAudit(
    {
      actorId: input.actorId,
      action: input.action,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      detail,
    },
    q
  )
}
