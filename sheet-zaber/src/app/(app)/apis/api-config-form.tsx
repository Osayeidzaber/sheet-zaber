"use client"

/*
 * The create/edit form for one endpoint, driven by `apiConfigSchema` fields
 * (`src/lib/schemas.ts:56`). Client-side rules never exceed the zod schema — the cross-field
 * invariants (permissions ↔ operations, and D9's primary-key requirement for PATCH/PUT/DELETE) are
 * enforced by `src/server/apis/service.ts:144` and rendered back inline from `validation_failed.fields`.
 * The only thing we pre-empt locally is the obviously-contradictory case the schema forbids anyway:
 * in `read` mode the write verbs are disabled with the reason shown, so the form can't send a request
 * the server is documented to reject.
 */

import { useEffect, useActionState, useState } from "react"
import { useRouter } from "next/navigation"

import { Button, PillLink } from "@/components/ui/button"
import { CheckRow, SelectField, TextArea, TextField } from "@/components/ui/field"
import { Badge } from "@/components/ui/badge"
import { METHOD_VALUES } from "@/lib/schemas"
import { ColumnPicker } from "@/app/(app)/apis/column-picker"
import { saveApiConfigAction, type ApiFormState, type ApiFormInitial } from "@/app/(app)/apis/actions"

const INITIAL: ApiFormState = { status: "idle" }
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"])
// Methods the engine can only run against a row it can address by primary key (contract §1.3, D9).
const PK_REQUIRED_METHODS = new Set(["PATCH", "PUT", "DELETE"])

export type SheetOption = { id: string; title: string; tabs: Array<{ title: string }> }

export function ApiConfigForm({
  sheets,
  apiId,
  initial,
}: {
  sheets: SheetOption[]
  apiId?: string
  initial?: Partial<ApiFormInitial>
}) {
  const router = useRouter()
  const [state, formAction, isPending] = useActionState(saveApiConfigAction, INITIAL)
  const fields = state.status === "error" ? state.fields : undefined

  const [spreadsheetId, setSpreadsheetId] = useState(initial?.spreadsheetId ?? sheets[0]?.id ?? "")
  const [tabTitle, setTabTitle] = useState(
    () => initial?.tabTitle ?? tabsOf(sheets, initial?.spreadsheetId ?? sheets[0]?.id)[0] ?? ""
  )
  const [permissions, setPermissions] = useState<"read" | "read_write">(initial?.permissions ?? "read")
  const [ops, setOps] = useState<string[]>(initial?.allowedOperations?.length ? [...initial.allowedOperations] : ["GET"])

  const [headerRow, setHeaderRow] = useState(String(initial?.headerRow ?? 1))
  const [primaryKey, setPrimaryKey] = useState(initial?.primaryKeyColumn ?? "")
  const [noColumns, setNoColumns] = useState(false)

  const tabOptions = tabsOf(sheets, spreadsheetId)
  const needsPrimaryKey = ops.some((op) => PK_REQUIRED_METHODS.has(op))
  const readOnly = permissions === "read"

  useEffect(() => {
    if (state.status === "success") router.push(`/apis/${state.id}`)
  }, [state, router])

  const chooseSheet = (nextId: string) => {
    setSpreadsheetId(nextId)
    const first = tabsOf(sheets, nextId)[0] ?? ""
    setTabTitle(initial && initial.spreadsheetId === nextId ? (initial.tabTitle ?? first) : first)
  }

  const toggleOp = (method: string, checked: boolean) => {
    setOps((current) => {
      const next = checked ? [...new Set([...current, method])] : current.filter((m) => m !== method)
      return next.length === 0 ? [] : next
    })
  }

  const choosePermissions = (next: "read" | "read_write") => {
    setPermissions(next)
    if (next === "read") setOps((current) => current.filter((m) => m === "GET"))
  }

  const blocked = spreadsheetId === "" || tabTitle === "" || ops.length === 0 || noColumns

  return (
    <form action={formAction} className="flex flex-col gap-6">
      {apiId ? <input type="hidden" name="apiId" value={apiId} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <SelectField
          label="Spreadsheet"
          name="spreadsheetId"
          required
          value={spreadsheetId}
          onChange={(event) => chooseSheet(event.target.value)}
          options={sheets.map((sheet) => ({
            value: sheet.id,
            label: sheet.tabs.length > 0 ? sheet.title || "Untitled spreadsheet" : `${sheet.title || "Untitled"} — no tabs`,
          }))}
          error={fields?.spreadsheetId}
          hint={tabOptions.length === 0 ? "This workbook has no tabs captured yet — refresh its tabs first." : "Endpoints publish one tab of one connected spreadsheet."}
          disabled={isPending}
        />
        <SelectField
          label="Tab"
          name="tabTitle"
          required
          value={tabTitle}
          onChange={(event) => setTabTitle(event.target.value)}
          options={tabOptions.map((title) => ({ value: title, label: title }))}
          error={fields?.tabTitle}
          hint="Matches the snapshot tab exactly, including case."
          disabled={isPending || tabOptions.length === 0}
        />
      </div>

      <TextField
        label="Endpoint name"
        name="name"
        required
        defaultValue={initial?.name ?? ""}
        maxLength={120}
        placeholder="Orders read API"
        hint="Shown in your list and logs. 1–120 characters."
        error={fields?.name}
        disabled={isPending}
      />

      <TextArea
        label="Description"
        name="description"
        rows={3}
        defaultValue={initial?.description ?? ""}
        maxLength={500}
        placeholder="Optional note on what this endpoint exposes."
        hint="Optional; leave empty for none."
        error={fields?.description}
        disabled={isPending}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <TextField
          label="Header row"
          name="headerRow"
          type="number"
          min={1}
          max={1000}
          step={1}
          inputMode="numeric"
          required
          value={headerRow}
          onChange={(event) => setHeaderRow(event.target.value)}
          hint="The sheet row holding column names (1–1000)."
          error={fields?.headerRow}
          disabled={isPending}
        />
        <TextField
          label="Rate limit per hour"
          name="rateLimitPerHour"
          type="number"
          min={1}
          max={1000000}
          step={1}
          inputMode="numeric"
          defaultValue={initial?.rateLimitPerHour ?? ""}
          hint="Optional override. Empty uses the platform default (1000/hour)."
          error={fields?.rateLimitPerHour}
          disabled={isPending}
        />
      </div>

      <ColumnPicker
        key={`${spreadsheetId}|${tabTitle}|${headerRow}`}
        spreadsheetId={spreadsheetId}
        tabTitle={tabTitle}
        headerRow={Number(headerRow)}
        initial={
          initial && initial.spreadsheetId === spreadsheetId && initial.tabTitle === tabTitle
            ? (initial.exposedColumns ?? null)
            : null
        }
        primaryKey={primaryKey.trim()}
        onPrimaryKey={setPrimaryKey}
        onEmptyChange={setNoColumns}
        error={fields?.exposedColumns}
        disabled={isPending}
      />

      <div className="flex flex-col gap-2">
        <TextField
          label="Primary key column"
          name="primaryKeyColumn"
          value={primaryKey}
          onChange={(event) => setPrimaryKey(event.target.value)}
          maxLength={100}
          placeholder="id"
          error={fields?.primaryKeyColumn}
          disabled={isPending}
        />
        <p className="text-[13px] leading-[1.6] text-dust">
          Rows are addressed by this column&apos;s value, never by their row number.{" "}
          <span className="text-paper">
            {needsPrimaryKey
              ? "You selected PATCH, PUT or DELETE — a primary key column is required for those to resolve a row."
              : "Without a primary key this endpoint is read-and-append only: single-record GET, PATCH, PUT and DELETE will be rejected with `operation_not_allowed`."}
          </span>
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SelectField
          label="Permissions"
          name="permissions"
          required
          value={permissions}
          onChange={(event) => choosePermissions(event.target.value as "read" | "read_write")}
          options={[
            { value: "read", label: "Read only" },
            { value: "read_write", label: "Read & write" },
          ]}
          error={fields?.permissions}
          hint="Read-only endpoints cannot advertise any write verb."
          disabled={isPending}
        />
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-[14px] text-mist">
            Allowed operations<span className="text-paper"> *</span>
          </span>
          <div className="flex flex-col gap-1 border border-rule px-4 py-3">
            {METHOD_VALUES.map((method) => (
              <CheckRow
                key={method}
                label={method}
                description={
                  WRITE_METHODS.has(method) && readOnly
                    ? "Writes need read & write permissions"
                    : PK_REQUIRED_METHODS.has(method)
                      ? "Addresses a row by primary key value"
                      : method === "POST"
                        ? "Appends rows to the tab"
                        : "Reads rows from the tab"
                }
                checked={ops.includes(method)}
                disabled={isPending || (readOnly && WRITE_METHODS.has(method))}
                onChange={(checked) => toggleOp(method, checked)}
              />
            ))}
          </div>
          {/* Mirror the selected verbs into submittable fields (CheckRow itself is a controlled UI control). */}
          {ops.map((method) => (
            <input key={method} type="hidden" name="allowedOperations" value={method} />
          ))}
          {ops.length === 0 ? (
            <span className="text-[13px] text-paper">⚠ Select at least one operation.</span>
          ) : fields?.allowedOperations ? (
            <span className="text-[13px] text-paper">⚠ {fields.allowedOperations}</span>
          ) : null}
        </div>
      </div>

      {state.status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-l-2 border-danger bg-lift px-4 py-3 text-[13px] text-paper">
          <span>⚠ {state.message}</span>
          <Badge variant="failed">{state.code}</Badge>
        </div>
      ) : null}

      {needsPrimaryKey && primaryKey.trim() === "" ? (
        <p className="text-[13px] text-paper">
          ⚠ A primary key column is required while PATCH, PUT or DELETE is allowed — the endpoint will
          be rejected until you set one.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="solid" loading={isPending} disabled={blocked}>
          {isPending ? "Saving…" : apiId ? "Save changes" : "Create endpoint"}
        </Button>
        <PillLink href="/apis" variant="ghost" size="md">
          Cancel
        </PillLink>
        {blocked ? (
          <span className="text-[13px] text-dust">
            {noColumns
              ? "Expose at least one column to save."
              : ops.length === 0
              ? "Choose at least one operation to save."
              : "A spreadsheet and tab are required to save."}
          </span>
        ) : null}
      </div>
    </form>
  )
}

function tabsOf(sheets: SheetOption[], id: string | undefined): string[] {
  if (id === undefined) return []
  return sheets.find((sheet) => sheet.id === id)?.tabs.map((tab) => tab.title) ?? []
}
