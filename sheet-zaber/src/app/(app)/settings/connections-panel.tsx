"use client"

/*
 * The Google connection list — a client island for one reason only: disconnecting is a real
 * mutation with a typed confirmation, pending state and feedback. Every string in `rows` was read
 * and formatted on the server from `listConnections` (docs/backend-api-contract.md §4.6), so this
 * file never imports from `src/server/**` (`server-only`) and never re-derives a status.
 *
 * Nothing here is a switch that forgets its own state: the row disappears because
 * `disconnectGoogleAction` revalidates the path and the database row is gone.
 */

import { useCallback, useEffect, useRef, useState, useActionState } from "react"

import { Badge, type BadgeVariant } from "@/components/ui/badge"
import { Button, PillLink } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/dialog"
import { MonoCell, Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import { disconnectGoogleAction, type DisconnectState } from "./actions"

/** The three values `google_connections.status` is CHECK-constrained to (plus the empty list). */
export type ConnectionStatusView = "connected" | "reauth_required" | "disconnected"

export type ConnectionView = {
  id: string
  googleEmail: string
  scope: string
  status: ConnectionStatusView
  /** `formatDateTime(connectedAt)` — computed server-side so it cannot re-hydrate differently. */
  connectedLabel: string
  /** `null` is the stored `lastUsedAt: null`: never used since it was connected. */
  lastUsedLabel: string | null
}

type Feedback = { kind: "ok" | "error"; text: string; code?: string } | null

const IDLE: DisconnectState = { status: "idle" }

/**
 * Wording first, colour second: the badge always carries the word, so a status is readable with no
 * hue at all — and the sentence beneath it says what the state means for the user's endpoints.
 */
const STATUS: Record<
  ConnectionStatusView,
  { label: string; badge: BadgeVariant; hint: string }
> = {
  connected: {
    label: "Connected",
    badge: "inverted",
    hint: "Google still accepts the saved grant, so sheets registered through this account read and write.",
  },
  reauth_required: {
    label: "Needs re-consent",
    badge: "neutral",
    hint: "The stored refresh token stopped answering. Re-consenting updates this same row back to connected.",
  },
  disconnected: {
    label: "Disconnected",
    badge: "failed",
    hint: "The grant is dead: endpoints served through this account answer google_reauth_required until you re-consent.",
  },
}

export function ConnectionsPanel({ rows }: { rows: ConnectionView[] }) {
  const [feedback, setFeedback] = useState<Feedback>(null)
  const report = useCallback((value: Feedback) => setFeedback(value), [])

  return (
    <>
      <div aria-live="polite" className="px-5 pt-4 empty:hidden">
        {feedback?.kind === "ok" ? (
          <p role="status" className="text-[13px] leading-[1.6] text-mist">
            {feedback.text}
          </p>
        ) : null}
        {feedback?.kind === "error" ? (
          <p role="alert" className="text-[13px] leading-[1.6] text-paper">
            ⚠ {feedback.text}{" "}
            {feedback.code ? (
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
                {feedback.code}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      <TableScroll label="Connected Google accounts" className="mt-2">
        <Table>
          <thead>
            <tr>
              <Th>Google account</Th>
              <Th>Status</Th>
              <Th>Granted scope</Th>
              <Th>Connected</Th>
              <Th>Last used</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ConnectionRow key={row.id} row={row} onResult={report} />
            ))}
          </tbody>
        </Table>
      </TableScroll>

      {/*
        One plain-text child: with scripting enabled the browser keeps `<noscript>` content as raw
        text, so anything nested here would be markup on the server and a text node in the DOM. The
        disconnect control genuinely needs JavaScript, so this says so instead of leaving a button
        that silently does nothing.
      */}
      <noscript>
        {"Removing a Google connection runs in the browser — the typed confirmation is checked before the request is sent — so with JavaScript disabled the Disconnect control does nothing. Everything else here still works: the values on this page are server-rendered, and the connect, re-consent and sign-out controls are a plain link and a form POST."}
      </noscript>
    </>
  )
}

function ConnectionRow({
  row,
  onResult,
}: {
  row: ConnectionView
  onResult: (value: Feedback) => void
}) {
  const [state, formAction, isPending] = useActionState(disconnectGoogleAction, IDLE)
  const [confirming, setConfirming] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  const status = STATUS[row.status]
  const failure = state.status === "error" ? state : null
  const failureText = failure
    ? [failure.message, ...Object.values(failure.fields ?? {})].filter(Boolean).join(" ")
    : ""

  // A success unmounts this row when the path revalidates, so the message has to be handed to the
  // panel that outlives it rather than rendered from the row's own state.
  useEffect(() => {
    if (state.status === "error") {
      onResult({ kind: "error", text: failureText, code: state.code })
    } else if (state.status === "success") {
      onResult({
        kind: "ok",
        text: `Disconnected ${row.googleEmail}. The stored grant is deleted, and with it every spreadsheet registered through that account.`,
      })
    }
  }, [state, failureText, onResult, row.googleEmail])

  function confirmDisconnect() {
    // React 19's documented way to run a `useActionState` action from a control outside the form.
    formRef.current?.requestSubmit()
  }

  return (
    <Tr interactive>
      <Td>
        <span
          className="block max-w-[240px] truncate text-[14px] text-paper"
          title={row.googleEmail}
        >
          {row.googleEmail}
        </span>
        <MonoCell value={row.id} title={`Connection id ${row.id}`} />
      </Td>
      <Td>
        <Badge variant={status.badge}>{status.label}</Badge>
        <span className="mt-2 block max-w-[34ch] text-[12px] leading-[1.5] text-dust">
          {status.hint}
        </span>
      </Td>
      <Td>
        <MonoCell value={row.scope} title={row.scope} />
      </Td>
      <Td className="whitespace-nowrap text-dust">{row.connectedLabel}</Td>
      <Td className="whitespace-nowrap text-dust">
        {row.lastUsedLabel === null ? (
          <span title="last_used_at is null: this connection has not served a request since it was created.">
            Never used since
          </span>
        ) : (
          row.lastUsedLabel
        )}
      </Td>
      <Td align="right">
        <span className="flex flex-wrap items-center justify-end gap-2">
          {row.status === "reauth_required" ? (
            // Re-consent, not "connect": the row already exists, and `/auth/google/connect` is the
            // entry whose state re-attaches a grant to the session user (google-integration.md §6).
            <PillLink href="/auth/google/connect" prefetch={false} variant="line" size="sm">
              Re-consent
            </PillLink>
          ) : null}
          <Button variant="danger" size="sm" disabled={isPending} onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        </span>

        <div className="mt-2 flex justify-end">
          {/* The action target: its only submitter is the confirmation dialog's gated button. */}
          <form ref={formRef} action={formAction} className="hidden">
            <input type="hidden" name="connectionId" value={row.id} />
          </form>

          {confirming ? (
            <ConfirmDialog
              open
              title={`Disconnect ${row.googleEmail}?`}
              confirmLabel="Remove this connection"
              requireText={row.googleEmail}
              busy={isPending}
              error={failure ? failureText : undefined}
              onClose={() => setConfirming(false)}
              onConfirm={confirmDisconnect}
              body={
                <div className="flex flex-col gap-2">
                  <p>
                    Sheet Zaber deletes the stored grant for{" "}
                    <span className="font-mono">{row.googleEmail}</span> and asks Google to revoke it.
                    The row is what enforces access, so removing it stops every endpoint served
                    through this account.
                  </p>
                  <p className="text-[13px] text-dust">
                    <strong className="text-paper">
                      Registered spreadsheets are removed with it
                    </strong>{" "}
                    — <span className="font-mono">registered_spreadsheets.connection_id</span>{" "}
                    cascades, and the endpoints built on those sheets cascade in turn. Your Google
                    Sheet and its data are untouched; re-consenting later lets you register them
                    again.
                  </p>
                </div>
              }
            />
          ) : null}
        </div>
      </Td>
    </Tr>
  )
}
