import type { Metadata } from "next"
import Link from "next/link"

import { Badge, StatusDot } from "@/components/ui/badge"
import { Metric, PageHeader, Panel } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/state"
import { Table, TableScroll, Td, Th, Tr, MonoCell } from "@/components/ui/table"
import { isActionError } from "@/lib/action-result"
import { formatDateTime, formatNumber, shortId } from "@/lib/format"
import { requireUser } from "@/server/auth/guards"
import { listSpreadsheets } from "@/server/db/queries/spreadsheets"
import { listConnectionsAction } from "@/server/actions/connections"
import { ConnectDialog } from "@/app/(app)/spreadsheets/connect-dialog"

export const metadata: Metadata = {
  title: "Spreadsheets",
  description: "The Google Sheets you have connected to Sheet Zaber.",
}

/*
 * Reads are real and owner-scoped only: `listSpreadsheets` returns the caller's stored rows
 * (`queries/spreadsheets.ts:75`) and `listConnectionsAction` the caller's Google accounts. A connect needs
 * a Google account, so when the connection read fails we say so instead of guessing the account
 * list, and the connect dialog opens on the honest "connect an account first" state.
 */

export default async function SpreadsheetsPage() {
  const user = await requireUser()

  const spreadsheets = await listSpreadsheets(user.id)
  const connectionsResult = await listConnectionsAction()
  const connections = isActionError(connectionsResult) ? null : connectionsResult.data

  const accounts =
    connections === null
      ? []
      : connections.map((connection) => ({
          id: connection.id,
          googleEmail: connection.googleEmail,
          status: connection.status,
        }))

  const active = spreadsheets.filter((sheet) => sheet.status === "active").length

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="02 — Spreadsheets"
        title="Spreadsheets" titleAside="on record"
        description="Connect a Google Sheet by pasting its link; Sheet Zaber confirms access with your own connection, then publishes its tabs as API endpoints."
        action={<ConnectDialog accounts={accounts} />}
      />

      {connections === null ? (
        <ErrorState
          title="Google connections could not be read"
          body="Your connected spreadsheets are shown below, but we could not read your Google accounts, so the connect dialog cannot list an account to connect through. Reload this page; if it persists, tell the operator."
          code={isActionError(connectionsResult) ? connectionsResult.error.code : undefined}
        />
      ) : null}

      <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Metric label="Connected" value={formatNumber(spreadsheets.length)} sub={`${spreadsheets.length} ${spreadsheets.length === 1 ? "workbook" : "workbooks"}`} />
        <Metric label="Readable" value={formatNumber(active)} sub={`${spreadsheets.length - active} inaccessible`} tone={spreadsheets.length - active > 0 ? "failed" : "neutral"} />
        <Metric
          label="Google accounts"
          value={connections === null ? "—" : formatNumber(connections.length)}
          sub={connections === null ? "unreadable" : connections.length === 0 ? "none connected" : `${connections.filter((c) => c.status === "connected").length} active`}
        />
      </section>

      <Panel as="section">
        {spreadsheets.length === 0 ? (
          <EmptyState
            className="border-0"
            title="No spreadsheets connected yet"
            body="Paste a Google Sheets link and Sheet Zaber will verify it through one of your connected Google accounts, then store its tabs. You can turn any tab into a REST endpoint once it is here."
            action={<ConnectDialog accounts={accounts} />}
          />
        ) : (
          <TableScroll label="Connected spreadsheets">
            <Table>
              <thead>
                <tr>
                  <Th>Title</Th>
                  <Th align="right">Tabs</Th>
                  <Th>Status</Th>
                  <Th>Updated</Th>
                  <Th align="right">Open</Th>
                </tr>
              </thead>
              <tbody>
                {spreadsheets.map((sheet) => (
                  <Tr key={sheet.id} interactive>
                    <Td>
                      <Link href={`/spreadsheets/${sheet.id}`} className="text-[14px] font-semibold text-paper hover:underline">
                        {sheet.title || "Untitled spreadsheet"}
                      </Link>
                      <MonoCell value={shortId(sheet.googleSheetId, 8, 4)} title={sheet.googleSheetId} />
                    </Td>
                    <Td numeric>{formatNumber(sheet.tabs.length)}</Td>
                    <Td>
                      {sheet.status === "active" ? (
                        <StatusDot tone="active" label="Readable" />
                      ) : (
                        <StatusDot tone="failed" label="No access" />
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-dust">{formatDateTime(sheet.updatedAt.toISOString())}</Td>
                    <Td align="right">
                      <Badge variant="outline" className="justify-self-end">
                        Manage
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      {spreadsheets.length > 0 ? (
        <p className="text-[13px] leading-[1.6] text-dust">
          “No access” means Google stopped answering for that sheet — it was deleted, moved, or your
          connection needs re-consent. Open it to refresh tabs and see the exact reason.
        </p>
      ) : null}
    </div>
  )
}
