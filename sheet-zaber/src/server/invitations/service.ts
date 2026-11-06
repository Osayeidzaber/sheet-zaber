import "server-only"

import { eq } from "drizzle-orm"
import { users as usersTable } from "@/server/db/schema"

import { z } from "zod"

import { fail, internalError, ok, isActionError, type ActionError, type ActionResult, type ErrorCategory } from "@/lib/action-result"
import { aesGcmEncrypt, generateInvitationCode, sha256 } from "@/lib/crypto"
import { env } from "@/lib/env"
import { createInvitationsSchema, invitationCodeSchema, inviteUsersSchema } from "@/lib/schemas"
import { readOwner } from "@/server/auth/guards"
import type { PendingIdentity } from "@/server/auth/pending"
import type { SessionRole } from "@/server/auth/session"
import { can, type Action } from "@/server/auth/rbac"
import { recordAudit, type AuditInput } from "@/server/admin/audit"
import { db } from "@/server/db/client"
import { consumeRateBucket } from "@/server/db/queries/rate-limit"
import {
  buildInvitationEmail,
  emailSendConfigError,
  readEmailSendConfig,
  sendEmail,
  type EmailMessage,
} from "@/server/email"
import {
  insertInvitations,
  listInvitations as listInvitationRows,
  listRedemptions,
  recordRedemption as insertRedemption,
  redeemInvitation as redeemInvitationRow,
  revokeInvitation as revokeInvitationRow,
  type InvitationListItem,
  type InvitationRow as InvitationDbRow,
} from "@/server/db/queries/invitations"
import {
  createUser as insertUser,
  findUserById as findUserRow,
  upsertUserProfile as upsertProfileRow,
  type UserRow,
} from "@/server/db/queries/users"
import { upsertConnection as upsertConnectionRow } from "@/server/db/queries/google-connections"
import type { DbTx } from "@/server/db/queries/types"

/*
 * Invitation service (`backend-api-contract.md` §4.5, `authentication-flow.md` §4).
 *
 * Two rules shape everything below:
 *
 * 1. ONE transaction owns a redemption. The atomic conditional UPDATE, the five dependent
 *    INSERTs and the audit row either all commit or none do — so a crash can never leave a
 *    spent `uses` counter with no user, or a user with no redemption (`security.md` §3 item 6).
 *    Callers pass no transaction handle: the service opens it.
 * 2. The refusal envelope is byte-identical for unknown / expired / revoked / exhausted codes
 *    (`invalid_invitation`), because a differing message or status would turn this route into
 *    an oracle over invitation state. Nothing below logs WHICH of the four fired.
 */

/** The single refusal shape for every invalid code, and the only invitation message. */
export const INVALID_INVITATION_MESSAGE = "invitation code is not valid"

export function invalidInvitationError(): ActionError {
  return fail("invalid_invitation", INVALID_INVITATION_MESSAGE, "auth")
}

const PENDING_EXPIRED_ERROR = () =>
  fail("pending_expired", "That sign-in is no longer active. Connect with Google again.", "auth")

const ALREADY_REGISTERED_ERROR = () =>
  fail("already_registered", "This Google account already has a Sheet Zaber account.", "auth")

const FORBIDDEN_ERROR = () => fail("forbidden", "You are not allowed to do that.", "auth")

/*
 * Brute-force protection lives HERE, not in the route (`backend-api-contract.md` §2). A server
 * action over this service is as reachable as `POST /auth/invitation`, so a throttle placed in
 * one adapter would leave the other unthrottled. `retry_after` travels in `fields` because the
 * error envelope is the only vehicle a caller can read.
 */
export const ATTEMPT_WINDOW_SECONDS = 900
export const ATTEMPT_LIMIT = 5

/**
 * Both dimensions are consumed per attempt; either one being full denies. `ip: null` drops the
 * IP dimension — honest for a caller that truly cannot see the client address, never for a route
 * or a server action, which both can.
 */
export function attemptBucketKeys(ip: string | null, sub: string | null): string[] {
  const keys: string[] = []
  if (ip !== null) keys.push(`invite:ip:${sha256(ip).slice(0, 32)}:m15`)
  if (sub !== null) keys.push(`invite:sub:${sha256(sub).slice(0, 32)}:m15`)
  return keys
}

function rateLimitedError(retryAfterSeconds: number): ActionError {
  return fail("rate_limited", "Too many attempts. Try again later.", "rate_limit", {
    retry_after: String(retryAfterSeconds),
  })
}

export type { InvitationListItem }

export type RedeemResult = { userId: string; email: string; role: SessionRole }

/**
 * `ip` is required, not optional sugar: it is the second throttle dimension (§2), and a caller
 * that cannot see it (a route or a server action never genuinely cannot) must say so explicitly
 * with `null` rather than leave it out and be silently unthrottled per IP.
 */
export type RedeemInput = {
  plaintextCode: string
  pending: PendingIdentity | null
  ip: string | null
  /** Chosen on the invitation form; validated and stored lowercase. */
  username?: string | null
}

export type CreateInvitationsPayload = {
  /** the plaintext codes, returned exactly once and never stored (`security.md` §2) */
  codes: string[]
  /** `backend-api-contract.md` §4.5 alias of `codes` */
  plaintext: string[]
  /** the created rows, hash-stripped — see `toListItem` */
  invitations: InvitationListItem[]
}

export type ServiceOptions = { req?: Request; deps?: Partial<RedeemDeps> }

const invitationIdSchema = z.uuid()

/** Failure-injection seam: the redemption test arms a late step to throw (plan A Task 6 Step 1d). */
export type RedeemDeps = {
  transaction: <T>(fn: (tx: DbTx) => Promise<T>) => Promise<T>
  redeemRow: typeof redeemInvitationRow
  createUser: typeof insertUser
  upsertUserProfile: typeof upsertProfileRow
  upsertConnection: typeof upsertConnectionRow
  recordRedemption: typeof insertRedemption
  recordAudit: (input: AuditInput, q?: DbTx) => Promise<void>
}

const productionDeps: RedeemDeps = {
  transaction: (fn) => db.transaction(fn),
  redeemRow: redeemInvitationRow,
  createUser: insertUser,
  upsertUserProfile: upsertProfileRow,
  upsertConnection: upsertConnectionRow,
  recordRedemption: insertRedemption,
  recordAudit,
}

/** Thrown from inside the transaction so the rollback is the mechanism, not a manual undo. */
class AlreadyRegisteredError extends Error {
  constructor() {
    super("already_registered")
  }
}

/** Explicit projection: a `codeHash` field cannot leak by construction, only by an edit here. */
function toListItem(row: InvitationDbRow): InvitationListItem {
  return {
    id: row.id,
    label: row.label,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "value"
    if (!(key in fields)) fields[key] = issue.message
  }
  return fields
}

/** Walks `cause` so a wrapped driver error is still classified (23505 = unique_violation). */
function isUserUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (candidate.code === "23505" && typeof candidate.constraint === "string" && candidate.constraint.startsWith("users_")) {
      return true
    }
    current = candidate.cause
  }
  return false
}

/**
 * The acting owner: `readOwner(req)` when a request is present (the actor must be the person
 * making THIS request), otherwise the DB row behind `actorId` (scripts, tests). Either way the
 * role is read from the database and decided by `can()` — never from a cookie payload.
 */
async function activeActor(
  actorId: string,
  req?: Request
): Promise<{ id: string; role: SessionRole; canInvite?: boolean } | null> {
  if (req) {
    const owner = await readOwner(req)
    return owner && owner.id === actorId ? { id: owner.id, role: owner.role } : null
  }
  const row = await findUserRow(actorId)
  if (!row || row.status !== "active") return null
  return { id: row.id, role: row.role === "owner" ? "owner" : "user", canInvite: row.canInvite === true }
}

function allowed(actor: { role: SessionRole } | null, action: Action): boolean {
  return actor !== null && can(actor.role, action)
}

export async function createInvitations(
  input: { count: number; label?: string | null; maxUses?: number; expiresAt?: Date | null },
  actorId: string,
  opts?: ServiceOptions
): Promise<ActionResult<CreateInvitationsPayload>> {
  // `null` means "absent" for the caller; the zod schema treats optional as `undefined`.
  const parsed = createInvitationsSchema.safeParse({
    count: input.count,
    ...(input.label != null ? { label: input.label } : {}),
    ...(input.maxUses != null ? { maxUses: input.maxUses } : {}),
    ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
  })
  if (!parsed.success) {
    return fail("validation_failed", "Invitation request is not valid.", "validation", zodFields(parsed.error))
  }
  const { count, label, maxUses, expiresAt } = parsed.data

  try {
    const actor = await activeActor(actorId, opts?.req)
    if (!allowed(actor, "invitation.create") && actor?.canInvite !== true) {
      // A refused owner-only attempt is evidence, not silence (`authentication-flow.md` §3).
      await recordAudit({
        actorId: actor?.id ?? null,
        action: "invitation.create",
        subjectType: "invitation",
        detail: { outcome: "denied" },
      })
      return FORBIDDEN_ERROR()
    }

    const generated = Array.from({ length: count }, () => generateInvitationCode())
    const rows = await productionDeps.transaction(async (tx) => {
      const created = await insertInvitations(
        generated.map((code) => ({
          codeHash: code.hash,
          label: label ?? null,
          maxUses,
          expiresAt: expiresAt ?? null,
          createdBy: actorId,
        })),
        tx
      )
      await recordAudit(
        {
          actorId,
          action: "invitation.create",
          subjectType: "invitation",
          // The label is the owner's free-text memo (it can hold an email): presence only.
          detail: {
            count: created.length,
            maxUses,
            hasLabel: label != null,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
          },
        },
        tx
      )
      return created
    })

    const codes = generated.map((code) => code.plaintext)
    return ok({ codes, plaintext: codes, invitations: rows.map(toListItem) })
  } catch {
    return internalError()
  }
}

/*
 * Invite-by-email (owner requirement: "invite users to my website"). One rule orders everything:
 * MINT AND AUDIT COMMIT FIRST, THEN SEND. A send failure is data (`accepted: false` + reason),
 * never an exception and never a rollback — the code is minted and audited regardless of what the
 * email provider does afterwards. The reverse ordering would let Resend downtime mint nothing.
 */

/**
 * Per-address outcome. `accepted` means the provider took the message, NOT that it reached an inbox.
 * `reason` is a fixed string by category: provider text and codes never ride it. Only a hash is
 * stored, so a failed send cannot be resent: revoke `invitationId` and invite the address again.
 */
export type InviteEmailDelivery = { email: string; invitationId: string; accepted: boolean; reason?: string }

export type InviteUsersPayload = {
  invitations: InvitationListItem[]
  deliveries: InviteEmailDelivery[]
}

export type InviteUsersCallOptions = { label?: unknown; maxUses?: unknown; expiresAt?: unknown }

/** Seam in the `RedeemDeps` style: tests inject a recording sender, production reads `src/server/email`. */
export type InviteUsersDeps = {
  /** Runs BEFORE the mint: with no sender configured, invite-by-email mints nothing and fails typed. */
  checkEmailConfig: () => ActionError | null
  sendEmail: (message: EmailMessage) => Promise<ActionResult<{ id: string }>>
}

export type InviteUsersOptions = { req?: Request; deps?: Partial<InviteUsersDeps> }

const productionInviteDeps: InviteUsersDeps = {
  checkEmailConfig: () => emailSendConfigError(readEmailSendConfig()),
  sendEmail,
}

const DELIVERY_REASONS: Record<ErrorCategory, string> = {
  validation: "rejected by the email provider (check the address and the sender domain)",
  rate_limit: "email provider rate limited this send; retry shortly",
  internal: "email provider unavailable or not configured",
  auth: "email provider refused the send",
  not_found: "email provider refused the send",
  google: "email provider refused the send",
}

export async function inviteUsers(
  emails: unknown,
  options: InviteUsersCallOptions,
  actorId: string,
  opts?: InviteUsersOptions
): Promise<ActionResult<InviteUsersPayload>> {
  const deps: InviteUsersDeps = { ...productionInviteDeps, ...opts?.deps }

  const parsed = inviteUsersSchema.safeParse({
    emails,
    ...(options.label != null ? { label: options.label } : {}),
    ...(options.maxUses != null ? { maxUses: options.maxUses } : {}),
    ...(options.expiresAt != null ? { expiresAt: options.expiresAt } : {}),
  })
  if (!parsed.success) {
    return fail("validation_failed", "Invite request is not valid.", "validation", zodFields(parsed.error))
  }
  const { emails: addresses, label, maxUses, expiresAt } = parsed.data

  const configError = deps.checkEmailConfig()
  if (configError) return configError

  // One call, one transaction, one `invitation.create` audit row — the minting/hashing path is
  // `createInvitations` itself, never a fork of it. `codes[i]`/`invitations[i]` align with
  // `addresses[i]` because the batched INSERT ... VALUES RETURNING keeps VALUES order (§4.5).
  // The plaintext codes stay in this local and in the email bodies; they never enter the payload
  // returned here, any audit `detail`, or any reason string.
  const created = await createInvitations(
    { count: addresses.length, label, maxUses, expiresAt },
    actorId,
    { req: opts?.req }
  )
  if (isActionError(created)) return created
  const { codes, invitations } = created.data

  const deliveries = await Promise.all(
    addresses.map(async (email, index): Promise<InviteEmailDelivery> => {
      const message = buildInvitationEmail({ to: email, code: codes[index], expiresAt: expiresAt ?? null, maxUses })
      const invitationId = invitations[index].id
      try {
        const sent = await deps.sendEmail(message)
        if (isActionError(sent)) return { email, invitationId, accepted: false, reason: DELIVERY_REASONS[sent.error.category] }
        return { email, invitationId, accepted: true }
      } catch {
        // A throwing sender is still just a failed delivery; this call never rejects.
        return { email, invitationId, accepted: false, reason: DELIVERY_REASONS.internal }
      }
    })
  )

  return ok({ invitations, deliveries })
}

export async function redeemInvitation(
  input: RedeemInput,
  opts?: ServiceOptions
): Promise<ActionResult<RedeemResult>> {
  const deps: RedeemDeps = { ...productionDeps, ...opts?.deps }
  const pending = input.pending

  if (!pending || pending.exp <= Math.floor(Date.now() / 1000)) return PENDING_EXPIRED_ERROR()

  // Counted before the code is even hashed, so a spray of malformed codes burns the bucket too.
  let retryAfterSeconds = 0
  try {
    for (const key of attemptBucketKeys(input.ip, pending.sub)) {
      const bucket = await consumeRateBucket(key, ATTEMPT_WINDOW_SECONDS, ATTEMPT_LIMIT)
      if (!bucket.allowed) retryAfterSeconds = Math.max(retryAfterSeconds, bucket.retryAfterSeconds)
    }
  } catch {
    return internalError()
  }
  if (retryAfterSeconds > 0) return rateLimitedError(retryAfterSeconds)

  // A malformed code is refused with the SAME envelope as an unknown one: the format check must
  // not become a second, sharper oracle, and normalising here is what makes the hash lookup
  // case-insensitive (`invitationCodeSchema`).
  const normalized = invitationCodeSchema.safeParse(input.plaintextCode)
  if (!normalized.success) return invalidInvitationError()
  const codeHash = sha256(normalized.data)

  const username = input.username?.trim().toLowerCase() || null
  if (username !== null && !/^[a-z0-9_]{3,30}$/.test(username)) {
    return fail("validation_failed", "That username can't be used.", "validation", {
      username: "Use 3 to 30 letters, numbers or underscores.",
    })
  }

  try {
    const result = await deps.transaction(async (tx) => {
      // Before the redeem, so a taken name does not spend the code.
      if (username !== null) {
        const [taken] = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.username, username))
          .limit(1)
        if (taken) {
          return fail("username_taken", "That username is taken.", "validation", {
            username: "That username is taken. Try another.",
          })
        }
      }

      const invitationId = await deps.redeemRow(codeHash, tx)
      if (invitationId === null) return invalidInvitationError()

      // `OWNER_EMAIL` grants `role='owner'` at INSERT time only (`authentication-flow.md` §4);
      // compared case-insensitively so a differently-cased env value cannot silently drop it.
      const role: SessionRole =
        pending.email.trim().toLowerCase() === env.OWNER_EMAIL.trim().toLowerCase() ? "owner" : "user"

      let created: UserRow
      try {
        created = await deps.createUser(
          { googleSub: pending.sub, email: pending.email, role, invitationId, username },
          tx
        )
      } catch (error) {
        if (isUserUniqueViolation(error)) throw new AlreadyRegisteredError()
        throw error
      }

      await deps.upsertUserProfile(
        { userId: created.id, displayName: username ?? pending.name ?? pending.email, pictureUrl: pending.picture },
        tx
      )
      // `pending.refreshToken` is PLAINTEXT: `verifyPending` decrypts the cookie payload, and the
      // column is ciphertext, so it is encrypted on the way in (backend-api-contract.md §4.5) —
      // never decrypt-and-store, never re-encrypt an already-encrypted value.
      await deps.upsertConnection(
        {
          userId: created.id,
          googleEmail: pending.email,
          refreshTokenEnc: aesGcmEncrypt(pending.refreshToken, env.TOKEN_ENCRYPTION_KEY),
          scope: pending.scope,
        },
        tx
      )
      // Read the role back off the row that was just written; `users.role` is a plain text
      // column, so the cast is the schema's own `users_role_check` constraint talking.
      const grantedRole: SessionRole = created.role === "owner" ? "owner" : "user"

      await deps.recordRedemption({ invitationId, redeemedBy: created.id }, tx)
      await deps.recordAudit(
        {
          actorId: created.id,
          action: "invitation.redeem",
          subjectType: "invitation",
          subjectId: invitationId,
          detail: { role: grantedRole },
        },
        tx
      )

      return ok<RedeemResult>({ userId: created.id, email: created.email, role: grantedRole })
    })

    return result
  } catch (error) {
    if (error instanceof AlreadyRegisteredError) return ALREADY_REGISTERED_ERROR()
    return internalError()
  }
}

/** The `POST /auth/invitation` surface named by `backend-api-contract.md` §4.5. */
export async function submitInvitation(
  input: RedeemInput,
  opts?: ServiceOptions
): Promise<ActionResult<RedeemResult>> {
  return redeemInvitation(input, opts)
}

/** Owner-facing list; the repository's column projection is what keeps `codeHash` out. */
export async function listInvitationsForOwner(): Promise<ActionResult<InvitationListItem[]>> {
  try {
    return ok(await listInvitationRows())
  } catch {
    return internalError()
  }
}

/** §4.5 name for `listInvitationsForOwner`. */
export const listInvitations = listInvitationsForOwner

/** §4.5 — derived from `revokedAt` / `expiresAt` / `uses` vs `maxUses`; never a column. */
export type InvitationStatus = "active" | "exhausted" | "expired" | "revoked"

/**
 * §4.5's admin-page payload: `InvitationListItem` plus the two derived members. The name says
 * "admin" because the repository's raw `invitations.$inferSelect` is also called `InvitationRow` —
 * one name per shape, so a frontend import can never grab the wrong layer.
 */
export type AdminInvitationRow = InvitationListItem & {
  status: InvitationStatus
  /** `invitation_redemptions` joined to `users.email` — who redeemed this code, and when. */
  redemptions: { redeemedBy: string; email: string; redeemedAt: Date }[]
}

/** The most specific recorded fact wins: a revoked code is revoked even if it also expired. */
function invitationStatus(row: InvitationListItem, now: Date): InvitationStatus {
  if (row.revokedAt !== null) return "revoked"
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return "expired"
  if (row.uses >= row.maxUses) return "exhausted"
  return "active"
}

/**
 * `GET /api/internal/admin/invitations` (§2 Admin). Two queries, not two-plus-one-per-row: the
 * redemption read is one joined sweep and the grouping happens here.
 *
 * An invitation whose redeemer has since been deleted shows `uses ≥ 1` with no matching
 * `redemptions` entry — the counter is the stored fact, and no email is invented for a gone row.
 */
export async function listInvitationsForAdmin(): Promise<ActionResult<AdminInvitationRow[]>> {
  try {
    const [rows, redemptionRows] = await Promise.all([listInvitationRows(), listRedemptions()])
    const byInvitation = new Map<string, AdminInvitationRow["redemptions"]>()
    for (const redemption of redemptionRows) {
      const entry = {
        redeemedBy: redemption.redeemedBy,
        email: redemption.email,
        redeemedAt: redemption.redeemedAt,
      }
      const bucket = byInvitation.get(redemption.invitationId)
      if (bucket === undefined) byInvitation.set(redemption.invitationId, [entry])
      else bucket.push(entry)
    }

    const now = new Date()
    return ok(
      rows.map((row) => ({
        ...row,
        status: invitationStatus(row, now),
        redemptions: byInvitation.get(row.id) ?? [],
      }))
    )
  } catch {
    return internalError()
  }
}

export async function revokeInvitation(
  id: string,
  actorId: string,
  opts?: ServiceOptions
): Promise<ActionResult<{ id: string }>> {
  const parsedId = invitationIdSchema.safeParse(id)
  if (!parsedId.success) {
    return fail("validation_failed", "Invitation id is not valid.", "validation", { id: "must be a uuid" })
  }

  try {
    const actor = await activeActor(actorId, opts?.req)
    if (!allowed(actor, "invitation.revoke")) {
      await recordAudit({
        actorId: actor?.id ?? null,
        action: "invitation.revoke",
        subjectType: "invitation",
        detail: { outcome: "denied" },
      })
      return FORBIDDEN_ERROR()
    }

    await productionDeps.transaction(async (tx) => {
      // Idempotent: the repository's `revoked_at IS NULL` guard keeps the first timestamp.
      await revokeInvitationRow(parsedId.data, tx)
      await recordAudit(
        { actorId, action: "invitation.revoke", subjectType: "invitation", subjectId: parsedId.data },
        tx
      )
    })
    return ok({ id: parsedId.data })
  } catch {
    return internalError()
  }
}
