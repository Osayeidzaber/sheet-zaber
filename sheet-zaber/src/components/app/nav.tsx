"use client"

/*
 * Sidebar navigation. The active route gets the inversion treatment (paper field, ink
 * type) — the loudest non-destructive emphasis in the Black Press system. Items adapt to
 * the session role: `owner` additionally sees Admin. The role arrives as a plain string
 * prop from the server layout because this file may not import from `src/server/**`
 * (`server-only`); the literal union mirrors `SessionRole`.
 */

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/cn"

export type NavLinkRole = "user" | "owner"

export type NavItem = { index: string; href: string; label: string; hint: string }

const USER_ITEMS: readonly NavItem[] = [
  { index: "01", href: "/overview", label: "Overview", hint: "Traffic, setup and recent activity" },
  { index: "02", href: "/spreadsheets", label: "Spreadsheets", hint: "Registered workbooks" },
  { index: "03", href: "/apis", label: "Endpoints", hint: "API configurations" },
  { index: "04", href: "/keys", label: "Keys", hint: "API key inventory" },
  { index: "05", href: "/playground", label: "Playground", hint: "Send a live request" },
  { index: "06", href: "/logs", label: "Logs", hint: "Request log" },
  { index: "07", href: "/analytics", label: "Analytics", hint: "Traffic breakdown" },
  { index: "08", href: "/settings", label: "Settings", hint: "Account and connections" },
]

const OWNER_ITEMS: readonly NavItem[] = [
  { index: "A1", href: "/admin", label: "Admin", hint: "Users and invitations" },
]

export function navItemsFor(role: NavLinkRole): NavItem[] {
  return role === "owner" ? [...USER_ITEMS, ...OWNER_ITEMS] : [...USER_ITEMS]
}

/** Exact match or a nested route below it (`/apis/xyz` still highlights Endpoints). */
function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function Nav({
  role,
  onNavigate,
  className,
}: {
  role: NavLinkRole
  onNavigate?: () => void
  className?: string
}) {
  const pathname = usePathname()
  const items = navItemsFor(role)

  return (
    <nav aria-label="Sheet Zaber" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <p className="folio px-3 pb-1">Workspace</p>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const active = isCurrent(pathname, item.href)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 w-full items-center justify-between gap-3 rounded-full px-4 text-[14px] font-medium transition-colors duration-(--dur-fast)",
                  active ? "bg-paper text-ink hover:bg-press hover:text-ink" : "text-mist hover:bg-lift hover:text-paper"
                )}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" className={cn("font-mono text-[10px] tracking-[0.14em] num", active ? "text-ink" : "text-dust")}>
                    {item.index}
                  </span>
                  <span className="min-w-0 truncate">{item.label}</span>
                </span>
                {active ? (
                  <span aria-hidden="true" className="font-mono text-[10px] tracking-[0.14em]">
                    NOW
                  </span>
                ) : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
