import { formatNumber } from "@/lib/format"

export type BreakdownRow = { label: string; count: number; failed?: number }

/** Ranked rows with a share bar. Width is decoration; each count is also printed. */
export function Breakdown({ rows, empty }: { rows: BreakdownRow[]; empty: string }) {
  if (rows.length === 0) return <p className="text-[14px] text-dust">{empty}</p>
  const max = Math.max(...rows.map((row) => row.count), 1)

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.label} className="min-w-0">
          <div className="flex items-baseline justify-between gap-4 text-[13px]">
            <span className="min-w-0 truncate text-paper">{row.label}</span>
            <span className="num shrink-0 font-mono text-[12px] text-mist">
              {formatNumber(row.count)}
              {row.failed ? <span className="text-danger"> · {formatNumber(row.failed)} failed</span> : null}
            </span>
          </div>
          <div aria-hidden="true" className="mt-1.5 h-1 overflow-hidden rounded-full bg-raise">
            <div className="h-full rounded-full bg-paper" style={{ width: `${(row.count / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}
