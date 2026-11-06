import { CountUp } from "@/components/ui/count-up"
import { cn } from "@/lib/cn"

export type Stat = {
  label: string
  value: string
  sub?: string
  /** The only colour a figure may carry, for a number saying that something is broken. */
  tone?: "neutral" | "failed"
}

/**
 * A row of figures divided by hairlines rather than boxed into cards, after the portfolio's
 * ledger. The gap shows the background as the rule, so `columns` must divide its items evenly.
 */
export function StatBand({
  items,
  columns = 4,
  label,
  className,
}: {
  items: Stat[]
  columns?: 4 | 6
  label: string
  className?: string
}) {
  return (
    <dl
      aria-label={label}
      className={cn(
        "grid grid-cols-2 gap-px border-y border-rule bg-rule",
        columns === 4 ? "lg:grid-cols-4" : "md:grid-cols-3 2xl:grid-cols-6",
        className
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col gap-2 bg-ink px-4 py-6 sm:px-5">
          <dt className="folio order-2">{item.label}</dt>
          <dd
            className={cn(
              "num order-1 text-[clamp(30px,3.4vw,52px)] leading-none font-bold tracking-[-0.04em] wrap-break-word text-paper",
              item.tone === "failed" && "text-danger"
            )}
          >
            <CountUp value={item.value} />
          </dd>
          {item.sub ? <dd className="order-3 font-mono text-[12px] leading-[1.5] text-dust">{item.sub}</dd> : null}
        </div>
      ))}
    </dl>
  )
}
