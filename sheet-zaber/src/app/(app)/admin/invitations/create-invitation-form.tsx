"use client"

/*
 * Issue invitation codes. One submit = one `createInvitations` call
 * (`src/server/invitations/service.ts:203`), which owns the code generation, the hashing, the batch
 * INSERT and the `invitation.create` audit row. This file owns no rule: the values go through
 * `createInvitationsSchema` (`src/lib/schemas.ts:28`) inside the action, and whatever that schema
 * reports under `fields` is rendered next to the input it names.
 *
 * The plaintext codes that come back are handed straight to `./code-reveal.tsx` and are held nowhere
 * else — not in the URL, not in storage, not in a fetched list.
 */

import { useActionState, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TextField } from "@/components/ui/field"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { createInvitationsAction } from "../actions"
import type { CreateInvitationsState, InvitationFieldErrors } from "../action-types"
import { InvitationCodeReveal } from "./code-reveal"

/** A `{ status: "idle" }` start value kept LOCAL to this client file: a `"use server"` module may
 *  export functions only, so the initial state cannot come from `../actions`. */
const INITIAL_STATE: CreateInvitationsState = { status: "idle" }

const NO_FIELDS: InvitationFieldErrors = {}

/** Limits stated as `createInvitationsSchema` enforces them — the labels say what the server accepts. */
const COUNT_MIN = 1
const COUNT_MAX = 500
const USES_MIN = 1
const USES_MAX = 1000
const LABEL_MAX = 120

export function CreateInvitationForm() {
  const [state, formAction, isPending] = useActionState(createInvitationsAction, INITIAL_STATE)
  // A dismissed reveal stays dismissed until the NEXT submit; a new batch is new code material and
  // must be shown again, which is what `useActionState` re-rendering the fresh result gives us.
  const [revealHidden, setRevealHidden] = useState(false)

  const error = state.status === "error" ? state : null
  const fields = error?.fields ?? NO_FIELDS
  const succeeded = state.status === "created" ? state : null
  const created = succeeded !== null && !revealHidden ? succeeded : null

  return (
    <Panel as="section">
      <PanelHeader
        title="Issue codes"
        description="A batch of codes sharing one label, one use limit and one expiry. Each is random, hashed on the way in, and visible only in the panel this form opens when it succeeds."
      />

      <PanelBody className="flex flex-col gap-5">
        <form action={formAction} className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              label="How many codes"
              name="count"
              type="number"
              inputMode="numeric"
              min={COUNT_MIN}
              max={COUNT_MAX}
              required
              defaultValue={5}
              hint={`${COUNT_MIN} to ${COUNT_MAX} per batch. Every code in the batch is a separate row.`}
              error={fields.count}
              disabled={isPending}
            />
            <TextField
              label="Redemptions allowed per code"
              name="maxUses"
              type="number"
              inputMode="numeric"
              min={USES_MIN}
              max={USES_MAX}
              defaultValue={1}
              hint={`${USES_MIN} to ${USES_MAX}. One use means a code dies the moment it admits someone.`}
              error={fields.maxUses}
              disabled={isPending}
            />
          </div>

          <TextField
            label="Label (optional)"
            name="label"
            maxLength={LABEL_MAX}
            autoComplete="off"
            spellCheck={false}
            placeholder="beta cohort — November"
            hint={`Up to ${LABEL_MAX} characters. Shown in the list and stored in the audit row as a flag only, because your memo may hold an address.`}
            error={fields.label}
            disabled={isPending}
          />

          <TextField
            label="Expires on (optional)"
            name="expiresAt"
            type="date"
            hint="Leave empty for a code that never expires on its own. A date in the past creates rows that are already expired: they will be listed as Expired and every redemption attempt will be refused."
            error={fields.expiresAt}
            disabled={isPending}
          />

          {error ? (
            <p role="alert" className="text-[13px] leading-[1.6] text-paper">
              ⚠ {error.message}
              <span className="ml-2 font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
                {error.code}
              </span>
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="solid" loading={isPending}>
              {isPending ? "Generating codes…" : "Create invitation codes"}
            </Button>
            <span aria-live="polite" className="folio">
              {succeeded ? `${succeeded.codes.length} stored` : ""}
            </span>
          </div>
        </form>

        <div className="border-t border-rule pt-4">
          <p className="folio">Guessing codes is not a viable path — here is what actually stops it</p>
          <ul className="mt-2 flex flex-col gap-2 text-[13px] leading-[1.7] text-dust">
            <li>
              A code is eight characters drawn from a 32-symbol Crockford alphabet by{" "}
              <span className="font-mono text-[12px] text-mist">crypto.randomBytes</span>, written as{" "}
              <span className="font-mono text-[12px] text-mist">ZABER-XXXX-XXXX</span>. Entry is
              case-insensitive: the schema upper-cases what a visitor types before it is hashed, so
              capitalisation is not extra secrecy.
            </li>
            <li>
              Redemption is capped at{" "}
              <span className="font-mono text-[12px] text-mist">5 attempts per 15 minutes</span> — per
              pending Google sign-in <span className="text-mist">and</span> per IP address, both
              counted, the longer wait winning. The counter is a database fixed window, so it survives
              a restart and is shared across instances, and it is consumed inside the service before
              the code is even hashed: a malformed spray burns the same budget.
            </li>
            <li>
              Only the SHA-256 of a code is stored. A database dump cannot be read as a list of usable
              invitations, which is also why the codes above can never be shown again.
            </li>
          </ul>
          <p className="mt-3 text-[13px] leading-[1.7] text-dust">
            Fair use, not a widget: send each code to one named person, and revoke it from the table
            below if it was never used or went somewhere you did not mean. There is no separate
            rate-limit control here because there is no per-invitation rate limit to control — the
            numbers above are the whole policy.
          </p>
        </div>

        {created ? (
          <div className="border-t border-rule pt-5">
            <InvitationCodeReveal
              codes={created.codes}
              issued={created.issued}
              onDismiss={() => setRevealHidden(true)}
            />
          </div>
        ) : null}

        {succeeded !== null && revealHidden ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-5">
            <Badge variant="outline">Hidden</Badge>
            <p className="text-[13px] leading-[1.6] text-dust">
              {succeeded.codes.length} {succeeded.codes.length === 1 ? "code is" : "codes are"}{" "}
              stored and listed in the table below, but their values are gone from this screen and no
              read can bring them back. Issue another batch if none were copied.
            </p>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  )
}
