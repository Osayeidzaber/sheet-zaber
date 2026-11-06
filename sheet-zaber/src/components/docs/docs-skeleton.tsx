import { Skeleton, SkeletonRows } from "@/components/ui/state"

/*
 * The shape every /docs route is replaced by. It mirrors a documentation page — a folio, a display
 * heading, a lead, the at-a-glance plate, then the clause rows — so the rail and the content column
 * do not jump when the route resolves. `SkeletonRows` carries role="status" and its own label, so
 * nothing here needs a "Loading…" string.
 */
export function DocsSkeleton({ rows = 4, wide = false }: { rows?: number; wide?: boolean }) {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-3 w-32" />
        <Skeleton className={wide ? "h-12 w-[min(100%,560px)]" : "h-12 w-[min(100%,420px)]"} />
        <div className="flex flex-col gap-2.5 pt-1">
          <Skeleton className="h-3.5 w-full max-w-[68ch]" />
          <Skeleton className="h-3.5 w-full max-w-[62ch]" />
          <Skeleton className="h-3.5 w-2/3 max-w-[44ch]" />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-16 rounded-panel" />
        <Skeleton className="h-16 rounded-panel" />
        <Skeleton className="h-16 rounded-panel" />
        <Skeleton className="h-16 rounded-panel" />
      </div>

      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-32 rounded-panel" />
      </div>

      <SkeletonRows rows={rows} />
    </div>
  )
}
