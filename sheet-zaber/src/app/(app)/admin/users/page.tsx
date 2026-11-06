import type { Metadata } from "next"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { PanelHeader, PageHeader, Panel, PanelBody } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/state"
import { Pagination } from "@/components/ui/table"
import { isActionError } from "@/lib/action-result"
import { formatDateTime, formatNumber, shortId } from "@/lib/format"
import { requireOwner } from "@/server/auth/guards"
import { listUsers } from "@/server/admin/users"
import { AdminUserTable, type AdminUserRowView } from "./user-table"

export const metadata: Metadata = {
  title: "Admin · Users",
  description: "Every account on the platform: role, status, invitation used, and what they have built.",
}

/*
 * The owner's census. The data path is `listUsers()` from `src/server/admin/users.ts:148` — the exact
 * function `GET /api/internal/admin/users` binds (`src/app/api/internal/admin/users/route.ts:21`), so
 * this page and that route cannot disagree about what a row means. Both are guarded: the route by
 * `ownerRoute`, this render by `requireOwner()` in the layout plus the call below, and the read itself
 * re-checks `can(role, "user.list")`.
 *
 * The ten columns are the §4.6 `AdminUserRow` projection and nothing more (`users.ts:61`): `googleSub`,
 * `updatedAt` and the profile columns are projected away inside the service, and an invitation is the
 * ROW ID ONLY — there is no code, no `code_hash` and no plaintext in this payload to render.
 *
 * Pagination is server-side and lives in the URL: the service takes `page`/`per_page` as
 * `number | string` and validates them itself (`users.ts:130-162`), so the raw query value is
 * forwarded rather than re-parsed here. An invalid page is therefore the service's refusal, shown as
 * an error, and no table is drawn under a header that would then be lying.
 */

const PER_PAGE = 50

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function day(value: Date | null): string {
  return value === null ? "—" : formatDateTime(value.toISOString())
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const owner = await requireOwner()
  const params = await searchParams
  const result = await listUsers(owner, first(params.page), PER_PAGE)

  if (isActionError(result)) {
    const pageError = result.error.fields?.page ?? result.error.fields?.per_page
    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          folio="A2 — Admin · Users"
          title="Users"
          description="Every account on the platform, newest first."
        />
        <ErrorState
          title="The account list could not be read"
          body={
            pageError !== undefined
              ? `${result.error.message} ${pageError} — no rows are shown, because the page you asked for was not a page the service would run.`
              : `${result.error.message} No rows are shown: a table drawn under a failed read would be a guess.`
          }
          code={result.error.code}
          action={
            <Link href="/admin/users" className="pill pill-line min-h-10 px-4 text-[14px]">
              Load page 1
            </Link>
          }
        />
      </div>
    )
  }

  const { rows, total, page, perPage } = result.data
  const totalPages = Math.max(1, Math.ceil(total / perPage))

  const views: AdminUserRowView[] = rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    // `invitations.label` is the owner's own memo; with none, the row id is the only honest handle.
    invite: row.invitationLabel ?? shortId(row.invitationId),
    hasInvitation: row.invitationId !== null,
    apiCount: formatNumber(row.apiCount),
    requestTotal: formatNumber(row.requestTotal),
    apiLimitPerDay: row.apiLimitPerDay,
    limitLabel: row.role === "owner" || row.apiLimitPerDay === 0 ? "Unlimited" : formatNumber(row.apiLimitPerDay),
    lastLogin: day(row.lastLoginAt),
    createdAt: day(row.createdAt),
    isSelf: row.id === owner.id,
  }))

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="A2 — Admin · Users"
        title="Users"
        description="Every account on the platform with the invitation that admitted it, what it has built, and the role the database — not the cookie — is honouring right now."
        action={
          <Badge variant="neutral">
            {formatNumber(total)} {total === 1 ? "account" : "accounts"}
          </Badge>
        }
      />

      <Panel as="section">
        <PanelHeader
          title="Accounts"
          description="Disabling is not a pending change: session verification re-reads `users.status` on every request, so the account is out of the console on its next call and its endpoints stop serving. Promote and demote are audited, and the server refuses to leave the platform without an active owner."
        />

        {views.length === 0 ? (
          <PanelBody>
            <EmptyState
              title="No accounts to show on this page"
              body={
                total === 0
                  ? "The `users` table is empty, so there is nothing to administer. Sign in with the owner address the platform was configured with and the first row will appear here."
                  : `This page requested page ${page} of ${totalPages}; the accounts are on an earlier page.`
              }
              action={
                total > 0 ? (
                  <Link href="/admin/users" className="pill pill-line min-h-10 px-4 text-[14px]">
                    Back to page 1
                  </Link>
                ) : undefined
              }
            />
          </PanelBody>
        ) : (
          <>
            <AdminUserTable rows={views} />
            <Pagination
              page={page}
              totalPages={totalPages}
              totalRows={total}
              buildHref={(next) => `/admin/users?page=${next}`}
            />
          </>
        )}
      </Panel>
    </div>
  )
}
