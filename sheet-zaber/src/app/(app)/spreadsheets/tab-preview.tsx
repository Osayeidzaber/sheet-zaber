"use client"

/*
 * Real header-row preview for one tab (`previewTab`, docs/backend-api-contract.md §2, service.ts:357).
 * It renders the ACTUAL `TabPreview.headers`/`records` the server read from Google and honours
 * `truncated` with a plain-language note instead of pretending the band was complete. The only
 * value that reaches the server beyond the sheet id (which the service re-checks for ownership) is
 * the tab title and header row the user chooses; both are zod-validated server-side, and the
 * returned `validation_failed`/`tab_not_found` fields are shown inline.
 */

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { SelectField, TextField } from "@/components/ui/field"
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import { previewSpreadsheetTabFormAction, type PreviewState } from "@/app/(app)/spreadsheets/actions"

const INITIAL: PreviewState = { status: "idle" }

export function TabPreview({
  spreadsheetId,
  tabs,
}: {
  spreadsheetId: string
  tabs: Array<{ title: string }>
}) {
  const [state, formAction, isPending] = useActionState(previewSpreadsheetTabFormAction, INITIAL)
  const fields = state.status === "error" ? state.fields : undefined

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-wrap items-end gap-4">
        <input type="hidden" name="spreadsheetId" value={spreadsheetId} />
        <SelectField
          label="Tab"
          name="tabTitle"
          required
          defaultValue={tabs[0]?.title ?? ""}
          options={tabs.map((tab) => ({ value: tab.title, label: tab.title }))}
          error={fields?.tabTitle}
          disabled={isPending}
          className="min-w-[220px] flex-1"
        />
        <TextField
          label="Header row"
          name="headerRow"
          type="number"
          min={1}
          max={1000}
          step={1}
          defaultValue={1}
          required
          inputMode="numeric"
          hint="The sheet row that holds column names."
          error={fields?.headerRow}
          disabled={isPending}
          className="w-32"
        />
        <Button type="submit" variant="line" size="md" loading={isPending}>
          {isPending ? "Reading…" : "Preview header row"}
        </Button>
      </form>

      {state.status === "error" ? (
        <p role="alert" className="text-[13px] leading-[1.6] text-paper">
          ⚠ {state.message}
          <span className="ml-2 font-mono text-[11px] tracking-[0.08em] text-dust uppercase">
            {state.code}
          </span>
        </p>
      ) : null}

      {state.status === "success" ? <PreviewTable tabTitle={state.tabTitle} state={state.preview} /> : null}
    </div>
  )
}

function PreviewTable({
  tabTitle,
  state,
}: {
  tabTitle: string
  state: { headers: string[]; records: Record<string, string>[]; truncated: boolean }
}) {
  if (state.headers.length === 0) {
    return (
      <p className="border-l-2 border-edge bg-lift px-4 py-3 text-[13px] leading-[1.6] text-dust">
        Row for “{tabTitle}” read back with no header cells. Google returns trailing empty columns
        trimmed, so the header row may be blank — check the row number.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <TableScroll label={`Header preview for ${tabTitle}`}>
        <Table>
          <thead>
            <tr>
              {state.headers.map((header, index) => (
                <Th key={`${header}-${index}`}>{header}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.records.map((record, rowIndex) => (
              <Tr key={rowIndex}>
                {state.headers.map((header, colIndex) => (
                  <Td key={`${header}-${colIndex}`}>{record[header] ?? ""}</Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
      {state.records.length === 0 ? (
        <p className="border-l-2 border-edge bg-lift px-4 py-3 text-[13px] leading-[1.6] text-dust">
          The header row for “{tabTitle}” has {state.headers.length}{" "}
          {state.headers.length === 1 ? "column" : "columns"}, but no rows were found directly below
          it — this tab is empty for now.
        </p>
      ) : null}
      <p className="text-[13px] leading-[1.6] text-dust">
        {state.truncated
          ? "Showing the first 10 rows — Google returned more, so this is a partial preview, not the whole tab."
          : `Full read of the rows below the header (${state.records.length} ${state.records.length === 1 ? "row" : "rows"}).`}
      </p>
    </div>
  )
}
