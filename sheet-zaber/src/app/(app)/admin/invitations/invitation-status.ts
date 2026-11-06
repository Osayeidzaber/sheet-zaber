import type { StatusTone } from "@/components/ui/badge"

/*
 * `InvitationRow.status` (`docs/backend-api-contract.md` §4.5) is NOT a column, and
 * `GET /api/internal/admin/invitations` does not return it — the route serializes
 * `InvitationListItem`, the eight real `invitations` columns with `code_hash` projected out
 * (`src/server/invitations/service.ts:147`, `src/server/db/queries/invitations.ts:86-100`). §4.10 says
 * the UI may derive `status` from columns it already receives, so this file does exactly that and
 * nothing more.
 *
 * The order is the redemption guard's own order, read from the SQL that decides whether a code still
 * works (`src/server/db/queries/invitations.ts:49-63`):
 *
 *   WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND uses < max_uses
 *
 * A row can satisfy more than one dead state — revoked AND expired — and the guard names the first
 * term that stops it, so the label agrees with the database rather than with a preference.
 *
 * `redemptions` is deliberately NOT derived here: it needs the `invitation_redemptions` → `users.email`
 * join (§4.10: "ships with the admin invitations route, not before"), the route does not perform it,
 * and a `uses` counter is not a list of who redeemed. The UI therefore shows `uses / maxUses` and says
 * that is all the route gives it — no invented redemption table.
 */

export type DerivedInvitationStatus = "active" | "exhausted" | "expired" | "revoked"

export type InvitationStatusSource = {
  revokedAt: Date | null
  expiresAt: Date | null
  uses: number
  maxUses: number
}

export function deriveInvitationStatus(
  row: InvitationStatusSource,
  now: Date = new Date()
): DerivedInvitationStatus {
  if (row.revokedAt !== null) return "revoked"
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return "expired"
  if (row.uses >= row.maxUses) return "exhausted"
  return "active"
}

/**
 * Dot tone plus the word that always travels with it. Hue is limited to one meaning here: a code the
 * OWNER stopped (`revoked` → danger) is different from a code that ran out or ran down.
 */
export const STATUS_COPY: Record<
  DerivedInvitationStatus,
  { label: string; tone: StatusTone; reading: string }
> = {
  active: { label: "Open", tone: "active", reading: "redeemable while it has uses left" },
  exhausted: {
    label: "Used up",
    tone: "idle",
    reading: "reached its use limit; the code still exists but no longer redeems",
  },
  expired: {
    label: "Expired",
    tone: "idle",
    reading: "past its expiry date; it would be refused even with uses left",
  },
  revoked: {
    label: "Revoked",
    tone: "failed",
    reading: "stopped by an owner; this cannot be undone from the console",
  },
}
