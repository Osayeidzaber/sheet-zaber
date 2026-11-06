"use client"

/*
 * Tests the chain an endpoint depends on and shows the sheet it serves. It reads through the owner's
 * Google grant, the same grant the engine uses, and spends no API key or rate limit. So it answers
 * "can this endpoint reach its sheet", not "will this particular key be accepted".
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { previewSpreadsheetTabFormAction, type PreviewState } from "@/app/(app)/spreadsheets/actions"
import { Button, PillLink } from "@/components/ui/button"
import { Loader } from "@/components/ui/loader"
import { SkeletonSheet } from "@/components/ui/page-skeleton"
import { cn } from "@/lib/cn"
import { formatDuration } from "@/lib/format"

type Result =
  | { kind: "running" }
  | { kind: "done"; state: PreviewState; ms: number; at: string }
  | { kind: "crashed" }

type Stage = { label: string; state: "pass" | "fail" | "skipped"; detail: string }

const GRANT_CODES = ["google_reauth_required", "google_not_connected"]

function stagesFor(state: PreviewState, enabled: boolean): Stage[] {
  const code = state.status === "error" ? state.code : null
  const grantFailed = code !== null && GRANT_CODES.includes(code)
  const headers = state.status === "success" ? state.preview.headers.length : 0

  const stages: Stage[] = [
    {
      label: "Google account",
      state: grantFailed ? "fail" : "pass",
      detail: grantFailed ? "Google no longer accepts the saved grant." : "The saved grant was accepted.",
    },
    {
      label: "Sheet and tab",
      state: grantFailed ? "skipped" : code ? "fail" : "pass",
      detail: grantFailed ? "Not tried." : code && state.status === "error" ? state.message : "The tab was read.",
    },
    {
      label: "Header row",
      state: state.status !== "success" ? "skipped" : headers > 0 ? "pass" : "fail",
      detail: state.status !== "success" ? "Not tried." : headers > 0 ? `${headers} ${headers === 1 ? "column" : "columns"} found.` : "This row has no column names.",
    },
    {
      label: "Endpoint",
      state: enabled ? "pass" : "fail",
      detail: enabled ? "Enabled and serving." : "Disabled, so callers get not-found.",
    },
  ]
  return stages
}

const MARK = { pass: "✓", fail: "×", skipped: "–" }

export function ConnectionTest({
  spreadsheetId,
  tabTitle,
  headerRow,
  enabled,
  exposedColumns,
  primaryKey,
}: {
  spreadsheetId: string
  tabTitle: string
  headerRow: number
  enabled: boolean
  exposedColumns: string[] | null
  primaryKey: string | null
}) {
  const [result, setResult] = useState<Result>({ kind: "running" })
  const attempt = useRef(0)

  const run = useCallback(async () => {
    const id = ++attempt.current
    setResult({ kind: "running" })
    const form = new FormData()
    form.set("spreadsheetId", spreadsheetId)
    form.set("tabTitle", tabTitle)
    form.set("headerRow", String(headerRow))
    const started = performance.now()
    try {
      const state = await previewSpreadsheetTabFormAction({ status: "idle" }, form)
      if (id !== attempt.current) return
      setResult({
        kind: "done",
        state,
        ms: performance.now() - started,
        at: new Date().toLocaleTimeString("en-GB"),
      })
    } catch {
      if (id === attempt.current) setResult({ kind: "crashed" })
    }
  }, [spreadsheetId, tabTitle, headerRow])

  useEffect(() => {
    const timer = setTimeout(() => void run(), 0)
    return () => clearTimeout(timer)
  }, [run])

  const done = result.kind === "done" ? result : null
  const stages = done ? stagesFor(done.state, enabled) : []
  const connected = done !== null && stages.slice(0, 3).every((stage) => stage.state === "pass")
  const needsGrant = done?.state.status === "error" && GRANT_CODES.includes(done.state.code)
  const preview = done?.state.status === "success" ? done.state.preview : null

  const verdict =
    result.kind === "running"
      ? null
      : result.kind === "crashed"
        ? "Test could not run"
        : !connected
          ? "Not connected"
          : enabled
            ? "Connected"
            : "Connected, endpoint off"

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div aria-live="polite" className="flex min-w-0 flex-wrap items-center gap-3">
          {verdict ? (
            <>
              <span
                className={cn(
                  "reveal inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[15px] font-semibold",
                  connected && enabled ? "border-paper bg-paper text-ink" : connected ? "border-warn text-warn" : "border-danger text-danger"
                )}
              >
                <span aria-hidden="true" className="relative flex size-2">
                  {connected && enabled ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-ink opacity-50" /> : null}
                  <span className="relative inline-flex size-2 rounded-full bg-current" />
                </span>
                {verdict}
              </span>
              {done ? (
                <span className="folio num">
                  {formatDuration(done.ms)} · {done.at}
                </span>
              ) : null}
            </>
          ) : (
            <Loader label="Testing the connection" />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {needsGrant ? (
            <PillLink href="/auth/google/connect" prefetch={false} variant="solid" size="sm">
              Reconnect Google
            </PillLink>
          ) : null}
          <Button size="sm" variant="line" loading={result.kind === "running"} onClick={() => void run()}>
            Test again
          </Button>
        </div>
      </div>

      {done ? (
        <ol className="grid gap-px border-y border-rule bg-rule sm:grid-cols-2 xl:grid-cols-4">
          {stages.map((stage) => (
            <li key={stage.label} className="flex min-w-0 gap-3 bg-deep px-4 py-4">
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full border font-mono text-[12px]",
                  stage.state === "pass" && "border-paper bg-paper text-ink",
                  stage.state === "fail" && "border-danger text-danger",
                  stage.state === "skipped" && "border-edge text-dust"
                )}
              >
                {MARK[stage.state]}
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold">
                  {stage.label}
                  <span className="sr-only"> {stage.state === "pass" ? "passed" : stage.state === "fail" ? "failed" : "not tried"}</span>
                </p>
                <p className="mt-1 text-[12px] leading-[1.5] wrap-break-word text-dust">{stage.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {result.kind === "crashed" ? (
        <p role="alert" className="text-[13px] text-mist">
          ⚠ The test request did not complete. Check that you are still signed in, then test again.
        </p>
      ) : null}

      {result.kind === "running" ? <SkeletonSheet /> : null}

      {preview && preview.headers.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="folio">
            {tabTitle} · {preview.truncated ? "first rows" : `${preview.records.length} rows`}
          </p>
          <div tabIndex={0} role="region" aria-label={`Live view of ${tabTitle}`} className="scroll-shadow max-w-full overflow-x-auto rounded-panel border border-rule">
            <table className="w-full border-collapse font-mono text-[12px]">
              <thead>
                <tr>
                  <th scope="col" className="w-10 min-w-10 border-r border-b border-rule bg-lift">
                    <span className="sr-only">Row</span>
                  </th>
                  {preview.headers.map((column) => {
                    const on = exposedColumns === null || exposedColumns.includes(column)
                    return (
                      <th key={column} scope="col" className={cn("min-w-[120px] border-r border-b border-rule px-3 py-2 text-left font-semibold last:border-r-0", on ? "bg-lift text-paper" : "bg-deep text-dust line-through")}>
                        {column}
                        {column === primaryKey ? <span className="ml-2 text-[10px] font-normal tracking-[0.1em] text-mist uppercase no-underline">key</span> : null}
                        {on ? null : <span className="sr-only"> (hidden from this API)</span>}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {preview.records.map((record, row) => (
                  <tr key={row} className="transition-colors duration-(--dur-fast) hover:bg-lift">
                    <th scope="row" className="border-r border-b border-rule bg-lift px-2 py-2 text-center font-normal text-dust num">
                      {headerRow + row + 1}
                    </th>
                    {preview.headers.map((column) => {
                      const on = exposedColumns === null || exposedColumns.includes(column)
                      return (
                        <td key={column} className={cn("max-w-[240px] truncate border-r border-b border-rule px-3 py-2 last:border-r-0", on ? "text-mist" : "text-dust opacity-60")}>
                          {record[column] ?? ""}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[12px] leading-[1.6] text-dust">
            Only you see this view. Struck-through columns exist in the sheet but are hidden from API callers.
          </p>
        </div>
      ) : null}
    </div>
  )
}
