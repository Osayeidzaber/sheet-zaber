import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"

/*
 * Session chrome: who you are, and the only honest way out. Sign-out is a form POST to
 * `/auth/logout` — a GET link would make the session droppable by any crawlable href
 * (docs/integration-status.md B3; the route itself is POST-only, src/app/auth/logout/route.ts:10).
 * The menu is a native <details>: no client JS, keyboard-operable, 44px targets.
 */

export type AccountMenuUser = { email: string; role: "user" | "owner" }

export function AccountMenu({
  user,
  placement = "up",
}: {
  user: AccountMenuUser
  /** Sidebar menus open upward; the mobile header menu opens downward. */
  placement?: "up" | "down"
}) {
  return (
    <details className="group relative">
      <summary
        className={cn(
          "flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-full border border-rule px-3 text-left transition-colors duration-(--dur-fast) hover:border-edge [&::-webkit-details-marker]:hidden",
          placement === "up" ? "w-full" : "max-w-[34vw]"
        )}
      >
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full border border-edge bg-lift font-mono text-[12px] text-mist"
        >
          {user.email.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-paper">{user.email}</span>
          <span className="folio block">{user.role === "owner" ? "Owner" : "Member"}</span>
        </span>
        <span aria-hidden="true" className="font-mono text-[11px] text-dust group-open:text-paper">
          ▾
        </span>
      </summary>

      <div
        className={cn(
          "absolute z-50 w-[264px] max-w-[calc(100vw-32px)] rounded-panel border border-edge bg-lift p-4 shadow-raised",
          placement === "up" ? "bottom-full left-0 mb-2" : "top-full right-0 mt-2"
        )}
      >
        <p className="folio">Signed in as</p>
        <p className="mt-1 break-all text-[14px] text-paper">{user.email}</p>
        <div className="mt-2">
          <Badge variant={user.role === "owner" ? "inverted" : "neutral"}>
            {user.role === "owner" ? "Owner" : "Member"}
          </Badge>
        </div>

        <div className="mt-4 flex flex-col gap-2 border-t border-rule pt-4">
          <Link
            href="/settings"
            className="flex min-h-11 items-center rounded-full px-2 text-[14px] text-mist transition-colors duration-(--dur-fast) hover:bg-raise hover:text-paper"
          >
            Account settings
          </Link>
          {/* Form POST only — see the header comment. */}
          <form action="/auth/logout" method="post">
            <Button type="submit" variant="danger" size="sm" className="w-full">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </details>
  )
}
