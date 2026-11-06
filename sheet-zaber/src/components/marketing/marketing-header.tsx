import Link from "next/link"

import { PillLink } from "@/components/ui/button"

/*
 * Site navigation for the public surface. Server component on purpose: every link here is a
 * plain href, so the top bar ships no JavaScript. `PillLink` is a client component, but it is
 * *rendered* (not called), which is the legal way to use it from the server — see the note on
 * `pillClass` in ui/button.tsx: calling that helper from a server component would throw.
 *
 * 375px layout: wordmark + "Sign in" on the first line, the three nav links wrap onto a second
 * line (order-3 + w-full); from `sm` up everything shares one row.
 */

const NAV_LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
]

/** The house glyph: a sheet of rows with a route through it (same figure the fx plate uses). */
function SheetMark() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0 text-paper">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 3.5h16v17H4z" strokeWidth="1.6" />
        <path d="M4 9h16M4 14.5h16" strokeWidth="1.1" />
        <path d="M10.4 11.1l2.6 1.9-2.6 1.9" strokeWidth="1.7" />
      </g>
    </svg>
  )
}

export function Wordmark({ href }: { href?: string }) {
  const label = (
    <span className="text-[15px] font-bold tracking-[-0.02em] whitespace-nowrap text-paper">Sheet Zaber</span>
  )

  if (!href) {
    return (
      <span className="inline-flex items-center gap-2.5">
        <SheetMark />
        {label}
      </span>
    )
  }

  return (
    <Link href={href} aria-label="Sheet Zaber, home" className="group inline-flex items-center gap-2.5">
      <SheetMark />
      {label}
    </Link>
  )
}

export function MarketingHeader() {
  return (
    <header className="relative top-0 z-40 border-b border-rule bg-ink/95 backdrop-blur-sm sm:sticky">
      <div className="gutter w-full">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
          <Wordmark href="/" />

          {/* The real sign-in entry point. It lands on `/login` rather than on `/auth/google`
              because that page is what renders the auth error states and tells an invitation-only
              visitor what happens next (`docs/integration-status.md` B1, B2); `/login` then supplies
              the `/auth/google` link itself, and only when the OAuth credentials are configured. */}
          <PillLink href="/login" variant="solid" size="sm" className="order-2 sm:order-last">
            Sign in <span aria-hidden="true">↗</span>
          </PillLink>

          <nav aria-label="Site" className="order-3 w-full sm:order-none sm:mr-5 sm:ml-auto sm:w-auto">
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-1">
              {NAV_LINKS.map((link) => (
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
      </div>
      <span aria-hidden="true" className="read-progress absolute inset-x-0 -bottom-px block h-px origin-left scale-x-0 bg-paper" />
    </header>
  )
}
