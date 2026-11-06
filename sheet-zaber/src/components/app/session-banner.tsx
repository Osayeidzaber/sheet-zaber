import { PillLink } from "@/components/ui/button"
import { Banner } from "@/components/ui/state"
import type { Connection } from "@/server/google/connections"

/*
 * The reauth banner (`docs/integration-status.md` Q-B3): driven solely by the real
 * `google_connections.status` column. It renders only when at least one connection is
 * `reauth_required`, and its link points at the re-consent entry point the backend
 * actually ships — `GET /auth/google/connect` (src/app/auth/google/connect/route.ts),
 * whose state is flagged `link`, so the callback re-attaches the grant to the session
 * user. Default return target is `/overview` (route.ts:31).
 */

export function SessionBanner({ connections }: { connections: Connection[] }) {
  const stale = connections.filter((connection) => connection.status === "reauth_required")
  if (stale.length === 0) return null

  const emails = stale.map((connection) => connection.googleEmail).join(", ")

  return (
    <Banner
      tone="attention"
      title={`${stale.length} Google ${stale.length === 1 ? "connection needs" : "connections need"} reconnecting`}
      body={`Google no longer accepts the saved grant for ${emails}. Sheet Zaber cannot read or write those spreadsheets until you re-consent.`}
      action={
        <PillLink href="/auth/google/connect" prefetch={false} variant="solid" size="sm">
          Reconnect Google
        </PillLink>
      }
    />
  )
}
