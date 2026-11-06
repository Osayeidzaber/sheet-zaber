"use client"

/*
 * Mobile navigation: a native <dialog> shown as a left sheet. Focus trapping, Escape and
 * the top layer come from the browser (the same reason `ui/dialog.tsx` installs no modal
 * library). All targets are 44px+ so the drawer is usable at 375px.
 */

import { useRef } from "react"

import { Nav, type NavLinkRole } from "./nav"

export function MobileNav({ role }: { role: NavLinkRole }) {
  const sheet = useRef<HTMLDialogElement>(null)

  return (
    <>
      <button
        type="button"
        onClick={() => sheet.current?.showModal()}
        aria-haspopup="dialog"
        aria-label="Open navigation menu"
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full border border-edge px-3 text-[14px] text-paper transition-colors duration-(--dur-fast) hover:border-paper"
      >
        <span aria-hidden="true" className="font-mono text-[16px] leading-none">
          ≡
        </span>
        Menu
      </button>

      <dialog
        ref={sheet}
        aria-label="Navigation"
        className="m-0 h-full max-h-none w-[320px] max-w-[min(320px,88vw)] border-r border-rule bg-deep p-0 text-paper open:flex open:flex-col"
      >
        <div className="flex items-center justify-between gap-4 border-b border-rule px-5 py-4">
          <p className="folio folio-strong">Sheet Zaber</p>
          <button
            type="button"
            onClick={() => sheet.current?.close()}
            aria-label="Close navigation"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-[18px] text-dust transition-colors duration-(--dur-fast) hover:bg-lift hover:text-paper"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <Nav role={role} onNavigate={() => sheet.current?.close()} />
        </div>
      </dialog>
    </>
  )
}
