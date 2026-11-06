import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Badge, StatusDot } from "@/components/ui/badge"
import { PageHeader, Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/state"
import { MonoCell, Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import { isActionError } from "@/lib/action-result"
import { formatDateTime, formatNumber } from "@/lib/format"
import { getUserDetail, listAdminUserKeys } from "@/server/admin/user-detail"
import { requireOwner } from "@/server/auth/guards"

export const metadata: Metadata = {
  title: "Admin · User",
  description: "One account: its usage, its daily limit and its API keys.",
}

function day(value: Date | null): string {
  return value === null ? "—" : formatDateTime(value.toISOString())
}

function keyState(key: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): string {
  if (key.revokedAt !== null) return "Revoked"
  if (key.expiresAt !== null && key.expiresAt <= now) return "Expired"
  return "Active"
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="folio">{label}</dt>
      <dd className="mt-1 text-[15px] text-paper">{value}</dd>
    </div>
  )
}

export default async function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const owner = await requireOwner()
  const { userId } = await params
  const [detail, keys] = await Promise.all([getUserDetail(userId, owner), listAdminUserKeys(userId, owner)])

  if (isActionError(detail)) {
    if (detail.error.code === "not_found") notFound()
    return (
      <ErrorState
        title="This account could not be read"
        body={detail.error.message}
        code={detail.error.code}
        action={
          <Link href="/admin/users" className="pill pill-line min-h-10 px-4 text-[14px]">
            Back to users
          </Link>
        }
      />
    )
  }

  const user = detail.data
  const now = new Date()
  // Owners and a stored 0 skip the daily window (`engine/ratelimit.ts`), so neither has a number to show.
  const limit =
    user.role === "owner" || user.apiLimitPerDay === 0 ? "Unlimited" : `${formatNumber(user.apiLimitPerDay)} a day`

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="A2 — Admin · Users"
        title={user.email}
        description="Change the role, status or daily limit from the users table."
        action={
          <>
            <Badge variant={user.role === "owner" ? "inverted" : "neutral"}>
              {user.role === "owner" ? "Owner" : "User"}
            </Badge>
            <StatusDot
              tone={user.status === "active" ? "active" : "failed"}
              label={user.status === "active" ? "Active" : "Disabled"}
            />
          </>
        }
      />

      <Panel as="section">
        <PanelHeader title="Usage" />
        <PanelBody>
          <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Requests today (UTC)" value={formatNumber(user.requestsToday)} />
            <Fact label="Requests all time" value={formatNumber(user.requestTotal)} />
            <Fact label="Daily limit" value={limit} />
            <Fact label="Endpoints" value={formatNumber(user.apiCount)} />
            <Fact label="Spreadsheets" value={formatNumber(user.spreadsheetCount)} />
            <Fact label="Active keys" value={formatNumber(user.activeKeyCount)} />
            <Fact label="Last login" value={day(user.lastLoginAt)} />
            <Fact label="Joined" value={day(user.createdAt)} />
          </dl>
        </PanelBody>
      </Panel>

      <Panel as="section">
        <PanelHeader title="API keys" description="Previews only. A key's full value is never stored." />
        {isActionError(keys) ? (
          <PanelBody>
            <ErrorState title="The keys could not be read" body={keys.error.message} code={keys.error.code} />
          </PanelBody>
        ) : keys.data.rows.length === 0 ? (
          <PanelBody>
            <EmptyState title="No API keys" body="This account has not created a key." />
          </PanelBody>
        ) : (
          <TableScroll label="API keys for this account">
            <Table>
              <thead>
                <tr>
                  <Th>Key</Th>
                  <Th>Scopes</Th>
                  <Th>State</Th>
                  <Th align="right">Requests</Th>
                  <Th>Last used</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {keys.data.rows.map((key) => (
                  <Tr key={key.id}>
                    <Td>
                      <span className="block max-w-[240px] truncate text-paper">{key.name}</span>
                      <MonoCell value={key.preview} />
                    </Td>
                    <Td className="font-mono text-[12px]">{key.scopes.join(", ")}</Td>
                    <Td>{keyState(key, now)}</Td>
                    <Td numeric>{formatNumber(key.requestCount)}</Td>
                    <Td className="whitespace-nowrap text-dust">{day(key.lastUsedAt)}</Td>
                    <Td className="whitespace-nowrap text-dust">{day(key.createdAt)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <Link href="/admin/users" className="pill pill-line min-h-10 w-fit px-4 text-[14px]">
        Back to users
      </Link>
    </div>
  )
}
