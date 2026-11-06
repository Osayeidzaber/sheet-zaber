import { ConnectionTest } from "@/app/(app)/apis/connection-test"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Badge, MethodTag, StatusDot, isHttpMethod } from "@/components/ui/badge"
import { PillLink } from "@/components/ui/button"
import { CopyField } from "@/components/ui/copy"
import { Panel, PanelBody, PanelHeader, PageHeader, Row, RowTitle } from "@/components/ui/panel"
import { ErrorState } from "@/components/ui/state"
import { SnippetTabs } from "@/components/ui/snippet-tabs"
import { isActionError } from "@/lib/action-result"
import { apiPublicId } from "@/lib/api-public-id"
import { formatDateTime, shortId } from "@/lib/format"
import type { SnippetRequest } from "@/lib/snippets"
import { requireUser } from "@/server/auth/guards"
import { getApi } from "@/server/apis/service"
import { findSpreadsheet } from "@/server/db/queries/spreadsheets"
import { ApiRowControls } from "@/app/(app)/apis/api-row-controls"

type ApiPageProps = {
  params: Promise<{ apiId: string }>
}

export const metadata: Metadata = {
  title: "Endpoint",
  description: "A published REST endpoint and its live request example.",
}

/*
 * The base URL uses the SAME pattern as the root layout (`src/app/layout.tsx:28`):
 * `process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"`. That inlines a public value at
 * build, so it is safe to compute HERE (a Server Component) and pass the finished string to the
 * client `CopyField`/`SnippetTabs` — we never import the `server-only` env into a client component.
 * No API key is rendered: keys are created and shown only in /keys (plan D10). The snippet's key is
 * a literal `<YOUR_API_KEY>` placeholder so we never fabricate a secret.
 */
export default async function ApiDetailPage({ params }: ApiPageProps) {
  const { apiId } = await params
  const user = await requireUser()

  const result = await getApi(apiId, user.id)
  if (isActionError(result)) {
    if (result.error.code === "not_found") notFound()
    return (
      <div className="flex flex-col gap-8">
        <PageHeader folio="Endpoint" title="Endpoint" />
        <ErrorState title="Endpoint could not be read" body={result.error.message} code={result.error.code} />
      </div>
    )
  }
  const api = result.data

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"
  const publicId = apiPublicId(api.name, api.shortId)
  const endpointUrl = `${siteUrl}/api/v1/${publicId}`
  const spreadsheet = await findSpreadsheet(user.id, api.spreadsheetId)

  const listRequest: SnippetRequest = {
    baseUrl: `${siteUrl}/api/v1`,
    method: "GET",
    apiId: publicId,
    apiKey: "<YOUR_API_KEY>",
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="Endpoint"
        title={api.name}
        description={api.description ?? "Published from one tab of a connected spreadsheet."}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <PillLink href={`/apis/${api.id}/edit`} variant="line" size="sm">
              Edit
            </PillLink>
            <ApiRowControls id={api.id} name={api.name} enabled={api.enabled} redirectAfterDelete="/apis" />
          </div>
        }
      />

      <Panel as="section">
        <PanelHeader
          title="Live URL"
          description="The public path the engine serves this endpoint at. It answers only with a Bearer key and only while the endpoint is enabled."
        />
        <PanelBody>
          <div className="flex flex-col gap-4">
            <CopyField value={endpointUrl} label="GET /api/v1/{api_id}" />
            <p className="text-[13px] leading-[1.6] text-dust">
              Requests need an API key with a scope that matches the verb. Keys are created and shown
              once in{" "}
              <Link href="/keys" className="text-paper underline">
                Keys
              </Link>{" "}
              — none is stored or displayed here.
            </p>
            {!api.enabled ? (
              <p className="border-l-2 border-warn bg-lift px-4 py-3 text-[13px] leading-[1.6] text-paper">
                This endpoint is disabled: live requests to it return not-found until you re-enable it
                above.
              </p>
            ) : null}
          </div>
        </PanelBody>
      </Panel>

      <Panel as="section">
        <PanelHeader
          title="Connection test"
          description="Checks the Google grant, the sheet and the header row, then shows the tab this endpoint serves."
        />
        <PanelBody>
          <ConnectionTest
            spreadsheetId={api.spreadsheetId}
            tabTitle={api.tabTitle}
            headerRow={api.headerRow}
            enabled={api.enabled}
            exposedColumns={api.exposedColumns}
            primaryKey={api.primaryKeyColumn}
          />
        </PanelBody>
      </Panel>

      <Panel as="section">
        <PanelHeader title="Configuration" description="Stored values from the endpoint's configuration row." />
        <div>
          <Row>
            <RowTitle title="Status" meta="Enabled endpoints serve; disabled ones read as absent to callers." />
            <StatusDot tone={api.enabled ? "active" : "idle"} label={api.enabled ? "Enabled" : "Disabled"} />
          </Row>
          <Row>
            <RowTitle title="Permissions" meta="Read-only endpoints never accept a write verb." />
            <Badge variant={api.permissions === "read_write" ? "inverted" : "neutral"}>
              {api.permissions === "read_write" ? "Read & write" : "Read"}
            </Badge>
          </Row>
          <Row>
            <RowTitle title="Allowed methods" meta="The verbs the engine will honour for this endpoint." />
            <span className="flex flex-wrap justify-end gap-1">
              {api.allowedOperations.map((method) =>
                isHttpMethod(method) ? <MethodTag key={method} method={method} /> : <Badge key={method}>{method}</Badge>
              )}
            </span>
          </Row>
          <Row>
            <RowTitle title="Spreadsheet & tab" />
            <span className="text-right text-[14px] text-mist">
              {spreadsheet ? (
                <Link href={`/spreadsheets/${spreadsheet.id}`} className="text-paper underline">
                  {spreadsheet.title || "Untitled spreadsheet"}
                </Link>
              ) : (
                <span className="text-dust">spreadsheet removed</span>
              )}
              <span className="block font-mono text-[12px] text-dust">
                {api.tabTitle}
                {spreadsheet ? ` · ${shortId(api.spreadsheetId, 6, 4)}` : ""}
              </span>
            </span>
          </Row>
          <Row>
            <RowTitle title="Header row" meta="The row holding column names." />
            <span className="num text-[14px] text-paper">{api.headerRow}</span>
          </Row>
          <Row>
            <RowTitle
              title="Primary key column"
              meta="Rows are addressed by this value, never by row number."
            />
            <span className="text-right text-[14px]">
              {api.primaryKeyColumn ? (
                <span className="font-mono text-[13px] text-paper">{api.primaryKeyColumn}</span>
              ) : (
                <span className="text-dust">none — read & append only</span>
              )}
            </span>
          </Row>
          <Row>
            <RowTitle title="Exposed columns" meta="Hidden columns cannot be read, filtered, searched or written here." />
            {api.exposedColumns ? (
              <span className="flex max-w-full flex-wrap justify-end gap-1">
                {api.exposedColumns.map((column) => (
                  <Badge key={column}>{column}</Badge>
                ))}
              </span>
            ) : (
              <span className="text-[14px] text-mist">Every column</span>
            )}
          </Row>
          <Row>
            <RowTitle title="Rate limit" meta="Per-hour override for this endpoint." />
            <span className="text-[14px] text-mist">
              {api.rateLimitPerHour === null ? "platform default (1000/hr)" : `${api.rateLimitPerHour.toLocaleString("en-US")} / hr`}
            </span>
          </Row>
          <Row>
            <RowTitle title="Created / updated" />
            <span className="text-right font-mono text-[12px] text-dust">
              {formatDateTime(api.createdAt.toISOString())}
              <span className="block">{formatDateTime(api.updatedAt.toISOString())}</span>
            </span>
          </Row>
        </div>
      </Panel>

      <Panel as="section">
        <PanelHeader
          title="Request example"
          description="A real list request for this endpoint, built from the shared snippet builders. Replace <YOUR_API_KEY> with a key from /keys."
        />
        <PanelBody>
          <SnippetTabs request={listRequest} />
        </PanelBody>
      </Panel>
    </div>
  )
}
