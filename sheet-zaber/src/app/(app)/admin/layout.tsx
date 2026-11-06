import { requireOwner } from "@/server/auth/guards"

import { AdminNav } from "./admin-nav"

/*
 * THE gate for the whole owner console.
 *
 * `requireOwner()` (`src/server/auth/guards.ts:73`) is the only check this tree needs: it verifies
 * the `sz_session` cookie, re-reads the `users` row (so the DATABASE role wins over the cookie role
 * and a signed cookie claiming `owner` on a `user` row cannot escalate — `guards.ts:51-55`), and
 * redirects: no session → `/login`, session but not owner → `/overview`. A layout covers every child
 * route, which is why the gate lives here rather than in each page.
 *
 * It is NOT the guard for mutations. `docs/architecture.md:59/139` is explicit that the proxy is UX
 * only, and a Server Action POST is not a page navigation — so every action in `./actions.ts`
 * re-establishes the actor itself and fails closed with an `ActionError`. Nothing in this file makes
 * that safe; the actions do.
 */

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const owner = await requireOwner()

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 border-b border-rule pb-4">
        <AdminNav />
        <p className="font-mono text-[12px] leading-[1.6] text-dust">
          Console session: <span className="text-paper">{owner.email}</span> — role read from the
          database row on this request, not from the cookie.
        </p>
      </div>

      {children}
    </div>
  )
}
