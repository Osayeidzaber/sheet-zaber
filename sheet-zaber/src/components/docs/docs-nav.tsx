"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { isCurrentSection, DOCS_NAV } from "@/components/docs/docs-nav-data"
import { cn } from "@/lib/cn"

/*
 * Persistent section navigation for /docs. It is a client component for exactly one reason:
 * the current-section indicator needs `usePathname()`. Everything it renders is a plain link,
 * so the island carries no data fetching and no state beyond the active match.
 *
 * Inversion (paper on ink) is the accent in this system, so the active item is filled rather
 * than tinted — the state is also carried by `aria-current` and by the "Now reading" caption,
 * never by colour alone.
 */

const SITE_LINKS = [
  { href: "/", label: "Landing" },
  { href: "/login", label: "Sign in" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
]

export function DocsNav({ className }: { className?: string }) {
  const pathname = usePathname()
  const current = DOCS_NAV.find((item) => isCurrentSection(item.href, pathname)) ?? DOCS_NAV[0]

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <nav aria-label="Documentation sections">
        <p className="folio">
          Now reading —{" "}
          <span className="folio-strong">
            {current.index} {current.label}
          </span>
        </p>

        <ol className="mt-3 flex flex-col gap-1">
          {DOCS_NAV.map((item) => {
            const isCurrent = item.href === current.href
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isCurrent ? "page" : undefined}
                  className={cn(
                    "flex items-baseline gap-3 rounded-field px-3 py-2 text-[14px] leading-[1.4] transition-colors duration-(--dur-fast)",
                    isCurrent
                      ? "bg-paper font-semibold text-ink"
                      : "text-mist hover:bg-lift hover:text-paper"
                  )}
                >
                  <span className={cn("folio shrink-0 num", isCurrent ? "text-ink" : "folio-strong")}>
                    {item.index}
                  </span>
                  {item.label}
                </Link>

                {/* Sub-anchors only for the section being read, so the rail stays a map of
                    where you are rather than a full sitemap. */}
                {isCurrent && item.anchors ? (
                  <ul className="mt-1 mb-2 flex flex-col gap-0.5 border-l border-rule pl-6">
                    {item.anchors.map((anchor) => (
                      <li key={anchor.id}>
                        <a
                          href={`#${anchor.id}`}
                          className="block py-1 font-mono text-[11px] tracking-[0.06em] text-dust uppercase transition-colors duration-(--dur-fast) hover:text-paper"
                        >
                          {anchor.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ol>
      </nav>

      <nav aria-label="Other pages" className="hairline-top pt-5">
        <p className="folio">Elsewhere</p>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          {SITE_LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="folio inline-flex min-h-9 items-center transition-colors duration-(--dur-fast) hover:text-paper"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
