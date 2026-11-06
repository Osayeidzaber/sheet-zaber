import type { ReactNode } from "react"

import { cn } from "@/lib/cn"

/*
 * The portfolio's chapter vocabulary, shared so the two products read as one developer's work.
 * Server components with no state: the motion lives in globals.css.
 */

/** The row every chapter opens with: `NN — Name` on the left, context on the right. */
export function Folio({
  children,
  aside,
  className,
}: {
  children: ReactNode
  aside?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("folio flex flex-wrap justify-between gap-3 border-t border-rule pt-4", className)}>
      <span>{children}</span>
      {aside ? <span>{aside}</span> : null}
    </div>
  )
}

/** Italic serif emphasis inside a display heading: "The *ledger*". */
export function TitleAside({ children }: { children: ReactNode }) {
  return <span className="aside text-mist">{children}</span>
}

/**
 * Concentric hairlines. Purely decorative, so the parent must be `relative overflow-hidden`.
 * `at` positions the centre as CSS percentages; `sizes` are diameters in pixels.
 */
export function Rings({
  at = ["50%", "52%"],
  sizes = [1400, 1120, 840, 560],
  className,
}: {
  at?: [string, string]
  sizes?: number[]
  className?: string
}) {
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      {sizes.map((size) => (
        <span key={size} className="ring-line" style={{ left: at[0], top: at[1], width: size, height: size }} />
      ))}
    </div>
  )
}
