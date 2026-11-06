"use client"

/*
 * The owner-console sub-nav. Three sections, one bar: it lives in the admin layout so every
 * admin route carries the same controls, and it marks the current section with `aria-current`
 * plus the inversion treatment — the same emphasis the sidebar `Nav` uses, so the two never
 * disagree about where the owner is.
 *
 * `/admin` itself is an INDEX, not a prefix: an exact match is the only thing that may mark it
 * current, or every admin child route would light up "Platform" as well.
 */

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/cn"

export type AdminSection = { href: string; label: string; hint: string }

const SECTIONS: readonly AdminSection[] = [
  { href: "/admin", label: "Platform", hint: "Totals and owner actions" },
  { href: "/admin/users", label: "Users", hint: "Roles, status, disabling" },
  { href: "/admin/invitations", label: "Invitations", hint: "Issue and revoke codes" },
]

function isCurrent(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin"
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AdminNav({ className }: { className?: string }) {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Admin sections"
      className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}
    >
      <p className="folio mr-2 hidden sm:block">Owner console</p>
      <ul className="flex min-w-0 flex-wrap items-center gap-2">
        {SECTIONS.map((section) => {
          const current = isCurrent(pathname, section.href)
          return (
            <li key={section.href}>
              <Link
                href={section.href}
                title={section.hint}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center gap-2 rounded-field border px-4 text-[14px] font-medium transition-colors duration-(--dur-fast)",
                  current
                    ? "border-paper bg-paper text-ink hover:border-press hover:bg-press hover:text-ink"
                    : "border-edge text-mist hover:border-paper hover:text-paper"
                )}
              >
                <span className="whitespace-nowrap">{section.label}</span>
                {current ? (
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
