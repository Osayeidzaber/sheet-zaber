import type { Metadata } from "next"
import Link from "next/link"

import { Badge, MethodTag, isHttpMethod } from "@/components/ui/badge"
import { PillLink } from "@/components/ui/button"
import { Metric, PageHeader, Panel } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/state"
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import { isActionError } from "@/lib/action-result"
import { formatDateTime, formatNumber, meta } from "@/lib/format"
import { requireUser } from "@/server/auth/guards"
import { listApis } from "@/server/apis/service"
import { listSpreadsheets } from "@/server/db/queries/spreadsheets"
import { ApiRowControls } from "@/app/(app)/apis/api-row-controls"

export const metadata: Metadata = {
  title: "Endpoints",
  description: "The REST endpoints your connected spreadsheets publish.",
}

export default async function ApisPage() {
  const user = await requireUser()

  const apisResult = await listApis(user.id)
  const spreadsheets = await listSpreadsheets(user.id)
  const titlesById = new Map(spreadsheets.map((sheet) => [sheet.id, sheet.title || "Untitled spreadsheet"]))

  if (isActionError(apisResult)) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader folio="03 — Endpoints" title="Endpoints" titleAside="published" />
        <ErrorState
          title="Endpoints could not be read"
          body={apisResult.error.message}
          code={apisResult.error.code}
          action={
            <PillLink href="/apis" variant="line" size="sm">
              Retry
            </PillLink>
          }
        />
      </div>
    )
  }

  const apis = apisResult.data
  const enabled = apis.filter((api) => api.enabled).length
  const writable = apis.filter((api) => api.permissions === "read_write").length

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="03 — Endpoints"
        title="Endpoints" titleAside="published"
        description="Each endpoint publishes one tab of one connected spreadsheet as a REST API, addressed at /api/v1/<endpoint id>. Every call needs an API key you create in Keys."
        action={
          <PillLink href="/apis/new" variant="solid" size="md">
            New endpoint
          </PillLink>
        }
      />

      <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Metric label="Endpoints" value={formatNumber(apis.length)} sub={meta(`${enabled} enabled`, `${apis.length - enabled} disabled`)} />
        <Metric label="Enabled" value={formatNumber(enabled)} sub="serving requests now" />
        <Metric label="Read & write" value={formatNumber(writable)} sub={`${apis.length - writable} read-only`} />
      </section>

      <Panel as="section">
        {apis.length === 0 ? (
          <EmptyState
            className="border-0"
            title="No endpoints yet"
            body="An endpoint turns one tab of a connected spreadsheet into a REST API. You can only build one once a spreadsheet is connected — keys never appear here; they live in Keys."
            action={
              spreadsheets.length === 0 ? (
                <PillLink href="/spreadsheets" variant="solid" size="md">
                  Connect a spreadsheet
                </PillLink>
              ) : (
                <PillLink href="/apis/new" variant="solid" size="md">
                  Create endpoint
                </PillLink>
              )
            }
          />
        ) : (
          <TableScroll label="API endpoints">
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Tab</Th>
                  <Th>Permissions</Th>
                  <Th>Methods</Th>
                  <Th align="right">Limit / hr</Th>
                  <Th>Created</Th>
                  <Th align="right">Status & actions</Th>
                </tr>
              </thead>
              <tbody>
                {apis.map((api) => (
                  <Tr key={api.id} interactive>
                    <Td>
                      <Link href={`/apis/${api.id}`} className="text-[14px] font-semibold text-paper hover:underline">
                        {api.name}
                      </Link>
                      <span className="block truncate font-mono text-[12px] text-dust">
                        {titlesById.get(api.spreadsheetId) ?? "spreadsheet removed"}
                      </span>
                    </Td>
                    <Td className="text-paper">{api.tabTitle}</Td>
                    <Td>
                      <Badge variant={api.permissions === "read_write" ? "inverted" : "neutral"}>
                        {api.permissions === "read_write" ? "Read & write" : "Read"}
                      </Badge>
                    </Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {api.allowedOperations.map((method) =>
                          isHttpMethod(method) ? <MethodTag key={method} method={method} /> : <Badge key={method}>{method}</Badge>
                        )}
                      </span>
                    </Td>
                    <Td numeric>
                      {api.rateLimitPerHour === null ? (
                        <span className="text-dust">default</span>
                      ) : (
                        formatNumber(api.rateLimitPerHour)
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-dust">{formatDateTime(api.createdAt.toISOString())}</Td>
                    <Td align="right">
                      <ApiRowControls id={api.id} name={api.name} enabled={api.enabled} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      {apis.some((api) => api.permissions === "read_write" && api.primaryKeyColumn === null) ? (
        <p className="text-[13px] leading-[1.6] text-dust">
          Endpoints without a primary-key column are read-and-append only: PATCH, PUT and DELETE will
          be rejected until a key column is set.
        </p>
      ) : null}
    </div>
  )
}
