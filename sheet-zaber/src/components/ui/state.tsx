import { Rings } from "@/components/ui/chapter"
import { cn } from "@/lib/cn"

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("skeleton block", className)} />
}

/** Loading shape that matches the rows it replaces, so the page does not jump. */
export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-6 border-b border-rule py-4 last:border-b-0">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
      ))}
    </div>
  )
}

export function EmptyState({
  title,
  body,
  action,
  className,
}: {
  title: string
  body: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col items-center gap-4 overflow-hidden rounded-panel border border-rule px-6 py-14 text-center",
        className
      )}
    >
      <Rings sizes={[640, 440, 240]} />
      <p className="relative text-[clamp(20px,2.4vw,28px)] font-bold tracking-[-0.03em]">{title}</p>
      <p className="relative max-w-[46ch] text-[14px] leading-[1.7] text-mist">{body}</p>
      {action ? <div className="relative">{action}</div> : null}
    </div>
  )
}

/**
 * A failure says what broke, in its own words, and keeps the retry next to it. The ⚠
 * prefix carries severity because this system has no red for chrome.
 */
export function ErrorState({
  title = "Something went wrong",
  body,
  code,
  action,
  className,
}: {
  title?: string
  body: string
  code?: string | null
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-3 rounded-panel border border-edge bg-lift px-5 py-4",
        className
      )}
    >
      <p className="text-[15px] font-semibold text-paper">⚠ {title}</p>
      <p className="max-w-[70ch] text-[13px] leading-[1.6] text-mist">{body}</p>
      {code ? <p className="font-mono text-[11px] tracking-[0.08em] text-dust uppercase">{code}</p> : null}
      {action}
    </div>
  )
}

/** Full-width notice for account-level conditions, e.g. a Google connection that expired. */
export function Banner({
  tone = "neutral",
  title,
  body,
  action,
}: {
  tone?: "neutral" | "attention" | "failed"
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div
      role={tone === "neutral" ? "status" : "alert"}
      className={cn(
        "flex flex-wrap items-center justify-between gap-4 border border-edge border-l-2 bg-lift px-5 py-4",
        tone === "attention" && "border-l-warn",
        tone === "failed" && "border-l-danger",
        tone === "neutral" && "border-l-paper"
      )}
    >
      <div className="min-w-0">
        <p className="text-[14px] font-semibold text-paper">{title}</p>
        <p className="mt-1 text-[13px] leading-[1.6] text-mist">{body}</p>
      </div>
      {action}
    </div>
  )
}

export function LoadingText({ children = "Loading…" }: { children?: React.ReactNode }) {
  return (
    <p role="status" className="font-mono text-[12px] tracking-[0.08em] text-dust uppercase">
      {children}
    </p>
  )
}
