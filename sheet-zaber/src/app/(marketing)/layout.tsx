import { MarketingFooter } from "@/components/marketing/marketing-footer"
import { MarketingHeader } from "@/components/marketing/marketing-header"

/*
 * Layout for the public surface (docs/architecture.md §7: `(marketing)` is the public route
 * group). Landmarks only — no state, no client JavaScript: the header and footer are server
 * components, so an anonymous visitor downloads markup, not a bundle.
 *
 * Public pages are indexable through the root layout's metadata; the private surfaces opt out.
 */
export default function MarketingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col bg-ink text-paper">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <MarketingHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <MarketingFooter />
    </div>
  )
}
