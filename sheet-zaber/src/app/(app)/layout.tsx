import type { Metadata } from "next"
import Link from "next/link"
import { AccountMenu } from "@/components/app/account-menu"
import { Breadcrumbs } from "@/components/app/breadcrumbs"
import { CommandPalette } from "@/components/app/command-palette"
import { Wordmark } from "@/components/marketing/marketing-header"
import { MobileNav } from "@/components/app/mobile-nav"
import { Nav } from "@/components/app/nav"
import { SessionBanner } from "@/components/app/session-banner"
import { isActionError } from "@/lib/action-result"
import { listConnectionsAction } from "@/server/actions/connections"
import { requireUser } from "@/server/auth/guards"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { robots: { index: false, follow: false } }

/*
 * The authenticated shell. Server component: `requireUser()` guards every page in the
 * group (redirecting to /login server-side), and the connection list is read here so the
 * reauth banner appears on every app page (docs/integration-status.md Q-B3). Desktop is a
 * fixed left sidebar; below `lg` it collapses to the header + `<dialog>` drawer.
 *
 * The read goes through `listConnectionsAction`, not `src/server/google/connections`: nothing
 * under `(app)/` reaches into the Google module directly (docs/integration-status.md Q(a)), and
 * that action re-establishes the session itself, so the banner cannot be primed by a forged prop.
 */

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  const connectionsResult = await listConnectionsAction()
  // A failed read must not block the shell; the banner is an extra, not a gate.
  const connections = isActionError(connectionsResult) ? [] : connectionsResult.data

  return (
    <div className="min-h-screen bg-ink text-paper">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <div className="mx-auto flex min-h-screen w-full max-w-[1720px]">
        <aside className="sticky top-0 hidden h-screen w-[264px] shrink-0 flex-col gap-6 border-r border-rule px-4 py-6 lg:flex">
          <div className="px-2">
            <Wordmark href="/overview" />
          </div>
          <Nav role={user.role} className="min-h-0 flex-1 overflow-y-auto" />
          <AccountMenu user={{ email: user.email, role: user.role }} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-rule bg-ink/95 px-4 py-3 backdrop-blur-sm lg:hidden">
            <MobileNav role={user.role} />
            <Wordmark href="/overview" />
            <div className="min-w-0 shrink-0">
              <AccountMenu user={{ email: user.email, role: user.role }} placement="down" />
            </div>
          </header>

          <div className="z-30 flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-ink/95 px-4 py-2 backdrop-blur-sm lg:sticky lg:top-0 lg:px-6">
            <Breadcrumbs />
            <div className="flex items-center gap-2">
              <CommandPalette role={user.role} />
              <Link href="/docs" className="folio hidden min-h-10 items-center px-2 transition-colors duration-(--dur-fast) hover:text-paper sm:inline-flex">
                Docs ↗
              </Link>
            </div>
          </div>

          <div className="min-w-0 px-4 pt-4 empty:hidden lg:px-6">
            <SessionBanner connections={connections} />
          </div>

          <main id="main" className="stagger-page min-w-0 flex-1 px-4 py-6 lg:px-6 lg:py-8">
            {children}
          </main>

          <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-rule px-4 py-4 text-[13px] text-dust lg:px-6">
            <p>© {new Date().getFullYear()} Osayeed Zaber</p>
            <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-1">
              <Link href="/docs" className="hover:text-paper">Documentation</Link>
              <Link href="/privacy" className="hover:text-paper">Privacy</Link>
              <Link href="/terms" className="hover:text-paper">Terms</Link>
              <a href="mailto:support@zaber.tech" className="hover:text-paper">Support</a>
            </nav>
          </footer>
        </div>
      </div>
    </div>
  )
}
