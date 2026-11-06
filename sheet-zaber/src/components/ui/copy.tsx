"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"

type CopyState = "idle" | "copied" | "failed"

const RESET_MS = 2000

async function writeClipboard(value: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

/** Copy affordance shared by keys, endpoint URLs and code snippets. Never claims success it did not get. */
export function useCopy(value: string) {
  const [state, setState] = useState<CopyState>("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)

  useEffect(
    () => () => {
      mounted.current = false
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback(async () => {
    const succeeded = await writeClipboard(value)
    if (!mounted.current) return succeeded
    setState(succeeded ? "copied" : "failed")
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState("idle"), RESET_MS)
    return succeeded
  }, [value])

  return { state, copy }
}

export function CopyButton({
  value,
  label = "Copy",
  size = "sm",
  variant = "line",
  className,
}: {
  value: string
  label?: string
  size?: "sm" | "md" | "lg"
  variant?: "solid" | "line" | "ghost"
  className?: string
}) {
  const { state, copy } = useCopy(value)

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Button type="button" size={size} variant={variant} onClick={() => void copy()}>
        {state === "copied" ? "Copied" : state === "failed" ? "Try again" : label}
      </Button>
      <span aria-live="polite" className="folio">
        {state === "copied" ? "on the clipboard" : state === "failed" ? "copy blocked" : ""}
      </span>
    </span>
  )
}

/** Read-only field that selects its whole value on focus — for a key shown once or a live endpoint URL. */
export function CopyField({
  value,
  label,
  revealOnce = false,
  className,
}: {
  value: string
  label: string
  revealOnce?: boolean
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const select = () => {
    inputRef.current?.select()
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="folio">{label}</span>
      <div className="flex items-stretch gap-2">
        <input
          ref={inputRef}
          readOnly
          value={value}
          aria-label={label}
          onFocus={select}
          onClick={select}
          className="field min-w-0 flex-1 font-mono text-[13px]"
        />
        <CopyButton value={value} label={revealOnce ? "Copy now" : "Copy"} />
      </div>
      {revealOnce ? (
        <p className="text-[13px] text-mist">
          This is the only time the full value is shown. Copy it now — afterwards only the preview
          remains.
        </p>
      ) : null}
    </div>
  )
}
