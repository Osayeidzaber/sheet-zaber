"use client"

import { useCallback, useEffect, useSyncExternalStore } from "react"

import { cn } from "@/lib/cn"

/*
 * The desktop sidebar's frame: full width or a narrow rail, remembered per browser. Ctrl/Cmd+B toggles
 * it. Children react through the `side` group's data-collapsed attribute, so they stay server-rendered.
 */

const KEY = "sz-sidebar-collapsed"
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function SidebarShell({ children }: { children: React.ReactNode }) {
  const collapsed = useSyncExternalStore(subscribe, read, () => false)

  const toggle = useCallback(() => {
    try {
      localStorage.setItem(KEY, read() ? "0" : "1")
    } catch {
      return
    }
    listeners.forEach((listener) => listener())
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle])

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "group/side sticky top-0 hidden h-screen shrink-0 flex-col gap-6 border-r border-rule px-3 py-6 transition-[width] duration-(--dur-base) ease-(--ease-press) lg:flex",
        collapsed ? "w-[76px]" : "w-[264px]"
      )}
    >
      {children}
      <button
        type="button"
        onClick={toggle}
        aria-pressed={collapsed}
        aria-label="Collapse sidebar"
        title="Ctrl B"
        className="folio flex min-h-10 items-center justify-center gap-2 rounded-full border border-rule transition-colors duration-(--dur-fast) hover:border-edge hover:text-paper"
      >
        <span aria-hidden="true">{collapsed ? "→" : "←"}</span>
        {collapsed ? null : <span aria-hidden="true">Collapse</span>}
      </button>
    </aside>
  )
}
