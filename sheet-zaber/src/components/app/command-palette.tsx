"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { DOCS_NAV } from "@/components/docs/docs-nav-data"
import { cn } from "@/lib/cn"

import { navItemsFor, type NavLinkRole } from "./nav"

/*
 * Ctrl/Cmd+K to jump anywhere. Navigation only: it reads no account data and performs no action,
 * so it needs no permission logic beyond the role the sidebar already receives. A native <dialog>
 * supplies the focus trap, Escape and the top layer, as in `ui/dialog.tsx`.
 */

type Command = { href: string; label: string; group: string; hint: string }

export function CommandPalette({ role, canInvite }: { role: NavLinkRole; canInvite?: boolean }) {
  const router = useRouter()
  const sheet = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)

  const commands = useMemo<Command[]>(
    () => [
      ...navItemsFor(role, canInvite).map((item) => ({ href: item.href, label: item.label, group: "Workspace", hint: item.hint })),
      ...DOCS_NAV.map((item) => ({ href: item.href, label: item.label, group: "Docs", hint: item.blurb })),
    ],
    [role, canInvite]
  )

  const needle = query.trim().toLowerCase()
  const matches = needle
    ? commands.filter((c) => `${c.group} ${c.label} ${c.hint}`.toLowerCase().includes(needle))
    : commands

  const show = useCallback(() => {
    setQuery("")
    setCursor(0)
    setOpen(true)
    sheet.current?.showModal()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        if (sheet.current?.open) sheet.current.close()
        else show()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [show])

  function go(command: Command | undefined) {
    if (!command) return
    sheet.current?.close()
    router.push(command.href)
  }

  function onInputKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (matches.length === 0) return
      const step = event.key === "ArrowDown" ? 1 : -1
      setCursor((current) => (current + step + matches.length) % matches.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      go(matches[cursor])
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-haspopup="dialog"
        className="inline-flex min-h-10 items-center gap-3 rounded-full border border-rule px-4 text-[13px] text-mist transition-colors duration-(--dur-fast) hover:border-edge hover:text-paper"
      >
        Jump to
        <span aria-hidden="true" className="kbd hidden sm:inline-flex">
          Ctrl K
        </span>
      </button>

      <dialog
        ref={sheet}
        aria-label="Jump to a page"
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === sheet.current) sheet.current?.close()
        }}
        className="m-auto mt-[12vh] w-[640px] max-w-[calc(100vw-32px)] rounded-card border border-edge bg-deep p-0 text-paper shadow-raised"
      >
        {open ? (
          <div className="flex max-h-[70vh] flex-col">
            <div className="border-b border-rule p-3">
              <input
                autoFocus
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setCursor(0)
                }}
                onKeyDown={onInputKey}
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-results"
                aria-activedescendant={matches[cursor] ? `palette-${matches[cursor].group}-${matches[cursor].href}` : undefined}
                aria-label="Search pages"
                placeholder="Search pages and docs"
                className="field border-transparent bg-transparent"
              />
            </div>
            <ul id="palette-results" role="listbox" aria-label="Pages" className="min-h-0 flex-1 overflow-y-auto p-2">
              {matches.map((command, index) => (
                <li
                  key={`${command.group}-${command.href}`}
                  id={`palette-${command.group}-${command.href}`}
                  role="option"
                  aria-selected={index === cursor}
                  onClick={() => go(command)}
                  onMouseMove={() => setCursor(index)}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-field px-3 py-2",
                    index === cursor && "bg-paper text-ink"
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold">{command.label}</span>
                    <span className={cn("block truncate text-[12px]", index === cursor ? "text-ink" : "text-dust")}>
                      {command.hint}
                    </span>
                  </span>
                  <span className={cn("folio shrink-0", index === cursor && "text-ink")}>{command.group}</span>
                </li>
              ))}
              {matches.length === 0 ? (
                <li role="presentation" className="px-3 py-6 text-center text-[13px] text-dust">
                  No page matches that.
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </dialog>
    </>
  )
}
