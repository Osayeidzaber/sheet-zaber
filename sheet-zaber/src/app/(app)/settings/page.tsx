import type { Metadata } from "next"

import { Badge } from "@/components/ui/badge"
import { Button, PillLink } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy"
import { InlineCode } from "@/components/ui/code"
import {
  PageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  Row,
  RowTitle,
} from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/state"
import { MonoCell } from "@/components/ui/table"
import { isActionError } from "@/lib/action-result"
import { formatDateTime, formatNumber, meta } from "@/lib/format"
import { requireUser } from "@/server/auth/guards"
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/server/auth/session"
import { listConnectionsAction } from "@/server/actions/connections"
import { ConnectionsPanel, type ConnectionView } from "./connections-panel"
import { RetryRead } from "./retry-read"

export const metadata: Metadata = {
  title: "Settings",
  description:
    "Your account, your Google connections and this session — everything here is a value the backend actually publishes.",
}

/*
 * `/settings` shows only what `docs/backend-api-contract.md` §2 and §4.6 make available to the
 * session user, because the SaaS-template version of this screen is mostly features the product
 * does not have. One mutation exists — disconnecting a Google connection (§4.7) — and everything
 * else is reference information. Where a control is genuinely missing, the last panel says why in
 * one sentence and cites the section that closed it, instead of shipping a disabled fake form.
 *
 * Reads: `requireUser()` (id, email, DB role) and `listConnectionsAction()` — the authenticated
 * `ActionResult<Connection[]>` used for connection status. A failed read is reported as a failed
 * read; no connection list is invented.
 */

/** `604800` → `7`; rendered as days, with the raw constant beside it so nothing is rounded away. */
const SESSION_DAYS = SESSION_MAX_AGE_SECONDS / 86400


export default async function SettingsPage() {
  const user = await requireUser()
  const connectionsResult = await listConnectionsAction()
  const connections = isActionError(connectionsResult) ? null : connectionsResult.data

  const rows: ConnectionView[] = (connections ?? []).map((connection) => ({
    id: connection.id,
    googleEmail: connection.googleEmail,
    scope: connection.scope,
    status: connection.status,
    connectedLabel: formatDateTime(connection.connectedAt.toISOString()),
    lastUsedLabel:
      connection.lastUsedAt === null ? null : formatDateTime(connection.lastUsedAt.toISOString()),
  }))

  const usable = connections?.filter((connection) => connection.status === "connected").length ?? null
  const needsReauth =
    connections?.filter((connection) => connection.status === "reauth_required").length ?? null

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="08 — Settings"
        title="Settings" titleAside="and connections"
        description="The account you are signed in as, the Google connections behind your data, and this session. One thing here is editable — a connection you want removed — because that is the only write the backend publishes for a member account."
        action={
          <PillLink href="/keys" variant="line" size="sm">
            API keys
          </PillLink>
        }
      />

      {connections === null ? (
        <ErrorState
          title="Google connections could not be read"
          body={
            isActionError(connectionsResult)
              ? connectionsResult.error.message
              : "The connection list failed to load."
          }
          code={isActionError(connectionsResult) ? connectionsResult.error.code : "read_failed"}
          action={<RetryRead label="Retry the connection read" />}
        />
      ) : null}

      {/* ------------------------------------------------------------ account (read-only) */}
      <Panel as="section">
        <PanelHeader
          title="Account"
          description="Read from the session guard: requireUser() re-reads your users row on every request, so these three values are the database's, not the cookie's."
        />
        <div>
          <Row>
            <RowTitle
              title="Email"
              meta="users.email — the address your Google consent verified. No edit path exists."
            />
            <span className="min-w-0 break-all text-right text-[14px] text-paper">
              {user.email}
            </span>
          </Row>
          <Row>
            <RowTitle
              title="Role"
              meta="Decides which pages you can open: owner adds /admin. Changing it is an owner action, never self-service."
            />
            <Badge variant={user.role === "owner" ? "inverted" : "neutral"}>
              {user.role === "owner" ? "Owner" : "Member"}
            </Badge>
          </Row>
          <Row>
            <RowTitle
              title="Account id"
              meta="users.id. The owner sees it in the admin user list; support questions quote it."
            />
            <span className="flex min-w-0 items-center justify-end gap-2">
              <MonoCell value={user.id} title={`Account id ${user.id}`} />
              <CopyButton value={user.id} label="Copy id" />
            </span>
          </Row>
        </div>
        <PanelBody className="border-t border-rule">
          <p className="text-[13px] leading-[1.7] text-dust">
            Nothing on this panel is a form, because the backend exposes no update for it. Identity
            comes from the invitation plus your Google consent; the fields above are shown as facts.
            Name and picture are copied from Google into <InlineCode>user_profiles</InlineCode> at
            sign-in and the dashboard publishes no read or write for them.
          </p>
        </PanelBody>
      </Panel>

      {/* ------------------------------------------------------------ google connections */}
      <Panel as="section">
        <PanelHeader
          title="Google connections"
          description="Each row is one encrypted Google grant stored against your account — GET /api/internal/connections, status included. Tokens, their ciphertext and the owning user id are never sent to the browser."
          action={
            <PillLink href="/auth/google/connect" prefetch={false} variant="solid" size="sm">
              Connect a Google account
            </PillLink>
          }
        />

        {connections === null ? null : rows.length === 0 ? (
          <EmptyState
            className="border-0"
            title="No Google account connected"
            body="This is a real state, not an error: your Sheet Zaber account works, but with no stored Google grant nothing can be registered, and every spreadsheet read or write your endpoints perform goes through one of these connections. Connect an account — the paste flow on /spreadsheets needs one before it can verify access."
            action={
              <PillLink href="/auth/google/connect" prefetch={false} variant="solid" size="md">
                Connect a Google account
              </PillLink>
            }
          />
        ) : (
          <ConnectionsPanel rows={rows} />
        )}

        <PanelBody className="flex flex-col gap-3 border-t border-rule text-[13px] leading-[1.7] text-dust">
          {connections === null ? null : (
            <p>
              {meta(
                `${formatNumber(rows.length)} ${rows.length === 1 ? "connection" : "connections"}`,
                usable === null
                  ? null
                  : `${formatNumber(usable)} accepting Google calls`,
                needsReauth && needsReauth > 0
                  ? `${formatNumber(needsReauth)} needing re-consent`
                  : null
              )}
            </p>
          )}
          <p>
            “Needs re-consent” is expected behaviour, not an incident: a Google OAuth app left in
            Testing publish status issues refresh tokens that expire after about 7 days
, and rotating <InlineCode>TOKEN_ENCRYPTION_KEY</InlineCode>
            {" "}invalidates every stored grant at once. Re-consenting updates the same row — its id
            survives, so the spreadsheets registered through it stay registered.
          </p>
          <p>
            <span className="folio-strong">Removing a connection is destructive.</span>{" "}
            <InlineCode>registered_spreadsheets.connection_id</InlineCode> cascades, so the sheets
            registered through it are deleted, and <InlineCode>api_configurations</InlineCode>{" "}
            cascades from those. The confirmation asks you to type the Google address for that
            reason. Your Google Sheet itself is never touched — this deletes only the stored grant
            and the rows that depended on it.
          </p>
          <p>
            Connecting is a different step from signing in. <InlineCode>/auth/google</InlineCode> is
            the login-time consent — a Google identity with no account yet continues through the
            invitation step, and the first stored grant comes from that redemption
. The link in the header above
            instead flags its OAuth state as <InlineCode>link</InlineCode>, so{" "}
            <InlineCode>/auth/google/connect</InlineCode> attaches a new grant to the account you are
            already signed in to.
          </p>
        </PanelBody>
      </Panel>

      {/* ------------------------------------------------------------ this session */}
      <Panel as="section">
        <PanelHeader
          title="This session"
          description="How long you stay signed in and the one control you have over it."
        />
        <div>
          <Row>
            <RowTitle
              title="Session cookie"
              meta="HttpOnly, SameSite=Lax, Path=/, and Secure when NODE_ENV=production. The page cannot read its value, so none is shown."
            />
            <InlineCode>{SESSION_COOKIE}</InlineCode>
          </Row>
          <Row>
            <RowTitle
              title="Lifetime"
              meta="SESSION_MAX_AGE_SECONDS — a fixed server constant; there is no user setting for it, and the cookie's exp claim is verified on every request."
            />
            <span className="whitespace-nowrap text-[14px] text-paper">
              {formatNumber(SESSION_DAYS)} days
              <span className="ml-2 font-mono text-[12px] text-dust">
                {formatNumber(SESSION_MAX_AGE_SECONDS)} s
              </span>
            </span>
          </Row>
          <Row>
            <RowTitle
              title="Name prefix"
              meta="The __Host- prefix is production-only: it requires HTTPS and pins the cookie to one exact host, so development falls back to sz_session."
            />
            <span className="text-right text-[14px] text-mist">
              {SESSION_COOKIE.startsWith("__Host-") ? "Host-pinned (production)" : "Site-scoped (development)"}
            </span>
          </Row>
          <Row>
            <RowTitle
              title="Effective immediately on revocation"
              meta="Every request re-reads your users row and requires status='active', so an owner disabling the account ends it before the cookie expires."
            />
            <span className="text-right text-[14px] text-mist">Guard re-reads per request</span>
          </Row>
          <Row>
            <RowTitle
              title="Sign out"
              meta="A form POST to /auth/logout, never a GET link: a crawlable href would be able to end a session."
            />
            {/* No client component: a plain HTML form POST works exactly as the contract requires. */}
            <form action="/auth/logout" method="post">
              <Button type="submit" variant="danger" size="sm">
                Sign out
              </Button>
            </form>
          </Row>
        </div>
      </Panel>

      {/* ------------------------------------------------------------ not available (reference) */}
      {/* ------------------------------------------------------------ elsewhere */}
      <section aria-label="Related screens" className="flex flex-col gap-3">
        <p className="folio">Managed elsewhere</p>
        <div className="flex flex-wrap gap-2">
          <PillLink href="/spreadsheets" variant="line" size="sm">
            Registered spreadsheets
          </PillLink>
          <PillLink href="/apis" variant="line" size="sm">
            Endpoints
          </PillLink>
          <PillLink href="/keys" variant="line" size="sm">
            API keys
          </PillLink>
          <PillLink href="/logs" variant="line" size="sm">
            Request log
          </PillLink>
          <PillLink href="/analytics" variant="line" size="sm">
            Analytics
          </PillLink>
          {user.role === "owner" ? (
            <PillLink href="/admin" variant="line" size="sm">
              Admin — users and invitations
            </PillLink>
          ) : null}
        </div>
      </section>
    </div>
  )
}
