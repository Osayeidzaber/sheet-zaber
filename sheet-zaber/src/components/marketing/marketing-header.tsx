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
  { href: "/#tab-title", label: "How it works" },
  { href: "/#faq-title", label: "Questions" },
  { href: "/docs", label: "Docs" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
]

/** The OZ Studio mark, from the portfolio's public/oz-studio/logo.svg. */
export function OzMark({ height = 18 }: { height?: number }) {
  return (
    <svg width={Math.round((height * 659.8) / 357.6)} height={height} viewBox="20 0.3 659.8 357.6" aria-hidden="true" className="shrink-0 text-paper">
      <path fill="currentColor" d="M20,181.7L23.5,145.6L31,120.9L38.5,103.8L53.7,79.1L67.6,62.6L82.8,47.8L101.8,33.2L130.3,17.4L149.3,9.8L191.1,0.7L225.3,0.3L242.4,2.5L265.2,8.1L288,17.3L310.8,30.7L331.7,47.8L345,62.4L358.1,81L331.1,120.9L317.9,147.5L312.7,162.5L304.2,138L296.2,122.8L284.4,107.6L270.9,95.3L257.6,86.4L240.5,78.6L225.3,74.9L204.4,72.8L183.5,75.1L164.5,80.4L149.3,87.7L132.2,99.7L120.8,111L109,126.6L101.3,141.8L95.7,160.8L93.6,185.5L95.7,202.6L99.3,215.9L110.6,238.7L126.5,258L147.4,273.5L170.2,283.1L196.8,287L223.4,284.9L236.7,281.2L259.5,269.9L274.7,258.6L290,242.5L305.5,215.9L323.8,157L340.4,122.8L354,101.9L373.2,77.2L392.5,55.9L415.3,34.9L679.6,35.4L679.8,37.3L661.3,60.1L598.3,134.2L476,269.1L479.9,270.3L654.7,270.6L654.7,349.1L321.1,348.9L325.3,341.3L355.8,303.3L522.4,113.3L525.2,109.5L523.6,108.6L375.4,108.9L383.4,136.1L387.4,158.9L387.6,191.2L383.7,214L378,233L362.7,265.3L351.3,282.4L339.3,296.6L322.2,313.1L307,324.7L288,336.4L272.8,343.5L250,351.6L232.9,355.3L193,357.9L166.4,355.1L151.2,351.6L128.4,343.7L113.2,336.2L84.7,316.9L61.1,293.8L48.3,276.7L38.4,259.6L30.9,242.5L23.2,215.9Z" />
    </svg>
  )
}

export function Wordmark({ href }: { href?: string }) {
  const label = (
    <span className="text-[15px] font-bold tracking-[-0.02em] whitespace-nowrap text-paper group-data-[collapsed=true]/side:sr-only">Sheet Zaber</span>
  )

  if (!href) {
    return (
      <span className="inline-flex items-center gap-2.5">
        <OzMark />
        {label}
      </span>
    )
  }

  return (
    <Link href={href} aria-label="Sheet Zaber, home" className="group inline-flex items-center gap-2.5">
      <OzMark />
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
