"use client"

/*
 * The admin user table — a client island because four real mutations need pending state,
 * confirmation and honest feedback. Everything it renders was read and formatted by
 * `../users/page.tsx` from `listUsers()` → the §4.6 `AdminUserRow` projection
 * (`src/server/admin/users.ts:61`, which is also exactly what `GET /api/internal/admin/users`
 * serializes). Nothing here imports `src/server/**`: rows arrive as plain strings, and the verbs
 * arrive as the four action functions from `../actions.ts`.
 *
 * Controls are plain buttons in the row, not a dropdown: a menu is keyboard work to get right and it
 * would hide the three verbs an owner needs, so each one stays a tab stop with its own name and its
 * own `aria-label` naming the account it acts on.
 *
 * NOTHING HERE IS THE AUTHORIZATION CHECK. Suppressing Disable/Demote on the caller's own row is
 * courtesy for a request the server refuses anyway (`SELF_ACCESS_MESSAGE`,
 * `src/server/admin/users.ts:83`); each action re-establishes the owner from the request and the
 * service re-runs `can()` plus the self-revocation and last-owner floors.
 */

import Link from "next/link"
import { useState, useTransition } from "react"

import { isActionError } from "@/lib/action-result"
import { Badge, StatusDot } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/dialog"
import { TextField } from "@/components/ui/field"
import { MonoCell, Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import {
  adminDeleteUserAction,
  adminDemoteUserAction,
  adminPromoteUserAction,
  adminSetUserLimitAction,
  adminSetUserStatusAction,
} from "../actions"
import type { RoleValue, UserActionResult, UserMutationResult, UserStatusValue } from "../action-types"

export type AdminUserRowView = {
  id: string
  email: string
  role: RoleValue
  status: UserStatusValue
  /** Invitation provenance in words: `invitations.label` if the owner wrote one, else the row id. */
  invite: string
  /** `users.invitation_id` is set. The id is never a code and never becomes one. */
  hasInvitation: boolean
  apiCount: string
  requestTotal: string
  /** The stored allocation; `0` means unlimited. */
  apiLimitPerDay: number
  /** What the limit means in words: an owner is unlimited whatever is stored. */
  limitLabel: string
  lastLogin: string
  createdAt: string
  /** The row behind this console session: disable and demote are refused server-side for it. */
  isSelf: boolean
}

type Verb = "disable" | "enable" | "promote" | "demote"
type Target = { verb: Verb; row: AdminUserRowView } | null

const VERB_LABEL: Record<Verb, string> = {
  disable: "Disable",
  enable: "Enable",
  promote: "Promote to owner",
  demote: "Demote to user",
}

/** One dispatch for four buttons: every arm returns the same `ActionResult` envelope. */
function submit(verb: Verb, id: string): Promise<UserActionResult> {
  if (verb === "promote") return adminPromoteUserAction(id)
  if (verb === "demote") return adminDemoteUserAction(id)
  return adminSetUserStatusAction(id, verb === "disable" ? "disabled" : "active")
}

export function AdminUserTable({ rows }: { rows: AdminUserRowView[] }) {
  const [isPending, startTransition] = useTransition()
  const [target, setTarget] = useState<Target>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ message: string; code: string; field?: string } | null>(
    null
  )

  const [limitTarget, setLimitTarget] = useState<AdminUserRowView | null>(null)
  const [limitValue, setLimitValue] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<AdminUserRowView | null>(null)
  const [dialogError, setDialogError] = useState<string | undefined>(undefined)

  function saveLimit(row: AdminUserRowView) {
    startTransition(async () => {
      const result = await adminSetUserLimitAction(row.id, limitValue)
      if (isActionError(result)) {
        setDialogError(result.error.fields?.apiLimitPerDay ?? result.error.message)
        return
      }
      setLimitTarget(null)
      setDialogError(undefined)
      setFailure(null)
      setFeedback(`Stored: ${row.email}'s daily limit is now ${limitValue === "0" ? "unlimited" : limitValue}.`)
    })
  }

  function removeUser(row: AdminUserRowView) {
    startTransition(async () => {
      const result = await adminDeleteUserAction(row.id)
      if (isActionError(result)) {
        setDialogError(result.error.fields?.id ?? result.error.message)
        return
      }
      setDeleteTarget(null)
      setDialogError(undefined)
      setFailure(null)
      setFeedback(`Deleted ${row.email}.`)
    })
  }

  function run(verb: Verb, row: AdminUserRowView) {
    startTransition(async () => {
      const result = await submit(verb, row.id)
      setTarget(null)

      if (isActionError(result)) {
        setFeedback(null)
        setFailure({
          message: result.error.message,
          code: result.error.code,
          // The service reports a self/last-owner refusal under `role` or `id` depending on the verb
          // (`src/server/admin/users.ts:288`); whichever key fired is the one worth naming.
          field: result.error.fields?.status ?? result.error.fields?.role ?? result.error.fields?.id,
        })
        return
      }

      setFailure(null)
      setFeedback(outcome(row, verb, result.data))
    })
  }

  return (
    <>
      <div aria-live="polite" className="px-5 pt-4 empty:hidden">
        {feedback ? <p className="font-mono text-[12px] text-dust">{feedback}</p> : null}
        {failure ? (
          <p role="alert" className="text-[13px] leading-[1.6] text-paper">
            ⚠ {failure.message}
            {failure.field ? ` — ${failure.field}` : ""}{" "}
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
              {failure.code}
            </span>
          </p>
        ) : null}
      </div>

      <TableScroll label="Platform accounts" className="mt-2">
        <Table>
          <thead>
            <tr>
              <Th>Account</Th>
              <Th>Invitation used</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th align="right">Endpoints</Th>
              <Th align="right">Requests</Th>
              <Th align="right">Daily limit</Th>
              <Th>Last login</Th>
              <Th>Joined</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Tr key={row.id} interactive>
                <Td>
                  <Link
                    href={`/admin/users/${row.id}`}
                    className="block max-w-[260px] truncate text-paper underline decoration-edge underline-offset-4"
                  >
                    {row.email}
                  </Link>
                  {row.isSelf ? (
                    <span className="block font-mono text-[11px] text-dust">this session</span>
                  ) : null}
                  <MonoCell value={row.id} title={row.id} />
                </Td>
                <Td>
                  {row.hasInvitation ? (
                    <span className="block max-w-[200px] truncate" title={row.invite}>
                      {row.invite}
                    </span>
                  ) : (
                    <span className="font-mono text-[12px] text-dust">none recorded</span>
                  )}
                </Td>
                <Td>
                  <Badge variant={row.role === "owner" ? "inverted" : "neutral"}>
                    {row.role === "owner" ? "Owner" : "User"}
                  </Badge>
                </Td>
                <Td>
                  <StatusDot
                    tone={row.status === "active" ? "active" : "failed"}
                    label={row.status === "active" ? "Active" : "Disabled"}
                    className="whitespace-nowrap"
                  />
                </Td>
                <Td numeric>{row.apiCount}</Td>
                <Td numeric>{row.requestTotal}</Td>
                <Td numeric>{row.limitLabel}</Td>
                <Td className="whitespace-nowrap text-dust">{row.lastLogin}</Td>
                <Td className="whitespace-nowrap text-dust">{row.createdAt}</Td>
                <Td align="right">
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    {row.status === "active" ? (
                      row.isSelf ? (
                        <span className="font-mono text-[11px] text-dust">own account</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={isPending}
                          aria-label={`Disable ${row.email}`}
                          onClick={() => setTarget({ verb: "disable", row })}
                        >
                          Disable
                        </Button>
                      )
                    ) : (
                      <Button
                        size="sm"
                        variant="line"
                        disabled={isPending}
                        aria-label={`Enable ${row.email}`}
                        onClick={() => run("enable", row)}
                      >
                        Enable
                      </Button>
                    )}

                    {row.role === "user" ? (
                      <Button
                        size="sm"
                        variant="line"
                        disabled={isPending}
                        aria-label={`Promote ${row.email} to owner`}
                        onClick={() => setTarget({ verb: "promote", row })}
                      >
                        Promote
                      </Button>
                    ) : row.isSelf ? (
                      <span className="font-mono text-[11px] text-dust">own account</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={isPending}
                        aria-label={`Demote ${row.email} to user`}
                        onClick={() => setTarget({ verb: "demote", row })}
                      >
                        Demote
                      </Button>
                    )}

                    <Button
                      size="sm"
                      variant="line"
                      disabled={isPending}
                      aria-label={`Set the daily limit for ${row.email}`}
                      onClick={() => {
                        setDialogError(undefined)
                        setLimitValue(String(row.apiLimitPerDay))
                        setLimitTarget(row)
                      }}
                    >
                      Limit
                    </Button>

                    {row.isSelf ? null : (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={isPending}
                        aria-label={`Delete ${row.email}`}
                        onClick={() => {
                          setDialogError(undefined)
                          setDeleteTarget(row)
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>

      {target ? (
        <ConfirmDialog
          open
          title={`${VERB_LABEL[target.verb]} ${target.row.email}?`}
          confirmLabel={VERB_LABEL[target.verb]}
          busy={isPending}
          error={failure ? `${failure.message} (${failure.code})` : undefined}
          onClose={() => setTarget(null)}
          onConfirm={() => run(target.verb, target.row)}
          body={<Consequence verb={target.verb} email={target.row.email} />}
        />
      ) : null}

      {limitTarget ? (
        <ConfirmDialog
          open
          title={`Daily limit for ${limitTarget.email}`}
          confirmLabel="Save limit"
          busy={isPending}
          error={dialogError}
          onClose={() => setLimitTarget(null)}
          onConfirm={() => saveLimit(limitTarget)}
          body={
            <div className="flex flex-col gap-3">
              <TextField
                label="Requests per day"
                type="number"
                inputMode="numeric"
                min={0}
                value={limitValue}
                onChange={(event) => setLimitValue(event.target.value)}
                hint="Counted across all of this account's endpoints and keys. 0 means unlimited."
              />
              {limitTarget.role === "owner" ? (
                <p className="text-[13px] text-dust">Owners are always unlimited, whatever is stored here.</p>
              ) : null}
            </div>
          }
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          open
          title={`Delete ${deleteTarget.email}?`}
          confirmLabel="Delete account"
          requireText={deleteTarget.email}
          busy={isPending}
          error={dialogError}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => removeUser(deleteTarget)}
          body={
            <div className="flex flex-col gap-3 text-[15px] leading-[1.6]">
              <p>
                This can&apos;t be undone. Their connections, spreadsheets, endpoints and API keys are removed, and
                every endpoint stops serving at once.
              </p>
              <p className="text-[13px] text-dust">
                Request logs stay, with the endpoint name and account email, until the retention window ends. An
                account that issued invitations can&apos;t be deleted.
              </p>
            </div>
          }
        />
      ) : null}
    </>
  )
}

/*
 * The words after a confirmed verb. `data` is the row the SERVICE stored — refreshed inside its own
 * transaction (`src/server/admin/users.ts:246`) — so an idempotent request, a user who was already
 * disabled, is reported as the no-op it was: that path returns `ok` and writes NO audit row
 * (`users.ts:238-241`), and the message says so instead of claiming a change.
 */
function outcome(row: AdminUserRowView, verb: Verb, data: UserMutationResult): string {
  if (verb === "disable" || verb === "enable") {
    if (row.status === data.status) {
      return `${data.email} was already ${data.status} — nothing was written, so no audit row exists.`
    }
    return `Stored: ${data.email} is ${data.status}. Change and \`user.${
      data.status === "disabled" ? "disable" : "enable"
    }\` audit row committed together.`
  }

  if (row.role === data.role) {
    return `${data.email} was already ${data.role} — nothing was written, so no audit row exists.`
  }
  return `Stored: ${data.email} is now ${data.role}. Audited as \`user.${
    data.role === "owner" ? "promote" : "demote"
  }\`.`
}

function Consequence({ verb, email }: { verb: Verb; email: string }) {
  if (verb === "disable") {
    return (
      <div className="flex flex-col gap-3 text-[15px] leading-[1.6]">
        <p>
          Console access ends on <strong className="text-paper">{email}’s</strong> very next request.
          Session verification re-reads{" "}
          <span className="font-mono text-[13px]">users.status</span> and returns nothing for a row
          that is not active, so the cookie stops working without waiting to expire and every
          dashboard and admin page sends them back to the login screen.
        </p>
        <p>
          Their endpoints stop serving too: every <span className="font-mono text-[13px]">/api/v1</span>{" "}
          call to them answers 404 until the account is enabled again.
        </p>
        <p className="text-[13px] text-dust">
          Reversible: enabling the row restores the session on the next request. Audited as{" "}
          <span className="font-mono text-[13px]">user.disable</span>.
        </p>
      </div>
    )
  }

  if (verb === "promote") {
    return (
      <div className="flex flex-col gap-3 text-[15px] leading-[1.6]">
        <p>
          <strong className="text-paper">{email}</strong> becomes an owner: this console, every
          account, and the power to issue and revoke invitation codes and to disable or demote other
          owners — including, one day, you.
        </p>
        <p className="text-[13px] text-dust">
          Their spreadsheets, endpoints and keys stay theirs. Audited as{" "}
          <span className="font-mono text-[13px]">user.promote</span>.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 text-[15px] leading-[1.6]">
      <p>
        <strong className="text-paper">{email}</strong> loses the owner role immediately: their next
        request re-reads the row from the database, so this console stops opening for them whatever
        their cookie claims. Their own spreadsheets, endpoints, keys and data are untouched.
      </p>
      <p className="text-[13px] text-dust">
        Refused if they are the last active owner, and refused for your own account. Audited as <span className="font-mono text-[13px]">user.demote</span>.
      </p>
    </div>
  )
}
