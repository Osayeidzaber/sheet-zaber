import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { StatusDot } from "@/components/ui/badge"
import { PillLink } from "@/components/ui/button"
import { CodeBlock } from "@/components/ui/code"
import { Panel, PanelBody, PanelHeader, PageHeader, Row, RowTitle } from "@/components/ui/panel"
import { Banner } from "@/components/ui/state"
import { Table, TableScroll, Td, Th, Tr, MonoCell } from "@/components/ui/table"
import { isActionError } from "@/lib/action-result"
import { formatDateTime, formatNumber, meta, shortId } from "@/lib/format"
import { requireUser } from "@/server/auth/guards"
import { findSpreadsheet } from "@/server/db/queries/spreadsheets"
import { listConnectionsAction } from "@/server/actions/connections"
import { RefreshTabsButton, RemoveSpreadsheetButton } from "@/app/(app)/spreadsheets/detail-controls"
import { TabPreview } from "@/app/(app)/spreadsheets/tab-preview"

type SpreadsheetPageProps = {
  params: Promise<{ spreadsheetId: string }>
}

export const metadata: Metadata = {
  title: "Spreadsheet",
  description: "A connected Google spreadsheet and its tabs.",
}

/*
 * Owner-scoped: `findSpreadsheet` (`queries/spreadsheets.ts:88`) reads by (userId, id), so a foreign
 * or missing id is `undefined` → `notFound()`, never an existence oracle. Everything rendered here is
 * the stored snapshot: tabs from `spreadsheets.get`, the header preview read live by `previewTab`,
 * and the connection email resolved from the caller's own `google_connections` rows.
 */

export default async function SpreadsheetDetailPage({ params }: SpreadsheetPageProps) {
  const { spreadsheetId } = await params
  const user = await requireUser()

  const sheet = await findSpreadsheet(user.id, spreadsheetId)
  if (sheet === undefined) notFound()

  const connectionsResult = await listConnectionsAction()
  const connection =
    isActionError(connectionsResult)
      ? undefined
      : connectionsResult.data.find((candidate) => candidate.id === sheet.connectionId)

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="Spreadsheet"
        title={sheet.title || "Untitled spreadsheet"}
        description="The tab snapshot Sheet Zaber reads for this workbook, its live header preview, and its connection status."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <PillLink href={`/apis/new?spreadsheet=${sheet.id}`} variant="line" size="sm">
              Create endpoint
            </PillLink>
            <RefreshTabsButton spreadsheetId={sheet.id} />
            <RemoveSpreadsheetButton spreadsheetId={sheet.id} title={sheet.title || "this spreadsheet"} />
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-3">
          <span className="folio">Status</span>
          {sheet.status === "active" ? (
            <StatusDot tone="active" label="Readable" />
          ) : (
            <StatusDot tone="failed" label="No access" />
          )}
        </div>
        <p className="font-mono text-[12px] text-dust">
          {meta(
            `${sheet.tabs.length} ${sheet.tabs.length === 1 ? "tab" : "tabs"}`,
            shortId(sheet.googleSheetId, 8, 4),
            connection ? connection.googleEmail : "connection unavailable",
            `updated ${formatDateTime(sheet.updatedAt.toISOString())}`
          )}
        </p>
      </div>

      {sheet.status !== "active" ? (
        <Banner
          tone="attention"
          title="Google no longer answers for this spreadsheet"
          body="Refresh the tabs to retry. If it stays unreadable, the sheet was deleted or moved, or the connecting Google account lost access — re-consent at /auth/google/connect, then refresh."
        />
      ) : null}

      <Panel as="section">
        <PanelHeader
          title="Tabs"
          description="The snapshot stored from Google's `spreadsheets.get`. A tab renamed upstream only appears after you refresh."
        />
        {sheet.tabs.length === 0 ? (
          <PanelBody>
            <p className="text-[13px] leading-[1.6] text-dust">
              No tabs were captured for this workbook. Refresh the tabs to pull them from Google.
            </p>
          </PanelBody>
        ) : (
          <TableScroll label="Spreadsheet tabs">
            <Table>
              <thead>
                <tr>
                  <Th>Tab title</Th>
                  <Th>Sheet id</Th>
                  <Th align="right">Rows</Th>
                  <Th align="right">Columns</Th>
                </tr>
              </thead>
              <tbody>
                {sheet.tabs.map((tab) => (
                  <Tr key={tab.id}>
                    <Td className="text-paper">{tab.title}</Td>
                    <Td>
                      <MonoCell value={String(tab.id)} title={`Google sheet gid ${tab.id}`} />
                    </Td>
                    <Td numeric>{formatNumber(tab.rows)}</Td>
                    <Td numeric>{formatNumber(tab.columns)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <Panel as="section">
        <PanelHeader
          title="Header preview"
          description="Reads the header row and the first ten records live from Google, exactly as an endpoint would detect its columns."
        />
        <PanelBody>
          {sheet.tabs.length === 0 ? (
            <p className="text-[13px] leading-[1.6] text-dust">
              Refresh the tabs first — a preview needs a tab name that exists in this snapshot.
            </p>
          ) : (
            <TabPreview spreadsheetId={sheet.id} tabs={sheet.tabs} />
          )}
        </PanelBody>
      </Panel>

      <Row as="div" className="flex-col items-start gap-2">
        <RowTitle
          title="Spreadsheet id"
          meta="The Sheet Zaber row id — endpoints reference this, not the Google link."
        />
        <CodeBlock label="sheet zaber id" code={sheet.id} />
      </Row>
    </div>
  )
}
