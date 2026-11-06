import type { Metadata } from "next"

import { DocsNav } from "@/components/docs/docs-nav"
import { ShinyText } from "@/components/fx/shiny-text"
import { GridPattern } from "@/components/fx/pattern"

/*
 * Shell for the public API documentation. It renders inside the `(marketing)` layout's landmarks
 * (skip link, MarketingHeader, <main id="main">, MarketingFooter), so this file adds no <header>,
 * no <main> and no second page frame: just a hero strip, the persistent section rail and the
 * content column.
 *
 * The rail is sticky from `lg` up and plain flow below it, which is what "native scroll on mobile"
 * means here — no drawer, no client-side toggle, nothing that can be broken. The skip link targets
 * the content column so a keyboard visitor does not have to walk the whole rail to reach the page
 * they came for; it sits below the site-wide skip link so the two never overlap when focused.
 */
export const metadata: Metadata = { title: { default: "API documentation", template: "%s | Sheet Zaber API docs" } }

export default function DocsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <a href="#docs-content" className="skip-link focus-visible:top-16">
        Skip to documentation
      </a>

      {/* Decorative band: GridPattern ships no keyframes, fills with the `rule` hairline token and
          is aria-hidden + pointer-events-none by construction. ShinyText sweeps once on pointer
          enter, rests at --mist under prefers-reduced-motion, and repeats text that is already
          plain in the DOM — nothing here is the only carrier of information. */}
      <section aria-label="API documentation" className="relative overflow-hidden border-b border-rule">
        <GridPattern width={40} height={40} squares={[[3, 1], [11, 2]]} />
        <div className="gutter relative flex w-full flex-wrap items-end justify-between gap-x-10 gap-y-4 py-8">
          <div className="min-w-0">
            <p className="folio folio-strong">Sheet Zaber · Reference</p>
            <ShinyText
              className="display mt-3 block text-[clamp(26px,4.4vw,44px)]"
              color="var(--mist)"
              shineColor="var(--press)"
            >
              /api/v1 documentation
            </ShinyText>
          </div>
          <p className="max-w-[46ch] text-[13px] leading-[1.65] text-dust">
            The contract in <code className="inline">docs/backend-api-contract.md</code> §1, rendered
            from the same snippet builders the playground uses. Private platform, public
            documentation — no signup on these pages.
          </p>
        </div>
      </section>

      <div className="gutter w-full py-[clamp(32px,5vw,64px)]">
        <div className="grid min-w-0 gap-10 lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-14">
          <aside className="min-w-0 self-start lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-3">
            <DocsNav />
          </aside>
          <div id="docs-content" tabIndex={-1} className="min-w-0 focus-visible:outline-none">
            {children}
          </div>
        </div>
      </div>
    </>
  )
}
