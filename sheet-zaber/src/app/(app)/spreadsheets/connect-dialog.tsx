"use client"

/*
 * The "connect a spreadsheet" flow (docs/plan.md D7): pick one of the account's connected Google
 * identities and paste a spreadsheet URL or id. There is deliberately NO Google Drive Picker —
 * that would need a Drive scope the plan rejected (D6) plus a browser-side token the architecture
 * never persists (docs/google-integration.md). The submit calls `connectSpreadsheetAction`, which
 * runs `spreadsheets.get` server-side as the real permission check. Pending state comes from
 * `useActionState`; the server's own `ActionResult` codes drive the messaging, never a raw code
 * alone. The dialog is mounted only while open, so closing and reopening resets the form state.
 */

import { useActionState, useState } from "react"

import { Button, PillLink } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { SelectField, TextField } from "@/components/ui/field"
import { connectSpreadsheetAction, type ConnectState } from "@/app/(app)/spreadsheets/actions"

export type ConnectableAccount = {
  id: string
  googleEmail: string
  status: "connected" | "reauth_required" | "disconnected"
}

const INITIAL: ConnectState = { status: "idle" }

// Codes that mean "your Google grant is the problem", so the fix is the reconnect entry, not the form.
const REAUTH_CODES = new Set(["google_reauth_required", "google_not_connected"])

export function ConnectDialog({ accounts }: { accounts: ConnectableAccount[] }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="solid" size="md" onClick={() => setOpen(true)}>
        Connect spreadsheet
      </Button>
      {open ? <ConnectForm accounts={accounts} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function ConnectForm({ accounts, onClose }: { accounts: ConnectableAccount[]; onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(connectSpreadsheetAction, INITIAL)
  const fields = state.status === "error" ? state.fields : undefined

  return (
    <Dialog
      open
      title="Connect a Google spreadsheet"
      description="Sheet Zaber reads the sheet with your own Google connection to confirm access, then stores its tabs. Nothing is fetched until you submit."
      onClose={onClose}
      size="md"
    >
      {state.status === "success" ? (
        <div className="flex flex-col gap-4">
          <div className="border border-edge bg-lift px-4 py-3" role="status">
            <p className="text-[14px] text-paper">Connected “{state.title}”.</p>
            <p className="mt-1 text-[13px] leading-[1.6] text-dust">
              It now appears in your spreadsheet list. Open it to refresh tabs, preview a header
              row, or build an endpoint.
            </p>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="line" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <form action={formAction} className="flex flex-col gap-4">
          {accounts.length === 0 ? (
            <div className="flex flex-col gap-2 border-l-2 border-warn bg-lift px-4 py-3">
              <p className="text-[14px] text-paper">No Google account is connected yet.</p>
              <p className="text-[13px] leading-[1.6] text-mist">
                A spreadsheet is registered through a Google connection, so connect an account first.
                Your Google OAuth app in “Testing” mode caps consent at 100 users and refresh tokens
                expire after about 7 days, so re-connecting is a normal step.
              </p>
              <div>
                <PillLink href="/auth/google/connect" variant="solid" size="sm">
                  Connect a Google account
                </PillLink>
              </div>
            </div>
          ) : (
            <SelectField
              label="Google account"
              name="connectionId"
              required
              defaultValue={accounts.length === 1 ? accounts[0].id : ""}
              placeholder={accounts.length === 1 ? undefined : "Choose a connected account"}
              options={accounts.map((account) => ({
                value: account.id,
                label:
                  account.status === "connected"
                    ? account.googleEmail
                    : `${account.googleEmail} — needs reconnecting`,
              }))}
              error={fields?.connectionId}
              hint={
                accounts.some((account) => account.status !== "connected")
                  ? "An account marked “needs reconnecting” will fail until you re-consent at /auth/google/connect."
                  : "The account must already have access to the spreadsheet."
              }
              disabled={isPending}
            />
          )}

          <TextField
            label="Spreadsheet URL or id"
            name="url"
            required
            spellCheck={false}
            autoComplete="off"
            placeholder="https://docs.google.com/spreadsheets/d/… or the id alone"
            hint="Paste from a Google Sheets link (docs.google.com/spreadsheets/d/…) or a spreadsheet id."
            error={fields?.url}
            disabled={isPending}
            className="font-mono text-[13px]"
          />

          {state.status === "error" ? (
            <div className="flex flex-col gap-2" role="alert">
              <p className="text-[13px] leading-[1.6] text-paper">
                ⚠ {state.message}
                <span className="ml-2 font-mono text-[11px] tracking-[0.08em] text-dust uppercase">
                  {state.code}
                </span>
              </p>
              {REAUTH_CODES.has(state.code) ? (
                <div>
                  <PillLink href="/auth/google/connect" variant="line" size="sm">
                    Reconnect Google
                  </PillLink>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-3 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="solid" loading={isPending}>
              {isPending ? "Connecting…" : "Connect spreadsheet"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
