import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { PillLink } from "@/components/ui/button"
import { PageHeader, Panel, PanelBody } from "@/components/ui/panel"
import { ErrorState } from "@/components/ui/state"
import { isActionError } from "@/lib/action-result"
import { requireUser } from "@/server/auth/guards"
import { getApi } from "@/server/apis/service"
import { listSpreadsheets } from "@/server/db/queries/spreadsheets"
import type { ApiFormInitial } from "@/app/(app)/apis/actions"
import { ApiConfigForm, type SheetOption } from "@/app/(app)/apis/api-config-form"

type EditApiPageProps = {
  params: Promise<{ apiId: string }>
}

export const metadata: Metadata = {
  title: "Edit endpoint",
  description: "Change an endpoint's spreadsheet tab, header row, permissions and operations.",
}

export default async function EditApiPage({ params }: EditApiPageProps) {
  const { apiId } = await params
  const user = await requireUser()

  const result = await getApi(apiId, user.id)
  if (isActionError(result)) {
    if (result.error.code === "not_found") notFound()
    return (
      <div className="flex flex-col gap-8">
        <PageHeader folio="Endpoint — Edit" title="Edit endpoint" />
        <ErrorState title="Endpoint could not be read" body={result.error.message} code={result.error.code} />
      </div>
    )
  }
  const api = result.data

  const spreadsheets = await listSpreadsheets(user.id)
  const sheets: SheetOption[] = spreadsheets.map((sheet) => ({
    id: sheet.id,
    title: sheet.title || "Untitled spreadsheet",
    tabs: sheet.tabs.map((tab) => ({ title: tab.title })),
  }))

  const initial: ApiFormInitial = {
    spreadsheetId: api.spreadsheetId,
    name: api.name,
    description: api.description ?? "",
    tabTitle: api.tabTitle,
    headerRow: api.headerRow,
    primaryKeyColumn: api.primaryKeyColumn ?? "",
    exposedColumns: api.exposedColumns,
    permissions: api.permissions,
    allowedOperations: api.allowedOperations,
    rateLimitPerHour: api.rateLimitPerHour,
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="Endpoint — Edit"
        title={`Edit “${api.name}”`}
        description="Change what this endpoint publishes. The same invariants apply on save: a tab must exist in the snapshot, and PATCH, PUT or DELETE need a primary-key column."
        action={
          <PillLink href={`/apis/${api.id}`} variant="line" size="sm">
            Back to endpoint
          </PillLink>
        }
      />

      <Panel as="section">
        <PanelBody>
          <ApiConfigForm sheets={sheets} apiId={api.id} initial={initial} />
        </PanelBody>
      </Panel>
    </div>
  )
}
