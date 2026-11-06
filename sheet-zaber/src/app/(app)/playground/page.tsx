import type { Metadata } from "next"

import { Panel, PanelBody, PanelHeader, PageHeader } from "@/components/ui/panel"
import { ErrorState } from "@/components/ui/state"
import { isActionError } from "@/lib/action-result"
import { requireUser } from "@/server/auth/guards"
import { listApis } from "@/server/apis/service"
import { listKeyItems } from "@/server/keys/service"
import { PlaygroundClient } from "./playground-client"
import { ReloadButton } from "./reload-button"

export const metadata: Metadata = {
  title: "Playground",
  description: "Send a real request to your own endpoints through the same engine a client calls.",
}

/*
 * The in-dashboard API client. A Server Component that reads the two lists the builder needs and
 * hands a client component the narrowest props that can build a documented call.
 *
 * The reads are the same service calls the rest of the dashboard uses — `listKeyItems`
 * (`src/server/keys/service.ts:215`, the §4.6 projection with `userId` removed and no hash field on
 * it) and `listApis` (`src/server/apis/service.ts:313`) — so this page duplicates no query and does
 * not go through `/api/internal/keys` for data it can read directly. The app shell
 * (`src/app/(app)/layout.tsx:20`) fetches only the Google connection list, so there was nothing to
 * reuse from it.
 *
 * What leaves the server on purpose: for keys, only `id`, `name` and `keyPreview`, and only for rows
 * that can still authenticate — a revoked row is already absent from the read (`revoked_at is null`,
 * `src/server/db/queries/api-keys.ts:107`) and a lapsed one is filtered here, because the engine
 * answers a lapsed key with the same blind 401 as a foreign one (§4.8) and offering it would be a
 * trap. `keyPreview` is §4.8's one permitted key string; the scopes, timestamps and endpoint
 * restrictions a key row also carries are not needed to label an option, so they stay on the server.
 * The send itself is the client's POST to `/api/internal/playground`: §2 makes that route the
 * playground's transport, and a server action here would add a second, weaker path to the same call.
 */

export default async function PlaygroundPage() {
  const user = await requireUser()
  // `new Date()` rather than `Date.now()`: the repo's keys page compares the same expiry against a
  // render-time clock constructed this way (`src/app/(app)/keys/page.tsx`), which keeps the purity
  // check in `eslint-config-next` satisfied without changing the semantics.
  const now = new Date()

  const [keysResult, apisResult] = await Promise.all([listKeyItems(user.id), listApis(user.id)])

  // The pattern the keys page uses (`src/app/(app)/keys/page.tsx:95`): a failed read becomes `null`,
  // which is a different fact from an empty list and must never render as one.
  const allKeys = isActionError(keysResult) ? null : keysResult.data
  const apis = isActionError(apisResult) ? null : apisResult.data

  const readErrors = [
    isActionError(keysResult)
      ? { label: "API keys", code: keysResult.error.code, body: keysResult.error.message }
      : null,
    isActionError(apisResult)
      ? { label: "Endpoints", code: apisResult.error.code, body: apisResult.error.message }
      : null,
  ].filter((entry): entry is { label: string; code: string; body: string } => entry !== null)

  // A list that failed to read is not an empty list: the builder would claim "no keys yet" and point
  // the user at a form for something they already own. The page reports the read and stops.
  if (allKeys === null || apis === null) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          folio="05 — Playground"
          title="Playground" titleAside="live"
          description="Build a documented /api/v1 call, send it through the engine your clients reach, and read the answer exactly as they would."
        />
        {readErrors.map((failure) => (
          <ErrorState
            key={failure.label}
            title={`${failure.label} could not be read`}
            body={`${failure.body} The request builder needs this list to offer a choice, so it is not shown rather than shown empty. Nothing was sent and nothing was logged.`}
            code={failure.code}
            action={<ReloadButton />}
          />
        ))}
      </div>
    )
  }

  const usableKeys = allKeys.filter(
    (key) => key.expiresAt === null || key.expiresAt.getTime() > now.getTime(),
  )

  // Same pattern as the endpoint detail page (`src/app/(app)/apis/[apiId]/page.tsx:52`): a public
  // value, read on the server, passed down as a finished string. No env import reaches the client.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="05 — Playground"
        title="Playground" titleAside="live"
        description="Build a documented /api/v1 call, send it through the engine your clients reach, and read the answer exactly as they would — status included."
      />

      <Panel as="section">
        <PanelHeader
          title="Two rules this page is built around"
          description="The result panel shows both for every request."
        />
        <PanelBody className="flex flex-col gap-3 text-[13px] leading-[1.7] text-mist">
          <p>
            <span className="text-paper">The engine&apos;s status is the answer.</span> A 404, 409,
            422 or 429 from <span className="font-mono">/api/v1</span> comes back as a successful
            playground result carrying that number, and it is displayed as a completed request. A
            playground failure is something else entirely: an error envelope from this route, listed
            in its own panel when it happens.
          </p>
          <p>
            <span className="text-paper">Your key never enters this page.</span> A playground request
            carries <span className="font-mono">apiKeyId</span> — a row id — and the engine resolves
            the row against your session server-side. The only key text anywhere here is the preview
            in the picker, and the snippets write a placeholder where a real client would paste the
            secret.
          </p>
        </PanelBody>
      </Panel>

      <PlaygroundClient
        keys={usableKeys.map((key) => ({
          id: key.id,
          name: key.name,
          keyPreview: key.keyPreview,
        }))}
        apis={apis.map((api) => ({
          id: api.id,
          name: api.name,
          tabTitle: api.tabTitle,
          enabled: api.enabled,
          permissions: api.permissions,
          allowedOperations: api.allowedOperations,
          primaryKeyColumn: api.primaryKeyColumn,
        }))}
        baseUrl={`${siteUrl}/api/v1`}
        lapsedKeyCount={allKeys.length - usableKeys.length}
      />
    </div>
  )
}
