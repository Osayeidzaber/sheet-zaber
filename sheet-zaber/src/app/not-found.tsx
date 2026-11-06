import Link from "next/link"

import { GlitchText } from "@/components/fx/glitch-text"
import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"
import { PillLink } from "@/components/ui/button"
import { Rings } from "@/components/ui/chapter"

/*
 * Unmatched routes render here, under the root layout only — so this file repeats the shell
 * (skip link, header, main, footer) that `(marketing)/layout.tsx` normally supplies, otherwise
 * the error page would have no landmarks at all.
 *
 * The giant "404" is `GlitchText`, which has one job: to be the page's single piece of type, and
 * to glitch only when a pointer asks it to (`trigger="hover"` is the component default; the
 * endless-seizure `always` mode is deliberately not used). Under `prefers-reduced-motion` the
 * engine refuses to run and glitch-text.css pins the glyph at full opacity, so the number still
 * reads as a number.
 *
 * It cannot live inside the `<h1>`: GlitchText's root is a `<div>`, and a div inside a heading is
 * invalid HTML. So the numeral is decorative and `aria-hidden`, and the real heading sits beneath
 * it carrying the same meaning in words — no heading is lost, and no screen reader hears doubled
 * digits.
 */

const PUBLIC_PAGES = [
  {
    href: "/",
    label: "Landing",
    note: "What the platform is, in one page, with the sign-in door.",
  },
  {
    href: "/docs",
    label: "Docs",
    note: "The API contract: endpoints, parameters, envelopes, error codes.",
  },
  {
    href: "/privacy",
    label: "Privacy",
    note: "Every stored field, named down to the column, and what is never stored.",
  },
  {
    href: "/terms",
    label: "Terms",
    note: "Invitation rules, limits, and what a refusal looks like.",
  },
]

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-ink text-paper">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <MarketingHeader />

      <main id="main" className="relative flex-1 overflow-hidden">
        <Rings at={["82%", "34%"]} />
        <div className="pad-page relative mx-auto w-full max-w-[820px] py-[clamp(48px,8vw,104px)]">
          <p className="folio">Error 404</p>

          {/* Decorative numeral: the heading below says the same thing in words. */}
          <div aria-hidden="true" className="reveal mt-6 text-paper">
            <GlitchText trigger="hover" mode="slices" className="display">
              404
            </GlitchText>
          </div>

          <h1 className="display mt-7 text-[clamp(28px,5.5vw,46px)] text-paper">
            There is no page at this address
          </h1>

          <p className="mt-5 max-w-[62ch] text-[15px] leading-[1.75] text-mist">
            Nothing in this project is served here. The dashboard and{" "}
            <code className="inline">/api/v1</code> sit behind a Google sign-in and an API key, so
            they are not reachable by typing an address into a browser from the outside — and the
            public surface is only the four pages below. If you followed a link from somewhere that
            should have known better, the link is wrong, not your data.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <PillLink href="/" variant="solid">
              Back to the landing page
            </PillLink>
            <PillLink href="/docs" variant="line">
              Read the API docs
            </PillLink>
          </div>

          <nav aria-label="Public pages" className="hairline-top mt-12 pt-7">
            <p className="folio">Public pages</p>
            <ul className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
              {PUBLIC_PAGES.map((page) => (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    className="group block rounded-panel border border-rule px-4 py-3 transition-colors duration-(--dur-fast) hover:border-edge hover:bg-lift"
                  >
                    <span className="folio folio-strong flex items-baseline justify-between gap-3">
                      {page.label}
                      <span className="num text-dust group-hover:text-mist">{page.href}</span>
                    </span>
                    <span className="mt-2 block text-[14px] leading-[1.6] text-mist">{page.note}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </main>

      <MarketingFooter />
    </div>
  )
}
