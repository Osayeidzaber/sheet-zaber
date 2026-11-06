"use client"

/*
 * The key inventory table. A client island because revoke and regenerate are real mutations with
 * pending state, confirmation and feedback — everything else is server-rendered data the page
 * already read (`listKeys`, `src/server/keys/service.ts:199`) and formatted into plain strings.
 *
 * The rows carry `keyPreview` only; there is no prop, state field or variable here that could hold
 * a hash or a stored plaintext, because `ApiKeyMeta` has neither. The only full key this component
 * ever sees is the one `regenerateKeyFormAction` just minted, and it goes into `KeyReveal`.
 */

import { useState, useTransition } from "react"

import { isActionError } from "@/lib/action-result"
import { Badge, StatusDot } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/dialog"
import { Panel, PanelHeader } from "@/components/ui/panel"
import { MonoCell, Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import type { RevealedKey } from "./actions"
import { regenerateKeyFormAction, revokeKeyFormAction } from "./actions"
import { KeyReveal } from "./key-reveal"

/** The two scope words `apiKeyScopeSchema` accepts (`src/lib/schemas.ts:86`), declared locally so
 *  this client file never imports from `src/server/**`. */
type KeyScope = "read" | "write"

export type KeyRowView = {
  id: string
  name: string
  keyPreview: string
  scopes: KeyScope[]
  endpointsLabel: string
  endpointsDetail: string
  createdLabel: string
  lastUsedLabel: string
  /** Full sentence for the last-used cell's `title`, so `—` still says what it means. */
  lastUsedTitle: string
  /** `true` = the stored `expiresAt` has passed, so this key no longer authenticates. */
  expired: boolean
  statusLabel: string
  expiresLabel: string | null
}

type Pending = { kind: "revoke" | "regenerate"; key: KeyRowView } | null

export function KeysTable({ rows }: { rows: KeyRowView[] }) {
  const [isPending, startTransition] = useTransition()
  const [confirm, setConfirm] = useState<Pending>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ message: string; code: string } | null>(null)
  const [regenerated, setRegenerated] = useState<RevealedKey | null>(null)

  function closeDialog() {
    setConfirm(null)
  }

  function runRevoke(key: KeyRowView) {
    startTransition(async () => {
      const result = await revokeKeyFormAction(key.id)
      setConfirm(null)
      if (isActionError(result)) {
        setFailure({ message: result.error.message, code: result.error.code })
        return
      }
      setFailure(null)
      setFeedback(`Revoked “${key.name}”. It can no longer authenticate a request.`)
    })
  }

  function runRegenerate(key: KeyRowView) {
    startTransition(async () => {
      const result = await regenerateKeyFormAction(key.id)
      setConfirm(null)
      if (isActionError(result)) {
        setFailure({ message: result.error.message, code: result.error.code })
        return
      }
      setFailure(null)
      setFeedback(
        `“${key.name}” now has a new key. ${key.keyPreview} is revoked and stops working immediately.`
      )
      setRegenerated(result.data)
    })
  }

  return (
    <Panel as="section">
      <PanelHeader
        title="Your keys"
        description={`${rows.length} ${
          rows.length === 1 ? "key" : "keys"
        } not revoked, newest first. A revoked key is history, so it is never listed here — and its full value was never stored, so it can never be shown again.`}
      />

      {regenerated ? (
        <div className="px-5 pt-5">
          <KeyReveal
            headline="Your new key — copy it now"
            name={regenerated.name}
            keyPreview={regenerated.keyPreview}
            plaintext={regenerated.plaintext}
            detail={
              regenerated.allowedApiIds === null
                ? "all endpoints"
                : `${regenerated.allowedApiIds.length} endpoint${
                    regenerated.allowedApiIds.length === 1 ? "" : "s"
                  }`
            }
            onDismiss={() => setRegenerated(null)}
          />
        </div>
      ) : null}

      <div aria-live="polite" className="px-5 pt-4 empty:hidden">
        {feedback ? <p className="font-mono text-[12px] text-dust">{feedback}</p> : null}
        {failure ? (
          <p role="alert" className="text-[13px] text-paper">
            ⚠ {failure.message}{" "}
            <span className="font-mono text-[11px] tracking-[0.08em] text-dust uppercase">
              {failure.code}
            </span>
          </p>
        ) : null}
      </div>

      <TableScroll label="Active API keys" className="mt-2">
        <Table>
          <thead>
            <tr>
              <Th>Key</Th>
              <Th>Preview</Th>
              <Th>Scopes</Th>
              <Th>Endpoints</Th>
              <Th>Created</Th>
              <Th>Last used</Th>
              <Th>Status</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((key) => (
              <Tr key={key.id} interactive>
                <Td>
                  <span className="block max-w-[220px] truncate text-paper">{key.name}</span>
                </Td>
                <Td>
                  <MonoCell value={key.keyPreview} title={key.keyPreview} />
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1.5">
                    {key.scopes.length === 0 ? (
                      // Never stored (createKeySchema requires min(1)), but a row that says so is
                      // rendered as `—` rather than as an invented scope.
                      <span className="font-mono text-[12px] text-dust">—</span>
                    ) : (
                      key.scopes.map((scope) => (
                        <Badge key={scope} variant="neutral">
                          {scope}
                        </Badge>
                      ))
                    )}
                  </span>
                </Td>
                <Td>
                  <span className="block max-w-[220px] truncate" title={key.endpointsDetail}>
                    {key.endpointsLabel}
                  </span>
                </Td>
                <Td className="whitespace-nowrap text-dust">{key.createdLabel}</Td>
                <Td className="whitespace-nowrap text-dust">
                  <span title={key.lastUsedTitle}>{key.lastUsedLabel}</span>
                </Td>
                <Td>
                  <StatusDot
                    tone={key.expired ? "idle" : "active"}
                    label={key.statusLabel}
                    className="whitespace-nowrap"
                  />
                  {key.expiresLabel ? (
                    <span className="mt-1 block font-mono text-[11px] text-dust">
                      {key.expiresLabel}
                    </span>
                  ) : null}
                </Td>
                <Td align="right">
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      size="sm"
                      variant="line"
                      disabled={isPending}
                      onClick={() => {
                        setFeedback(null)
                        setFailure(null)
                        setConfirm({ kind: "regenerate", key })
                      }}
                    >
                      Regenerate
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={isPending}
                      onClick={() => {
                        setFeedback(null)
                        setFailure(null)
                        setConfirm({ kind: "revoke", key })
                      }}
                    >
                      Revoke
                    </Button>
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>

      {confirm?.kind === "revoke" ? (
        <ConfirmDialog
          open
          title={`Revoke “${confirm.key.name}”?`}
          body={
            <span>
              Every client still sending <span className="font-mono">{confirm.key.keyPreview}</span>{" "}
              stops working on its next request, and revoking cannot be undone — a new key has to be
              created. The row stays in your request log as the preview only.
            </span>
          }
          confirmLabel="Revoke key"
          busy={isPending}
          onConfirm={() => runRevoke(confirm.key)}
          onClose={closeDialog}
        />
      ) : null}

      {confirm?.kind === "regenerate" ? (
        <ConfirmDialog
          open
          title={`Regenerate “${confirm.key.name}”?`}
          body={
            <span>
              This creates a new key and revokes{" "}
              <span className="font-mono">{confirm.key.keyPreview}</span> in the same step.{" "}
              <strong className="text-paper">The old key stops working immediately</strong>, so any
              client using it gets <span className="font-mono">401</span> until you paste the new
              one. Name, scopes and endpoint restriction carry over. The new key is shown once and
              never again.
            </span>
          }
          confirmLabel="Regenerate and revoke the old key"
          busy={isPending}
          onConfirm={() => runRegenerate(confirm.key)}
          onClose={closeDialog}
        />
      ) : null}
    </Panel>
  )
}
