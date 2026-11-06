"use client"

/*
 * Invite by email. The server mints one code per address and emails it, so the owner never sees the
 * code. `accepted` means the provider took the message, not that it reached an inbox.
 */

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { TextField } from "@/components/ui/field"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { inviteByEmailAction } from "../actions"
import type { InviteByEmailState } from "../action-types"

const INITIAL_STATE: InviteByEmailState = { status: "idle" }

export function InviteEmailForm() {
  const [state, formAction, isPending] = useActionState(inviteByEmailAction, INITIAL_STATE)
  const error = state.status === "error" ? state : null
  const sent = state.status === "sent" ? state.deliveries : null
  const failedCount = sent?.filter((delivery) => !delivery.accepted).length ?? 0

  return (
    <Panel as="section">
      <PanelHeader
        title="Invite by email"
        description="Each address gets its own single-use code. You will not see the code, and it can't be sent again."
      />
      <PanelBody className="flex flex-col gap-5">
        <form action={formAction} className="flex flex-col gap-5">
          <TextField
            label="Email addresses"
            name="emails"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="rahim@example.com, sara@example.com"
            hint="Separate addresses with commas or spaces."
            error={error?.fields?.emails}
            disabled={isPending}
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              label="Label (optional)"
              name="label"
              maxLength={120}
              autoComplete="off"
              error={error?.fields?.label}
              disabled={isPending}
            />
            <TextField
              label="Expires on (optional)"
              name="expiresAt"
              type="date"
              error={error?.fields?.expiresAt}
              disabled={isPending}
            />
          </div>

          {error ? (
            <p role="alert" className="text-[13px] leading-[1.6] text-paper">
              ⚠ {error.message}
              <span className="ml-2 font-mono text-[11px] uppercase tracking-[0.08em] text-dust">{error.code}</span>
            </p>
          ) : null}

          <div>
            <Button type="submit" variant="solid" loading={isPending}>
              {isPending ? "Sending…" : "Send invitations"}
            </Button>
          </div>
        </form>

        {sent ? (
          <div aria-live="polite" className="border-t border-rule pt-4">
            <ul className="flex flex-col gap-2 text-[13px] leading-[1.6]">
              {sent.map((delivery) => (
                <li key={delivery.invitationId} className="text-mist">
                  <span className="text-paper">{delivery.email}</span>:{" "}
                  {delivery.accepted ? "accepted by the email provider" : `not sent. ${delivery.reason ?? ""}`}
                </li>
              ))}
            </ul>
            {failedCount > 0 ? (
              <p className="mt-3 text-[13px] leading-[1.6] text-dust">
                Revoke the unsent codes in the table below, then invite those addresses again.
              </p>
            ) : null}
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  )
}
