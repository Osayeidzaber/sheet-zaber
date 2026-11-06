import { Badge, isHttpMethod, MethodTag, StatusCode } from "@/components/ui/badge"
import { Panel, PanelHeader } from "@/components/ui/panel"
import { MonoCell, Pagination, Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import { formatBytes, formatDateTime, formatDuration, formatFull, meta, shortId } from "@/lib/format"
import type { LogRow } from "@/server/db/queries/logs"
import { logsHref, type LogFilterValues } from "./filter-params"

/*
 * The request-log table. Every cell is a real `LogRow` column (`api_request_logs`, whose
 * `api_name` and `user_email` are stored when the request is served), formatted with the shared
 * `src/lib/format.ts` helpers. The table has no invented fields: a row with no endpoint name
 * renders `—`, because a missing name must never be filled in by the UI.
 *
 * Row detail is a native <details> disclosure, because everything worth showing — path, ids,
 * bytes, origin — is ALREADY in `LogRow`. There is no hidden detail route and no second fetch.
 */

export type KeyInfo = { name: string; scopes: string[] }

export function LogTable({
  rows,
  total,
  values,
  page,
  totalPages,
  keyInfo,
  keysReadable,
}: {
  rows: LogRow[]
  total: number
  values: LogFilterValues
  page: number
  totalPages: number
  keyInfo: ReadonlyMap<string, KeyInfo>
  /** `false` = the key list failed to read, so a missing name must not be blamed on revocation. */
  keysReadable: boolean
}) {
  return (
    <Panel as="section">
      <PanelHeader
        title="Requests"
        description="Newest first, by log id. Timestamps are the server's clock, shown in UTC-agnostic local format."
      />
      <TableScroll label="Request log">
        <Table>
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Method</Th>
              <Th>Endpoint</Th>
              <Th align="right">Status</Th>
              <Th align="right">Duration</Th>
              <Th>Key</Th>
              <Th>Failure</Th>
              <Th>Detail</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const failed = row.statusCode >= 400
              const name = row.apiName
              const key = row.apiKeyId === null ? undefined : keyInfo.get(row.apiKeyId)

              return (
                <Tr key={row.id} interactive>
                  <Td className="whitespace-nowrap text-dust">
                    <span title={formatFull(row.createdAt.toISOString())}>
                      {formatDateTime(row.createdAt.toISOString())}
                    </span>
                  </Td>
                  <Td>
                    {isHttpMethod(row.method) ? (
                      <MethodTag method={row.method} />
                    ) : (
                      <span className="font-mono text-[12px]">{row.method}</span>
                    )}
                  </Td>
                  <Td>
                    <span className="block max-w-[220px] truncate text-paper" title={name ?? undefined}>
                      {name ?? "—"}
                    </span>
                    <span className="block font-mono text-[11px] text-dust">
                      {row.apiId !== null ? shortId(row.apiId) : name !== null ? "endpoint deleted" : "no endpoint"}
                    </span>
                  </Td>
                  <Td align="right">
                    <StatusCode code={row.statusCode} />
                  </Td>
                  <Td numeric>{formatDuration(row.durationMs)}</Td>
                  <Td>
                    <span className="block max-w-[180px] truncate">
                      {row.apiKeyId === null ? "—" : (key?.name ?? shortId(row.apiKeyId))}
                    </span>
                    <span className="block font-mono text-[11px] text-dust">
                      {row.apiKeyId === null
                        ? "no key id (dashboard call, or a bearer key that did not resolve)"
                        : !keysReadable
                          ? "key list unreadable — id only"
                          : key === undefined
                            ? "key not listed (revoked or regenerated)"
                            : meta(...key.scopes)}
                    </span>
                  </Td>
                  <Td>
                    {failed && row.errorCategory !== null ? (
                      <Badge variant="failed">{row.errorCategory}</Badge>
                    ) : failed ? (
                      // A 4xx/5xx with no category recorded is reported as exactly that.
                      <span className="font-mono text-[12px] text-dust">uncategorised</span>
                    ) : (
                      <span className="text-dust">—</span>
                    )}
                  </Td>
                  <Td>
                    <details className="group min-w-[150px]">
                      <summary className="cursor-pointer list-none font-mono text-[12px] text-dust marker:hidden group-open:text-paper">
                        <span aria-hidden="true">+</span>
                        <span>
                          Show
                          <span className="sr-only"> detail for log row {String(row.id)}</span>
                        </span>
                      </summary>
                      <dl className="mt-2 flex min-w-[240px] flex-col gap-1.5 border-l border-rule pl-3 text-[12px]">
                        <DetailLine label="Path" value={<MonoCell value={row.path} />} />
                        <DetailLine label="Log id" value={<MonoCell value={String(row.id)} />} />
                        <DetailLine
                          label="Bytes"
                          value={<MonoCell value={formatBytes(row.requestBytes)} />}
                        />
                        <DetailLine
                          label="Origin"
                          value={<MonoCell value={row.origin ?? "—"} />}
                        />
                        <DetailLine label="Account" value={<MonoCell value={row.userEmail ?? "—"} />} />
                        <DetailLine
                          label="Endpoint id"
                          value={<MonoCell value={row.apiId ?? "—"} />}
                        />
                        <DetailLine
                          label="Key id"
                          value={<MonoCell value={row.apiKeyId ?? "—"} />}
                        />
                      </dl>
                    </details>
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </Table>
      </TableScroll>

      <Pagination
        page={page}
        totalPages={totalPages}
        totalRows={total}
        buildHref={(next) => logsHref(values, { offset: (next - 1) * values.limit })}
      />
    </Panel>
  )
}

function DetailLine({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2">
      <dt className="folio shrink-0">{label}</dt>
      <dd className="min-w-0 break-all text-mist">{value}</dd>
    </div>
  )
}
