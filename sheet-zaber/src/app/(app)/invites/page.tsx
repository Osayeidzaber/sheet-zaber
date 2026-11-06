import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { PageHeader, Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/state"
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import { formatDateTime } from "@/lib/format"
import { requireUser } from "@/server/auth/guards"
import { listInvitations } from "@/server/db/queries/invitations"
import { findUserById } from "@/server/db/queries/users"

import { NewCode } from "./new-code"

export const metadata: Metadata = { title: "Invites" }

export default async function InvitesPage() {
  const user = await requireUser()
  if (user.role === "owner") redirect("/admin/invitations")

  const row = await findUserById(user.id)
  if (!row?.canInvite) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader folio="09 — Invites" title="Invites" />
        <ErrorState title="You can't create invitation codes" body="The owner of this instance has to give your account permission first." code="forbidden" />
      </div>
    )
  }

  const mine = (await listInvitations()).filter((invitation) => invitation.createdBy === user.id)
  const now = new Date().getTime()

  return (
    <div className="flex flex-col gap-8">
      <PageHeader folio="09 — Invites" title="Invites" titleAside="you issued" description="Each code lets one person join and lasts 7 days." />
      <Panel as="section">
        <PanelHeader title="New code" />
        <PanelBody>
          <NewCode />
        </PanelBody>
      </Panel>
      <Panel as="section">
        <PanelHeader title="Your codes" description="The code itself is never shown again. The owner can revoke any of these." />
        {mine.length === 0 ? (
          <PanelBody>
            <EmptyState title="No codes yet" body="Codes you create will be listed here." />
          </PanelBody>
        ) : (
          <TableScroll label="Invitation codes you created">
            <Table>
              <thead>
                <tr>
                  <Th>Created</Th>
                  <Th>Expires</Th>
                  <Th>State</Th>
                </tr>
              </thead>
              <tbody>
                {mine.map((invitation) => {
                  const state = invitation.revokedAt
                    ? "Revoked"
                    : invitation.uses >= invitation.maxUses
                      ? "Used"
                      : invitation.expiresAt && invitation.expiresAt.getTime() <= now
                        ? "Expired"
                        : "Open"
                  return (
                    <Tr key={invitation.id}>
                      <Td className="whitespace-nowrap text-dust">{formatDateTime(invitation.createdAt.toISOString())}</Td>
                      <Td className="whitespace-nowrap text-dust">{invitation.expiresAt ? formatDateTime(invitation.expiresAt.toISOString()) : "Never"}</Td>
                      <Td>
                        <Badge variant={state === "Open" ? "inverted" : "neutral"}>{state}</Badge>
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>
    </div>
  )
}
