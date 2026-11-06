"use client"

/*
 * The invitation table with its one real verb. A client island because Revoke needs pending state, a
 * typed confirmation, and feedback that only claims what `revokeInvitation` returned.
 *
 * Rows arrive as formatted strings from `./page.tsx`, which read them from
 * `listInvitationsForOwner()` — the same function `GET /api/internal/admin/invitations` binds. That
 * payload is `InvitationListItem`: id, label, maxUses, uses, expiresAt, revokedAt, createdBy,
 * createdAt. There is no code, no `code_hash`, no `status` column and no `redemptions` array in it,
 * so there is none here either: `status` is derived from the four columns the route does return
 * (`./invitation-status.ts`) and the use counter is presented as a counter, never as a list of people.
 *
 * Revoke is the one irreversible thing on this screen — `revokeInvitation` sets `revoked_at` where it
 * is NULL and no service un-sets it — so it is gated by `ConfirmDialog`'s `requireText`, which keeps
 * the button dead until the owner types the invitation's own name.
 */

import { useState, useTransition } from "react"

import { isActionError } from "@/lib/action-result"
import type { StatusTone } from "@/components/ui/badge"
import { StatusDot } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/dialog"
import { MonoCell, Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import { revokeInvitationAction } from "../actions"

export type InvitationRowView = {
  id: string
  /** The owner's memo, or the words that say there was none. */
  name: string
  /** `invitations.id`, shortened. Never a code, never a hash — the route cannot give either. */
  rowId: string
  statusLabel: string
  statusTone: StatusTone
  /** The sentence under the dot, so no state is carried by colour or by a single word alone. */
  statusReading: string
  uses: string
  /** Emails from `invitation_redemptions`. */
  redeemedBy: string[]
  expires: string
  created: string
  issuedBy: string
  revoked: boolean
  /** What `ConfirmDialog` demands be typed: the label if there is one, else the fixed word. */
  confirmText: string
}

export function InvitationTable({ rows }: { rows: InvitationRowView[] }) {
  const [isPending, startTransition] = useTransition()
  const [target, setTarget] = useState<InvitationRowView | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ message: string; code: string } | null>(null)

  function revoke(row: InvitationRowView) {
    startTransition(async () => {
      const result = await revokeInvitationAction(row.id)
      setTarget(null)

      if (isActionError(result)) {
        setFeedback(null)
        setFailure({ message: result.error.message, code: result.error.code })
        return
      }

      // `ok` here means `revoked_at` is set (first revoke) or already was (idempotent replay). The
      // return carries the id only, so the sentence cannot say more than that.
      setFailure(null)
      setFeedback(
        row.revoked
          ? `${row.name} was already revoked — the original timestamp was kept and a revoke audit row was written.`
          : `${row.name} is revoked. Its code stops redeeming on the next attempt; this row keeps its use count.`
      )
    })
  }

  return (
    <>
      <div aria-live="polite" className="px-5 pt-4 empty:hidden">
        {feedback ? <p className="font-mono text-[12px] text-dust">{feedback}</p> : null}
        {failure ? (
          <p role="alert" className="text-[13px] leading-[1.6] text-paper">
            ⚠ {failure.message}{" "}
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
              {failure.code}
            </span>
          </p>
        ) : null}
      </div>

      <TableScroll label="Issued invitation codes" className="mt-2">
        <Table>
          <thead>
            <tr>
              <Th>Invitation</Th>
              <Th>Status</Th>
              <Th align="right">Uses</Th>
              <Th>Redeemed by</Th>
              <Th>Expires</Th>
              <Th>Issued</Th>
              <Th>Issued by</Th>
              <Th align="right">Action</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Tr key={row.id} interactive>
                <Td>
                  <span className="block max-w-[240px] truncate text-paper">{row.name}</span>
                  <MonoCell value={row.rowId} title={`invitations.id ${row.id}`} />
                </Td>
                <Td>
                  <StatusDot
                    tone={row.statusTone}
                    label={row.statusLabel}
                    className="whitespace-nowrap"
                  />
                  <span className="mt-1 block max-w-[26ch] text-[12px] leading-[1.5] text-dust">
                    {row.statusReading}
                  </span>
                </Td>
                <Td numeric>{row.uses}</Td>
                <Td>
                  {row.redeemedBy.length === 0 ? (
                    <span className="text-dust">—</span>
                  ) : (
                    row.redeemedBy.map((email) => (
                      <span key={email} className="block max-w-[240px] truncate" title={email}>
                        {email}
                      </span>
                    ))
                  )}
                </Td>
                <Td className="whitespace-nowrap text-dust">{row.expires}</Td>
                <Td className="whitespace-nowrap text-dust">{row.created}</Td>
                <Td>
                  <MonoCell value={row.issuedBy} title="invitations.created_by — owner account row id, shortened" />
                </Td>
                <Td align="right">
                  {row.revoked ? (
                    <span className="font-mono text-[11px] text-dust">no un-revoke</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={isPending}
                      aria-label={`Revoke ${row.name}`}
                      onClick={() => {
                        setFeedback(null)
                        setFailure(null)
                        setTarget(row)
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>

      {target ? (
        <ConfirmDialog
          open
          title={`Revoke ${target.name}?`}
          confirmLabel="Revoke invitation"
          requireText={target.confirmText}
          busy={isPending}
          error={failure ? `${failure.message} (${failure.code})` : undefined}
          onClose={() => setTarget(null)}
          onConfirm={() => revoke(target)}
          body={
            <div className="flex flex-col gap-3 text-[15px] leading-[1.6]">
              <p>
                Every attempt to redeem this code is refused from now on, whoever holds it. The
                row itself survives with its use count intact, and the people it already admitted keep
                their accounts — revoking an invitation is not a way to remove a user.
              </p>
              <p className="text-[13px] text-dust">
                This cannot be undone: there is no un-revoke verb, and the code’s value was never
                stored, so it cannot be shown again either. Audited as{" "}
                <span className="font-mono text-[13px]">invitation.revoke</span>.
              </p>
            </div>
          }
        />
      ) : null}
    </>
  )
}
