"use client"

/*
 * Row-level endpoint controls. The enable switch calls `toggleApiAction` → `toggleApi`
 * (`src/server/apis/service.ts:290`), optimistic locally and rolled back with the server's real
 * message on failure; the delete button calls `deleteApiAction` → `deleteApi` (`service.ts:280`)
 * behind a ConfirmDialog that names the endpoint, since deletion also drops its keys' access. The
 * actions run `revalidatePath`, so the list refreshes with the stored truth.
 */

import { useOptimistic, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/field"
import { ConfirmDialog } from "@/components/ui/dialog"
import { isActionError } from "@/lib/action-result"
import { deleteApiFormAction, toggleApiFormAction } from "@/app/(app)/apis/actions"

export function ApiRowControls({
  id,
  name,
  enabled,
  redirectAfterDelete,
}: {
  id: string
  name: string
  enabled: boolean
  /** When set (e.g. on the detail page), the client leaves this now-deleted route after success. */
  redirectAfterDelete?: string
}) {
  const router = useRouter()
  // Pending changes overlay the server prop; completion or failure restores its truth.
  const [isEnabled, setIsEnabled] = useOptimistic(enabled)
  const [pending, startTransition] = useTransition()
  const [toggleError, setToggleError] = useState<string | null>(null)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deletePending, startDelete] = useTransition()
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)

  const toggle = (next: boolean) => {
    setToggleError(null)
    startTransition(async () => {
      setIsEnabled(next)
      const result = await toggleApiFormAction(id, next)
      if (isActionError(result)) {
        setToggleError(`${result.error.message} (${result.error.code})`)
      }
    })
  }

  const remove = () => {
    setDeleteError(undefined)
    startDelete(async () => {
      const result = await deleteApiFormAction(id)
      if (isActionError(result)) {
        setDeleteError(`${result.error.message} (${result.error.code})`)
        return
      }
      setConfirmOpen(false)
      if (redirectAfterDelete) router.push(redirectAfterDelete)
    })
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        <div className="w-40">
          <Toggle
            label={isEnabled ? "Enabled" : "Disabled"}
            checked={isEnabled}
            onChange={toggle}
            disabled={pending}
          />
        </div>
        <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>
          Delete
        </Button>
      </div>
      {toggleError ? (
        <p role="alert" className="max-w-[26ch] text-right text-[12px] leading-[1.5] text-danger">
          {toggleError}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="Delete this endpoint?"
        confirmLabel="Delete endpoint"
        busy={deletePending}
        error={deleteError}
        onClose={() => setConfirmOpen(false)}
        onConfirm={remove}
        body={
          <div className="flex flex-col gap-2">
            <p>
              Deleting “{name}” stops its URL from serving data immediately. API keys scoped to it
              keep working for other endpoints, but any request to this endpoint returns not-found
              afterwards. This cannot be undone.
            </p>
          </div>
        }
      />
    </div>
  )
}
