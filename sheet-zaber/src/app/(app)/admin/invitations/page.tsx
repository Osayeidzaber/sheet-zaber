import type { Metadata } from "next"

import { Badge } from "@/components/ui/badge"
import { PageHeader, Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/state"
import { isActionError } from "@/lib/action-result"
import { formatDateTime, formatNumber, shortId } from "@/lib/format"
import { requireOwner } from "@/server/auth/guards"
import { listInvitationsForAdmin } from "@/server/invitations/service"
import { CreateInvitationForm } from "./create-invitation-form"
import { InviteEmailForm } from "./invite-email-form"
import { InvitationTable, type InvitationRowView } from "./invitation-table"
import { deriveInvitationStatus, STATUS_COPY } from "./invitation-status"

export const metadata: Metadata = {
  title: "Admin · Invitations",
  description: "Issue invitation codes once, see what they did, and revoke the ones that should not exist.",
}

/*
 * The invitation ledger, from `listInvitationsForAdmin()`: every invitation row plus who redeemed it.
 * `code_hash` is excluded by the repository, and a plaintext code is never available for any row.
 *
 * The list has no pagination because the route has none: `listInvitations()` is a bare newest-first
 * SELECT with no LIMIT (`invitations.ts:86`). Every issued row is shown.
 */

function day(value: Date | null): string {
  return value === null ? "—" : formatDateTime(value.toISOString())
}

export default async function AdminInvitationsPage() {
  // Re-asserted here, not only in the layout: this page reads every invitation row on the platform.
  await requireOwner()
  const result = await listInvitationsForAdmin()
  const now = new Date()

  if (isActionError(result)) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          folio="A3 — Admin · Invitations"
          title="Invitations"
          description="Issue codes and see what has been spent."
        />
        <ErrorState
          title="The invitation list could not be read"
          body={`${result.error.message} No rows and no counts are shown: an empty table here would read as "no codes issued", which the database did not say.`}
          code={result.error.code}
          action={
            <a href="/admin/invitations" className="pill pill-line min-h-10 px-4 text-[14px]">
              Try again
            </a>
          }
        />
      </div>
    )
  }

  const rows = result.data
  const views: InvitationRowView[] = []
  let openCount = 0
  let revokedCount = 0

  for (const row of rows) {
    const status = deriveInvitationStatus(row, now)
    const copy = STATUS_COPY[status]
    if (status === "active") openCount += 1
    if (status === "revoked") revokedCount += 1
    views.push({
      id: row.id,
      name: row.label ?? "unlabeled code",
      rowId: shortId(row.id),
      statusLabel: copy.label,
      statusTone: copy.tone,
      statusReading: copy.reading,
      uses: `${formatNumber(row.uses)} of ${formatNumber(row.maxUses)}`,
      redeemedBy: row.redemptions.map((redemption) => redemption.email),
      expires: day(row.expiresAt),
      created: day(row.createdAt),
      issuedBy: shortId(row.createdBy),
      revoked: row.revokedAt !== null,
      // The gate names the object: a labeled batch is typed by its label, an anonymous row by the
      // fixed word, because there is nothing in the payload to type instead.
      confirmText: row.label ?? "revoke",
    })
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="A3 — Admin · Invitations"
        title="Invitations"
        description="Codes are minted here, hashed on the way in, and readable exactly once. Everything after that is counts and dates — the value itself is gone."
        action={
          <>
            <Badge variant="neutral">
              {formatNumber(views.length)} {views.length === 1 ? "row" : "rows"}
            </Badge>
            <Badge variant="inverted">{formatNumber(openCount)} open</Badge>
            {revokedCount > 0 ? (
              <Badge variant="failed">{formatNumber(revokedCount)} revoked</Badge>
            ) : null}
          </>
        }
      />

      <InviteEmailForm />

      <CreateInvitationForm />

      <Panel as="section">
        <PanelHeader
          title="Issued codes"
          description={`Newest first, every row the table holds — this route has no pagination and no limit. A code whose redeemer later deleted their account still counts the use, but no longer names them.`}
        />

        {views.length === 0 ? (
          <PanelBody>
            <EmptyState
              title="No invitation code has been issued yet"
              body="The `invitations` table is empty, so nothing exists to revoke or report. Issue a batch above and the rows will appear here with their use counts — but never with their values a second time."
            />
          </PanelBody>
        ) : (
          <InvitationTable rows={views} />
        )}
      </Panel>
    </div>
  )
}
