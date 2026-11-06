"use client"

/*
 * A virtual sheet for choosing what an endpoint exposes. It shows the tab's real header row and first
 * rows, and clicking a column heading includes or hides it. The engine enforces the result; this only
 * edits the allowlist. If the tab cannot be read, nothing is submitted, so an edit keeps its choice.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { previewSpreadsheetTabFormAction, type PreviewState } from "@/app/(app)/spreadsheets/actions"
import { Button } from "@/components/ui/button"
import { Loader } from "@/components/ui/loader"
import { SkeletonSheet } from "@/components/ui/page-skeleton"
import { cn } from "@/lib/cn"

/** Spreadsheet column letters: 0 → A, 26 → AA. */
function columnLetter(index: number): string {
  let letter = ""
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) letter = String.fromCharCode(65 + (n % 26)) + letter
  return letter
}

type Preview = { headers: string[]; records: Record<string, string>[]; truncated: boolean }

export function ColumnPicker({
  spreadsheetId,
  tabTitle,
  headerRow,
  initial,
  primaryKey,
  onPrimaryKey,
  onEmptyChange,
  error,
  disabled,
}: {
  spreadsheetId: string
  tabTitle: string
  headerRow: number
  initial: string[] | null
  primaryKey: string
  onPrimaryKey: (column: string) => void
  onEmptyChange: (empty: boolean) => void
  error?: string
  disabled?: boolean
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [failure, setFailure] = useState<{ message: string; code: string } | null>(null)
  const [loading, setLoading] = useState(true)
  // null means every column, including ones added to the sheet later.
  const [selected, setSelected] = useState<string[] | null>(initial)
  const attempt = useRef(0)

  const load = useCallback(async () => {
    const id = ++attempt.current
    setLoading(true)
    setFailure(null)
    const form = new FormData()
    form.set("spreadsheetId", spreadsheetId)
    form.set("tabTitle", tabTitle)
    form.set("headerRow", String(headerRow))
    let result: PreviewState
    try {
      result = await previewSpreadsheetTabFormAction({ status: "idle" }, form)
    } catch {
      result = { status: "error", message: "The request did not complete.", code: "request_failed" }
    }
    if (id !== attempt.current) return
    setLoading(false)
    if (result.status === "success") setPreview(result.preview)
    else if (result.status === "error") setFailure({ message: result.message, code: result.code })
  }, [spreadsheetId, tabTitle, headerRow])

  useEffect(() => {
    if (spreadsheetId === "" || tabTitle === "" || !Number.isInteger(headerRow) || headerRow < 1) return
    // Debounced so typing a header row number does not read Google on every keystroke.
    const timer = setTimeout(() => void load(), 400)
    return () => {
      clearTimeout(timer)
      // Invalidates whatever request is in flight; this counter is not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      attempt.current++
    }
  }, [load, spreadsheetId, tabTitle, headerRow])

  const headers = preview?.headers ?? []
  const isOn = (column: string) => selected === null || selected.includes(column)
  const onCount = headers.filter(isOn).length
  const empty = preview !== null && headers.length > 0 && onCount === 0

  useEffect(() => onEmptyChange(empty), [empty, onEmptyChange])

  function toggle(column: string) {
    const current = selected ?? headers
    const next = current.includes(column)
      ? current.filter((name) => name !== column)
      : headers.filter((name) => current.includes(name) || name === column)
    setSelected(next.length === headers.length ? null : next)
  }

  function makeKey(column: string) {
    onPrimaryKey(column === primaryKey ? "" : column)
    if (column !== primaryKey && !isOn(column)) toggle(column)
  }

  const sample = preview?.records[0]
  const samplePayload = sample
    ? JSON.stringify(Object.fromEntries(headers.filter(isOn).map((name) => [name, sample[name] ?? ""])), null, 2)
    : null

  return (
    <fieldset className="flex min-w-0 flex-col gap-3" disabled={disabled}>
      <legend className="text-[14px] text-mist">Exposed columns</legend>
      <p className="text-[13px] leading-[1.6] text-dust">
        Click a column heading to include or hide it. Hidden columns cannot be read, filtered, searched
        or written through this API. Deleting a record still removes its whole row, and range reads turn
        off once any column is hidden.
      </p>

      {preview && headers.length > 0 ? (
        <>
          {selected === null ? <input type="hidden" name="columnsMode" value="all" /> : null}
          {selected !== null ? (
            <>
              <input type="hidden" name="columnsMode" value="selected" />
              {selected.map((column) => (
                <input key={column} type="hidden" name="exposedColumns" value={column} />
              ))}
            </>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p aria-live="polite" className="folio num">
              {onCount} of {headers.length} exposed
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                Select all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(primaryKey && headers.includes(primaryKey) ? [primaryKey] : [])}>
                Clear
              </Button>
              <Button size="sm" variant="ghost" loading={loading} onClick={() => void load()}>
                Reload
              </Button>
            </div>
          </div>

          <div
            tabIndex={0}
            role="region"
            aria-label={`Preview of ${tabTitle}`}
            className="scroll-shadow max-w-full overflow-x-auto rounded-panel border border-rule bg-deep"
          >
            <table className="w-full border-collapse font-mono text-[12px]">
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-10 w-10 min-w-10 border-r border-b border-rule bg-lift">
                    <span className="sr-only">Row</span>
                  </th>
                  {headers.map((column, index) => {
                    const on = isOn(column)
                    const isKey = column === primaryKey
                    return (
                      <th key={column} scope="col" className={cn("min-w-[160px] border-r border-b border-rule p-0 text-left font-normal transition-colors duration-(--dur-base) last:border-r-0", on ? "bg-paper text-ink" : "bg-lift text-dust")}>
                        <div className="flex items-center justify-between gap-1 pr-1">
                          <button
                            type="button"
                            aria-pressed={on}
                            aria-label={`${on ? "Hide" : "Expose"} column ${column}`}
                            disabled={isKey}
                            onClick={() => toggle(column)}
                            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left disabled:cursor-not-allowed"
                          >
                            <span aria-hidden="true" className="w-3 shrink-0">{on ? "✓" : ""}</span>
                            <span className="min-w-0">
                              <span aria-hidden="true" className="block text-[10px] tracking-[0.14em] opacity-70">{columnLetter(index)}</span>
                              <span className={cn("block truncate font-semibold", !on && "line-through")}>{column}</span>
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-pressed={isKey}
                            aria-label={`${isKey ? "Stop using" : "Use"} ${column} as the primary key`}
                            onClick={() => makeKey(column)}
                            className={cn(
                              "min-h-8 shrink-0 rounded-full border px-2 text-[10px] tracking-[0.1em] uppercase transition-colors duration-(--dur-fast)",
                              on ? "border-ink/40" : "border-edge",
                              isKey && (on ? "bg-ink text-paper" : "bg-paper text-ink")
                            )}
                          >
                            Key
                          </button>
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {preview.records.map((record, row) => (
                  <tr key={row}>
                    <th scope="row" className="sticky left-0 border-r border-b border-rule bg-lift px-2 py-2 text-center font-normal text-dust num">
                      {headerRow + row + 1}
                    </th>
                    {headers.map((column) => (
                      <td
                        key={column}
                        className={cn(
                          "max-w-[240px] truncate border-r border-b border-rule px-3 py-2 transition-[color,opacity] duration-(--dur-base) last:border-r-0",
                          isOn(column) ? "text-paper" : "text-dust line-through opacity-60"
                        )}
                      >
                        {record[column] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.records.length === 0 ? <p className="text-[13px] text-dust">No rows below the header yet.</p> : null}
          {samplePayload ? (
            <details className="group">
              <summary className="folio cursor-pointer py-2 transition-colors duration-(--dur-fast) hover:text-paper">
                What a record will look like
              </summary>
              <pre className="codeblock">{samplePayload}</pre>
            </details>
          ) : null}
          {empty ? <p role="alert" className="text-[13px] text-paper">⚠ Expose at least one column.</p> : null}
        </>
      ) : null}

      {preview && headers.length === 0 && !loading ? (
        <p className="border-l-2 border-edge bg-lift px-4 py-3 text-[13px] text-dust">
          Row {headerRow} of this tab has no header cells. Check the header row number.
        </p>
      ) : null}

      {loading && !preview ? (
        <div className="flex flex-col gap-3">
          <Loader label="Reading the tab" />
          <SkeletonSheet />
        </div>
      ) : null}

      {failure ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-edge bg-lift px-4 py-3">
          <p className="min-w-0 text-[13px] leading-[1.6] text-mist">
            ⚠ The tab could not be read, so columns cannot be chosen right now. Saving keeps the current
            column choice. {failure.message}
            <span className="ml-2 font-mono text-[11px] tracking-[0.08em] text-dust uppercase">{failure.code}</span>
          </p>
          <Button size="sm" variant="line" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-[13px] text-paper">⚠ {error}</p> : null}
    </fieldset>
  )
}
