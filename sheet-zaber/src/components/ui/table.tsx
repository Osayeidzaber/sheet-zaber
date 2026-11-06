import { cn } from "@/lib/cn"

/*
 * Real <table> markup, because logs and key inventories are tabular data. Structure comes
 * from hairlines only: no header fill, no zebra striping, no rounded cells.
 */

/** Wide tables scroll horizontally as a keyboard-reachable region. */
export function TableScroll({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={label}
      className={cn("scroll-shadow max-w-full overflow-x-auto focus-visible:outline-offset-[-1px]", className)}
    >
      {children}
    </div>
  )
}

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <table className={cn("w-full min-w-[680px] border-collapse text-left", className)}>
      {children}
    </table>
  )
}

export function Th({
  children,
  className,
  scope = "col",
  align = "left",
}: {
  children?: React.ReactNode
  className?: string
  scope?: "col" | "row"
  align?: "left" | "right"
}) {
  return (
    <th
      scope={scope}
      className={cn(
        "border-b border-rule px-4 py-3 align-middle font-normal whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
        className
      )}
    >
      <span className="folio">{children}</span>
    </th>
  )
}

export function Tr({
  children,
  className,
  interactive = false,
}: {
  children: React.ReactNode
  className?: string
  interactive?: boolean
}) {
  return (
    <tr
      className={cn(
        "border-b border-rule last:border-b-0",
        interactive && "transition-colors duration-(--dur-fast) hover:bg-lift",
        className
      )}
    >
      {children}
    </tr>
  )
}

export function Td({
  children,
  className,
  align = "left",
  numeric = false,
  title,
}: {
  children?: React.ReactNode
  title?: string
  className?: string
  align?: "left" | "right"
  numeric?: boolean
}) {
  return (
    <td title={title}
      className={cn(
        "px-4 py-3 align-middle text-[14px] text-mist",
        numeric && "text-right num",
        align === "right" && !numeric && "text-right",
        className
      )}
    >
      {children}
    </td>
  )
}

/** A cell that must never wrap or reflow: ids, hashes, previews. */
export function MonoCell({ value, title }: { value: string; title?: string }) {
  return (
    <span title={title ?? value} className="block max-w-[180px] truncate font-mono text-[12px] text-dust">
      {value}
    </span>
  )
}

/**
 * Link-based pagination: no client state, works with the filter query string, and is
 * crawlable by the browser's back button.
 */
export function Pagination({
  page,
  totalPages,
  totalRows,
  buildHref,
}: {
  page: number
  totalPages: number
  totalRows: number
  buildHref: (page: number) => string
}) {
  if (totalPages <= 1) {
    return (
      <p className="border-t border-rule px-4 py-4 font-mono text-[12px] text-dust">
        {totalRows} {totalRows === 1 ? "row" : "rows"}
      </p>
    )
  }

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-4 border-t border-rule px-4 py-4"
    >
      <p className="font-mono text-[12px] text-dust num">
        Page {page} of {totalPages} · {totalRows} rows
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <a href={buildHref(page - 1)} className="pill pill-line min-h-10 px-4 text-[14px]">
            ← Previous
          </a>
        ) : null}
        {page < totalPages ? (
          <a href={buildHref(page + 1)} className="pill pill-line min-h-10 px-4 text-[14px]">
            Next →
          </a>
        ) : null}
      </div>
    </nav>
  )
}
