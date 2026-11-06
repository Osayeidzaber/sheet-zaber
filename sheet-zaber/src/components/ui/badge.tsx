import { cn } from "@/lib/cn"

/**
 * State without hue. The reference system encodes status as wording plus shape, so a
 * status is always readable in text and only the two failure tones borrow colour.
 */
export type StatusTone = "active" | "idle" | "attention" | "failed"

const DOT: Record<StatusTone, string> = {
  // Connected / enabled / healthy.
  active: "bg-paper",
  // Never used, unknown, or merely pending.
  idle: "border border-edge bg-transparent",
  // Degraded: needs an action but nothing has broken yet.
  attention: "border border-dashed border-warn bg-transparent",
  // Broken: revoked, disabled, inaccessible, 5xx.
  failed: "bg-danger",
}

export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: StatusTone
  label: string
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />
      <span className="text-[14px] text-mist">{label}</span>
    </span>
  )
}

export type BadgeVariant = "neutral" | "inverted" | "outline" | "failed"

const BADGE: Record<BadgeVariant, string> = {
  neutral: "border-edge text-mist",
  // The strong, affirmative state: filled paper, black text.
  inverted: "border-paper bg-paper text-ink",
  outline: "border-dashed border-edge text-dust",
  failed: "border-danger text-danger",
}

export function Badge({
  children,
  variant = "neutral",
  mono = true,
  className,
}: {
  children: React.ReactNode
  variant?: BadgeVariant
  mono?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 whitespace-nowrap",
        mono && "font-mono text-[11px] tracking-[0.08em] uppercase",
        !mono && "text-[12px]",
        BADGE[variant],
        className
      )}
    >
      {children}
    </span>
  )
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

const METHODS: HttpMethod[] = ["GET", "POST", "PATCH", "PUT", "DELETE"]

export function isHttpMethod(value: string): value is HttpMethod {
  return METHODS.includes(value as HttpMethod)
}

/**
 * Method badges stay monochrome: the verb is carried by the word, so a wall of GETs
 * does not turn into a colour chart.
 */
export function MethodTag({ method, className }: { method: HttpMethod; className?: string }) {
  const destructive = method === "DELETE"
  return (
    <span
      className={cn(
        "inline-flex h-7 min-w-[64px] items-center justify-center rounded-full border px-2.5 font-mono text-[11px] tracking-[0.1em]",
        destructive ? "border-danger text-danger" : "border-edge text-paper",
        className
      )}
    >
      {method}
    </span>
  )
}

/** Status code chip: 5xx is the only class allowed to be red. */
export function StatusCode({ code, className }: { code: number; className?: string }) {
  const cls = Math.floor(code / 100)
  return (
    <span
      title={String(code)}
      className={cn(
        "font-mono text-[13px] tabular-nums",
        cls === 5 ? "text-danger" : cls === 4 ? "text-paper" : "text-mist",
        className
      )}
    >
      {code}
    </span>
  )
}
