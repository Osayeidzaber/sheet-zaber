"use client"

/*
 * Detail-page mutations for one spreadsheet, each wired to a real action with pending state and
 * honest feedback:
 *   - `RefreshTabsButton` → `refreshSpreadsheetTabsFormAction` (`service.ts:320`): re-runs
 *     `spreadsheets.get` and re-snapshots the tabs. A 403/404 marks the row `inaccessible` and
 *     returns `google_sheet_inaccessible`; a dead grant returns `google_reauth_required`, for which
 *     we link to the real re-consent entry (/auth/google/connect) rather than inventing a retry.
 *   - `RemoveSpreadsheetButton` → `removeSpreadsheetFormAction` (`service.ts:436`) behind a ConfirmDialog
 *     that names the sheet, because the delete cascades the user's APIs (`service.ts:432`).
 * `revalidatePath` runs inside the actions; on remove success the client navigates back to the list,
 * since this row no longer exists.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button, PillLink } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/dialog"
import { isActionError } from "@/lib/action-result"
import {
  refreshSpreadsheetTabsFormAction,
  removeSpreadsheetFormAction,
} from "@/app/(app)/spreadsheets/actions"

export function RefreshTabsButton({ spreadsheetId }: { spreadsheetId: string }) {
  const [isPending, startTransition] = useTransition()
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string; code?: string } | null>(null)

  const refresh = () => {
    setFeedback(null)
    startTransition(async () => {
      const result = await refreshSpreadsheetTabsFormAction(spreadsheetId)
      if (isActionError(result)) {
        setFeedback({ kind: "error", text: result.error.message, code: result.error.code })
      } else {
        setFeedback({ kind: "ok", text: `Refreshed ${result.data.tabs.length} ${result.data.tabs.length === 1 ? "tab" : "tabs"}.` })
      }
    })
  }

  const needsReconnect = feedback?.code === "google_reauth_required"

  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="line" size="sm" onClick={refresh} loading={isPending}>
        {isPending ? "Refreshing tabs…" : "Refresh tabs"}
      </Button>
      {feedback ? (
        <p
          role={feedback.kind === "error" ? "alert" : "status"}
          className="flex flex-wrap items-center gap-2 text-[13px] leading-[1.6] text-dust"
        >
          {feedback.kind === "error" ? "⚠ " : ""}
          <span className={feedback.kind === "error" ? "text-paper" : undefined}>{feedback.text}</span>
          {feedback.code ? (
            <span className="font-mono text-[11px] tracking-[0.08em] text-dust uppercase">{feedback.code}</span>
          ) : null}
          {needsReconnect ? (
            <PillLink href="/auth/google/connect" variant="line" size="sm">
              Reconnect Google
            </PillLink>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}

export function RemoveSpreadsheetButton({
  spreadsheetId,
  title,
}: {
  spreadsheetId: string
  title: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | undefined>(undefined)

  const remove = () => {
    setError(undefined)
    startTransition(async () => {
      const result = await removeSpreadsheetFormAction(spreadsheetId)
      if (isActionError(result)) {
        setError(`${result.error.message} (${result.error.code})`)
        return
      }
      router.push("/spreadsheets")
    })
  }

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        Remove spreadsheet
      </Button>
      <ConfirmDialog
        open={open}
        title="Remove this spreadsheet?"
        confirmLabel="Remove and disconnect"
        busy={isPending}
        error={error}
        onClose={() => setOpen(false)}
        onConfirm={remove}
        body={
          <div className="flex flex-col gap-2">
            <p>
              Sheet Zaber will stop reading “{title}” and delete its stored tab snapshot. Every
              endpoint built on this spreadsheet is removed with it (the database cascades them), so
              any key calling those endpoints starts returning not-found.
            </p>
            <p className="text-[13px] text-dust">
              Your Google Sheet and your Google connection are untouched — this only disconnects the
              spreadsheet from Sheet Zaber. You can reconnect it later.
            </p>
          </div>
        }
      />
    </>
  )
}
