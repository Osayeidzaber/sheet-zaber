import { Folio, TitleAside } from "@/components/ui/chapter"
import { CountUp } from "@/components/ui/count-up"
import { cn } from "@/lib/cn"

export function Panel({
  children,
  className,
  as: Tag = "section",
}: {
  children: React.ReactNode
  className?: string
  as?: "section" | "div" | "article"
}) {
  return <Tag className={cn("panel", className)}>{children}</Tag>
}

export function PanelHeader({
  title,
  description,
  action,
  className,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4 border-b border-rule px-5 py-4",
        className
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[18px] font-semibold tracking-[-0.02em]">{title}</h2>
        {description ? <p className="mt-1 text-[13px] text-dust">{description}</p> : null}
      </div>
      {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  )
}

export function PanelBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-5 py-5", className)}>{children}</div>
}

/** Page title block: the chapter folio, a display heading with an optional serif aside, one promise. */
export function PageHeader({
  folio,
  title,
  titleAside,
  description,
  action,
}: {
  folio: string
  title: string
  titleAside?: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <header className="reveal flex flex-col gap-5">
      <Folio>{folio}</Folio>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-[clamp(40px,6vw,84px)] leading-[0.95] font-extrabold tracking-[-0.05em] wrap-anywhere">
            {title}
            {titleAside ? (
              <>
                {" "}
                <TitleAside>{titleAside}</TitleAside>
              </>
            ) : null}
          </h1>
          {description ? (
            <p className="mt-4 max-w-[62ch] text-[15px] leading-[1.6] text-dust">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-3">{action}</div> : null}
      </div>
    </header>
  )
}

/**
 * KPI tile. `tone="failed"` is the only colour the system allows a metric, and it is
 * reserved for a number that is actually telling you something is broken.
 */
export function Metric({
  label,
  value,
  sub,
  tone = "neutral",
  loading = false,
}: {
  label: string
  value: string
  sub?: string
  tone?: "neutral" | "failed"
  loading?: boolean
}) {
  return (
    <div className="border-t border-rule pt-4 pr-2 pb-2">
      <p className="folio">{label}</p>
      {loading ? (
        <div className="mt-4 h-8 w-24 skeleton" />
      ) : (
        <p
          className={cn(
            "mt-3 text-[clamp(30px,3.4vw,46px)] font-bold leading-none tracking-[-0.04em] num",
            tone === "failed" && "text-danger"
          )}
        >
          <CountUp value={value} />
        </p>
      )}
      {sub ? <p className="mt-2 font-mono text-[12px] text-dust">{sub}</p> : null}
    </div>
  )
}

/** Hairline-separated list row: the house structure, not a card. */
export function Row({
  children,
  className,
  as: Tag = "div",
  interactive = false,
}: {
  children: React.ReactNode
  className?: string
  as?: "div" | "li"
  interactive?: boolean
}) {
  return (
    <Tag
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-rule px-5 py-4 last:border-b-0",
        interactive && "transition-[background-color,padding] duration-(--dur-base) ease-(--ease-press) hover:bg-lift hover:pl-7",
        className
      )}
    >
      {children}
    </Tag>
  )
}

/** Two-line row identity block: name on paper, provenance in mono dust. */
export function RowTitle({
  title,
  meta,
  href,
}: {
  title: string
  meta?: string
  href?: string
}) {
  const content = <span className="block truncate text-[15px] font-semibold">{title}</span>
  return (
    <div className="min-w-0 flex-1">
      {href ? (
        <a href={href} className="group block">
          {content}
          <span className="block truncate font-mono text-[12px] text-dust group-hover:text-mist">
            {meta}
          </span>
        </a>
      ) : (
        <>
          {content}
          {meta ? <span className="block truncate font-mono text-[12px] text-dust">{meta}</span> : null}
        </>
      )}
    </div>
  )
}
