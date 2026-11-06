import { cn } from "@/lib/cn"

/** A small working indicator: three monochrome bars and a word for screen readers. */
export function Loader({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-3 text-[13px] text-mist", className)}>
      <span aria-hidden="true" className="loader inline-flex h-4 items-center gap-[3px]">
        <span />
        <span />
        <span />
      </span>
      {label}
    </span>
  )
}
