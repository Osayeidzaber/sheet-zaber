"use client"

/*
 * The one-time key reveal (`docs/security.md` §2 "hashed API keys",
 * `docs/backend-api-contract.md` §4.6: `plaintext` exists only on the return of
 * `createKey`/`regenerateKey`).
 *
 * This component is the only place in the dashboard that renders a full `sz_live_…` value, and it
 * renders one it was GIVEN — by the action that just minted it. It never fetches a key: there is
 * no read path that can produce the plaintext (`src/server/keys/service.ts:199` returns
 * `ApiKeyMeta[]`, whose column list has no hash and no plaintext), so unmounting this panel is
 * genuinely irreversible. The value is held in React state for the length of this view only: it is
 * not written to a URL, not stored in any client store, and not logged.
 */

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyField } from "@/components/ui/copy"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"

export function KeyReveal({
  name,
  keyPreview,
  plaintext,
  detail,
  headline = "Copy this key now",
  onDismiss,
}: {
  /** The key's own name, so the user knows which row the credential belongs to. */
  name: string
  /** The storable preview (`sz_live_ab12…c3d4`) — the only form that survives this screen. */
  keyPreview: string
  /** The full plaintext. Shown once, here, and nowhere else in this codebase. */
  plaintext: string
  /** Caller's own summary of scopes / endpoint restriction, already formatted. */
  detail?: string
  headline?: string
  onDismiss?: () => void
}) {
  return (
    <Panel as="section" className="border-paper">
      <PanelHeader
        title={headline}
        description={`“${name}” · ${keyPreview} · this is the only time the full key is shown.`}
        action={
          onDismiss ? (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Hide
            </Button>
          ) : undefined
        }
      />
      <PanelBody className="flex flex-col gap-4">
        <CopyField value={plaintext} label="API key (shown once)" revealOnce />

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="inverted">Stored as a SHA-256 hash</Badge>
          <Badge variant="outline">Only the preview remains readable</Badge>
          {detail ? <Badge variant="neutral">{detail}</Badge> : null}
        </div>

        <p className="text-[13px] leading-[1.7] text-dust">
          Paste it into your client as <code className="kbd">Authorization: Bearer …</code>. If you
          close this panel without copying it, the only way to get a working key is to regenerate —
          which stops this one working immediately.
        </p>
      </PanelBody>
    </Panel>
  )
}
