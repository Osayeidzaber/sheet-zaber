"use client"

import { useEffect, useId, useRef, useState } from "react"

import { cn } from "@/lib/cn"
import { Button } from "./button"
import { TextField } from "./field"

/**
 * Native <dialog>: focus trapping, Escape and top-layer stacking come from the browser,
 * which is why this system installs no modal library.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = "md",
}: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  size?: "sm" | "md" | "lg"
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  const width = size === "sm" ? "sm:max-w-md" : size === "lg" ? "sm:max-w-3xl" : "sm:max-w-xl"

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        if (open) onClose()
      }}
      className={cn(
        "m-auto w-[calc(100vw-32px)] rounded-card border border-edge bg-deep p-0 text-paper",
        width
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[18px] font-semibold tracking-[-0.02em]">
            {title}
          </h2>
          {description ? <p className="mt-1 text-[13px] text-dust">{description}</p> : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog" className="px-2">
          ×
        </Button>
      </div>

      <div className="max-h-[min(70vh,640px)] overflow-y-auto px-5 py-5">{children}</div>

      {footer ? (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-rule px-5 py-4">
          {footer}
        </div>
      ) : null}
    </dialog>
  )
}

/**
 * Destructive confirmations ask for the object's name, not just a click: a revoked API
 * key or a deleted endpoint is not recoverable, and the sheet title is the thing the
 * user actually recognises.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  requireText,
  busy = false,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  body: React.ReactNode
  confirmLabel: string
  requireText?: string
  busy?: boolean
  error?: string
  onConfirm: () => void
  onClose: () => void
}) {
  const [typed, setTyped] = useState("")
  const [lastOpen, setLastOpen] = useState(open)

  // A render-phase state adjustment rather than an effect, because `Dialog` never unmounts — the
  // native <dialog> stays in the tree so showModal()/close() can be driven from the `open` prop —
  // so the typed text has to be cleared when a session ends. Resetting only inside `onClose` would
  // leave the gate OPEN after a parent-driven close, which for a destructive confirm means the next
  // open sits one click away from firing.
  if (lastOpen !== open) {
    setLastOpen(open)
    if (!open) setTyped("")
  }

  // `requireText` is a gate, not a caption: the confirm button stays dead until it matches.
  const gated = requireText !== undefined && typed !== requireText

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy} disabled={gated}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="text-[15px] leading-[1.6] text-mist">{body}</div>
        {error ? (
          <p role="alert" className="text-[13px] text-paper">
            ⚠ {error}
          </p>
        ) : null}
        {requireText !== undefined ? (
          <TextField
            label={`Type “${requireText}” to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            className="font-mono"
          />
        ) : null}
      </div>
    </Dialog>
  )
}
