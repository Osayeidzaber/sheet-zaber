import type { Metadata } from "next"

import { PillLink } from "@/components/ui/button"
import { PageHeader, Panel, PanelBody } from "@/components/ui/panel"
import { EmptyState } from "@/components/ui/state"
import { requireUser } from "@/server/auth/guards"
import { listSpreadsheets } from "@/server/db/queries/spreadsheets"
import { ApiConfigForm, type SheetOption } from "@/app/(app)/apis/api-config-form"

export const metadata: Metadata = {
  title: "New endpoint",
  description: "Publish one tab of a connected spreadsheet as a REST endpoint.",
}

type NewApiPageProps = {
  searchParams: Promise<{ spreadsheet?: string | string[] }>
}

/*
 * An endpoint is (spreadsheet, tab), so creation needs a connected spreadsheet with at least one
 * snapshot tab. With none, we say so and point at the connect flow rather than render a form that
 * could only ever fail server-side (contract §1.3, plan D9). The tab list the form offers comes
 * straight from the stored snapshot, so a user can never pick a tab the server will reject.
 */
export default async function NewApiPage({ searchParams }: NewApiPageProps) {
  const user = await requireUser()
  const spreadsheets = await listSpreadsheets(user.id)
  const params = await searchParams
  const preset = typeof params.spreadsheet === "string" ? params.spreadsheet : undefined

  const sheets: SheetOption[] = spreadsheets.map((sheet) => ({
    id: sheet.id,
    title: sheet.title || "Untitled spreadsheet",
    tabs: sheet.tabs.map((tab) => ({ title: tab.title })),
  }))

  const usable = sheets.some((sheet) => sheet.tabs.length > 0)
  // Only honour a preset id that is actually the caller's own, tab-bearing workbook.
  const presetId =
    preset !== undefined && sheets.some((sheet) => sheet.id === preset && sheet.tabs.length > 0)
      ? preset
      : undefined

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="Endpoints — New"
        title="Create an endpoint"
        description="Bind one spreadsheet tab to a REST path, choose its header row, permissions and allowed operations."
        action={
          <PillLink href="/apis" variant="line" size="sm">
            Back to endpoints
          </PillLink>
        }
      />

      {sheets.length === 0 || !usable ? (
        <Panel as="section">
          <PanelBody>
            <EmptyState
              className="border-0"
              title="No tab to publish yet"
              body="An endpoint needs a connected spreadsheet whose tabs Sheet Zaber has captured. Connect one (or refresh its tabs) before creating an endpoint."
              action={
                <PillLink href="/spreadsheets" variant="solid" size="md">
                  Go to spreadsheets
                </PillLink>
              }
            />
          </PanelBody>
        </Panel>
      ) : (
        <Panel as="section">
          <PanelBody>
            <ApiConfigForm sheets={sheets} initial={presetId ? { spreadsheetId: presetId } : undefined} />
          </PanelBody>
        </Panel>
      )}
    </div>
  )
}
