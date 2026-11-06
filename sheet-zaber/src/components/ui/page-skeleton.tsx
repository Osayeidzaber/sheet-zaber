import { Skeleton } from "@/components/ui/state"

/*
 * Loading shapes matched to the page they stand in for: chapter folio, display title, hairline
 * figures, then panels. Matching shapes keep the page from jumping when the real content lands.
 */

export function SkeletonSheet({ columns = 5, rows = 5 }: { columns?: number; rows?: number }) {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-panel border border-rule">
      {Array.from({ length: rows + 1 }, (_, row) => (
        <div key={row} className="grid border-b border-rule last:border-b-0" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {Array.from({ length: columns }, (_, column) => (
            <div key={column} className="border-r border-rule px-3 py-3 last:border-r-0">
              <Skeleton className={row === 0 ? "h-4 w-3/4" : "h-3 w-1/2"} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkeletonPanel({ rows = 4 }: { rows?: number }) {
  return (
    <div className="panel">
      <div className="flex flex-col gap-2 border-b border-rule px-5 py-4">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-3 w-72 max-w-full" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-6 border-b border-rule px-5 py-4 last:border-b-0">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
      ))}
    </div>
  )
}

export function PageSkeleton({
  label,
  stats = 0,
  panels = [4],
  sheet = false,
}: {
  label: string
  stats?: number
  panels?: number[]
  sheet?: boolean
}) {
  return (
    <div className="flex flex-col gap-8" role="status" aria-label={label}>
      <div className="flex flex-col gap-5">
        <div className="border-t border-rule pt-4">
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-[clamp(40px,6vw,80px)] w-[min(520px,80%)]" />
        <Skeleton className="h-4 w-[min(560px,100%)]" />
      </div>
      {stats > 0 ? (
        <div className="grid grid-cols-2 gap-px border-y border-rule bg-rule md:grid-cols-3">
          {Array.from({ length: stats }, (_, index) => (
            <div key={index} className="flex flex-col gap-3 bg-ink px-5 py-6">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      ) : null}
      {sheet ? <SkeletonSheet /> : null}
      {panels.map((rows, index) => (
        <SkeletonPanel key={index} rows={rows} />
      ))}
    </div>
  )
}
