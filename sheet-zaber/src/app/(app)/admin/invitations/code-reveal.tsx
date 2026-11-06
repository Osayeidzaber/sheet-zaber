"use client"

/*
 * THE one-time invitation reveal — the owner-console counterpart of `src/app/(app)/keys/key-reveal.tsx`,
 * and the only place a plaintext invitation code is ever rendered.
 *
 * `createInvitations` returns plaintext codes exactly once and stores only SHA-256 hashes
 * (`docs/backend-api-contract.md` §4.5, §2; `src/server/invitations/service.ts:233-264`). Nothing else
 * in this console can produce them: `GET /api/internal/admin/invitations` serializes the hash-stripped
 * `InvitationListItem` projection, so a re-fetch, a refresh, a pagination click or the revalidated
 * table below cannot bring a code back. These strings therefore live in React state for the life of
 * this panel only — not in a URL or query string, not in `localStorage`, not in a log, not in any
 * list. Unmounting is genuinely irreversible: the row survives, the code does not.
 *
 * Every code is a `CopyField` (select-on-focus + a copy button that reports whether the clipboard
 * write actually succeeded), so nothing has to be transcribed by hand.
 */

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyField } from "@/components/ui/copy"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import type { IssuedInvitation } from "../action-types"

function expiresWord(invitation: IssuedInvitation): string {
  return invitation.expiresAt === null ? "never expires" : `expires ${invitation.expiresAt.slice(0, 10)}`
}

export function InvitationCodeReveal({
  codes,
  issued,
  onDismiss,
}: {
  codes: string[]
  issued: IssuedInvitation[]
  onDismiss: () => void
}) {
  const first = issued[0]
  const usesEach = first === undefined ? null : first.maxUses

  return (
    <Panel as="section" className="border-paper">
      <PanelHeader
        title="Copy these codes now — they are shown once"
        description={`${codes.length} ${
          codes.length === 1 ? "code" : "codes"
        } created and hashed to the database in the same transaction. Only the hash is stored, so this screen is the only copy that will ever exist.`}
        action={
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Hide
          </Button>
        }
      />

      <PanelBody className="flex flex-col gap-4">
        <p role="alert" className="text-[13px] leading-[1.7] text-paper">
          ⚠ Navigating away, refreshing, or issuing another batch loses these codes for good. The
          invitation rows below stay — they simply stop being usable, because the values that redeem
          them were never written down anywhere.
        </p>

        <ol className="flex max-h-[420px] min-w-0 flex-col gap-4 overflow-y-auto border-t border-rule pt-4">
          {codes.map((code, index) => {
            const row = issued[index]
            return (
              <li key={index} className="min-w-0">
                <CopyField
                  value={code}
                  label={`Invitation code ${index + 1} of ${codes.length}`}
                  revealOnce
                />
                {row ? (
                  <p className="mt-1 font-mono text-[11px] leading-[1.6] text-dust">
                    {row.label ?? "unlabeled"} · {row.uses} of {row.maxUses} uses ·{" "}
                    {expiresWord(row)} · id {row.id.slice(0, 8)}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ol>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="inverted">Stored as a SHA-256 hash</Badge>
          <Badge variant="outline">Never stored in plaintext</Badge>
          <Badge variant="neutral">
            {usesEach === null ? "one use each" : `${usesEach} ${usesEach === 1 ? "use" : "uses"} each`}
          </Badge>
        </div>

        <p className="text-[13px] leading-[1.7] text-dust">
          Send each code to one person. A recipient enters it at{" "}
          <code className="kbd">/login</code> after the Google step; redemption then marks the account
          as admitted by this row, and the list below shows its use count — never its value.
        </p>
      </PanelBody>
    </Panel>
  )
}
