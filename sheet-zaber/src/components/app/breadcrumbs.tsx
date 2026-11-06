"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const LABELS: Record<string, string> = {
  overview: "Overview",
  spreadsheets: "Spreadsheets",
  apis: "Endpoints",
  keys: "Keys",
  playground: "Playground",
  logs: "Logs",
  analytics: "Analytics",
  settings: "Settings",
  admin: "Admin",
  users: "Users",
  invitations: "Invitations",
  invites: "Invites",
  new: "New",
  edit: "Edit",
}

/** Where you are, from the path alone. Record ids are not names, so they read as "Detail". */
export function Breadcrumbs() {
  const segments = usePathname().split("/").filter(Boolean)

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="folio flex flex-wrap items-center gap-x-2 gap-y-1">
        {segments.map((segment, index) => {
          const href = `/${segments.slice(0, index + 1).join("/")}`
          const label = LABELS[segment] ?? "Detail"
          const last = index === segments.length - 1
          return (
            <li key={href} className="flex items-center gap-2">
              {index > 0 ? <span aria-hidden="true">/</span> : null}
              {last ? (
                <span aria-current="page" className="folio-strong">
                  {label}
                </span>
              ) : (
                <Link href={href} className="inline-flex min-h-6 items-center transition-colors duration-(--dur-fast) hover:text-paper">
                  {label}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
