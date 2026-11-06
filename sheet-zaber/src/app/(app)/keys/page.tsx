import type { Metadata } from "next"

import { PillLink } from "@/components/ui/button"
import { Panel, PanelBody, PanelHeader, PageHeader } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/state"
import { isActionError } from "@/lib/action-result"
import { formatDateTime, formatDay, formatNumber, meta, shortId } from "@/lib/format"
import { requireUser } from "@/server/auth/guards"
import { listApis } from "@/server/apis/service"
import { listSpreadsheets } from "@/server/db/queries/spreadsheets"
import { listKeys, type ApiKeyMeta } from "@/server/keys/service"
import { CreateKeyForm } from "./create-key-form"
import { KeysTable, type KeyRowView } from "./keys-table"

export const metadata: Metadata = {
  title: "API keys",
  description: "Create, restrict, regenerate and revoke the Bearer keys that call your endpoints.",
}

/*
 * The key inventory. Reads only what the services expose: `listKeys` (active rows, newest first —
 * `src/server/keys/service.ts:199` → `src/server/db/queries/api-keys.ts:107`) and `listApis` for
 * the endpoint picker and to resolve a key's `allowedApiIds` into names.
 *
 * `ApiKeyMeta` has no `keyHash` field at all (`src/server/db/queries/api-keys.ts:22` omits it), so
 * nothing on this page can render or import one, and `listKeys` cannot return a plaintext: the
 * full `sz_live_…` exists only in the reveal panels that `createKeyAction` /
 * `regenerateKeyAction` hand back (`./actions.ts`). Revoked rows are not listed — the repository
 * filters `revoked_at is null`, which is why "Revoke" is final from here.
 */

/** `backend-api-contract.md` §1.4 defaults; the numbers are documented, not measured. */
const DEFAULT_REQUESTS_PER_HOUR = 1000
const DEFAULT_REQUESTS_PER_DAY = 10000

function scopeLabels(key: ApiKeyMeta): Array<"read" | "write"> {
  // The row's jsonb is typed as the union by `ApiKeyRow` (`src/server/db/queries/api-keys.ts:16`);
  // anything unexpected is dropped instead of being rendered as a scope that does not exist.
  return key.scopes.filter((scope) => scope === "read" || scope === "write")
}

function endpointsFor(key: ApiKeyMeta, nameById: Map<string, string>) {
  if (key.allowedApiIds === null) {
    return {
      label: "All endpoints",
      detail: "Every endpoint this account owns, including ones created later.",
    }
  }
  if (key.allowedApiIds.length === 0) {
    return {
      label: "Nothing (0 endpoints)",
      detail: "This key is restricted to an empty list, so every call it makes gets 403 key_restricted.",
    }
  }
  const parts = key.allowedApiIds.map((id) => nameById.get(id) ?? `${shortId(id)} (removed)`)
  const resolved = key.allowedApiIds.filter((id) => nameById.has(id)).length
  const removed = key.allowedApiIds.length - resolved
  return {
    label: `${resolved} endpoint${resolved === 1 ? "" : "s"}${removed > 0 ? ` · ${removed} removed` : ""}`,
    detail: parts.join(" · "),
  }
}

function toRowView(key: ApiKeyMeta, nameById: Map<string, string>, now: Date): KeyRowView {
  const endpoints = endpointsFor(key, nameById)
  const expired = key.expiresAt !== null && key.expiresAt <= now

  return {
    id: key.id,
    name: key.name,
    keyPreview: key.keyPreview,
    scopes: scopeLabels(key),
    endpointsLabel: endpoints.label,
    endpointsDetail: endpoints.detail,
    createdLabel: formatDateTime(key.createdAt.toISOString()),
    lastUsedLabel: key.lastUsedAt === null ? "—" : formatDateTime(key.lastUsedAt.toISOString()),
    lastUsedTitle:
      key.lastUsedAt === null
        ? "Never used — this key has not authenticated a request yet."
        : `Last seen ${formatDateTime(key.lastUsedAt?.toISOString() ?? "")}. Recorded at most once a minute, so it can lag.`,
    expired,
    statusLabel: expired ? "Expired" : "Active",
    expiresLabel:
      key.expiresAt === null
        ? null
        : `${expired ? "Expired" : "Expires"} ${formatDay(key.expiresAt.toISOString())}`,
  }
}

export default async function KeysPage() {
  const user = await requireUser()
  const sheetTitles = new Map((await listSpreadsheets(user.id)).map((sheet) => [sheet.id, sheet.title || "Untitled spreadsheet"]))
  const now = new Date()

  const [keysResult, apisResult] = await Promise.all([listKeys(user.id), listApis(user.id)])

  const keys = isActionError(keysResult) ? null : keysResult.data
  const apis = isActionError(apisResult) ? null : apisResult.data
  const nameById = new Map((apis ?? []).map((api) => [api.id, api.name]))

  const readErrors: Array<{ label: string; body: string; code: string }> = []
  if (isActionError(keysResult)) {
    readErrors.push({ label: "API keys", body: keysResult.error.message, code: keysResult.error.code })
  }
  if (isActionError(apisResult)) {
    readErrors.push({
      label: "Endpoints",
      body: apisResult.error.message,
      code: apisResult.error.code,
    })
  }

  const overridden = apis?.filter((api) => api.rateLimitPerHour !== null).length ?? null
  const lapsed = keys?.filter((key) => key.expiresAt !== null && key.expiresAt <= now).length ?? null

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        folio="04 — Keys"
        title="API keys" titleAside="issued"
        description="Each key is a Bearer credential for your own endpoints. Create one, paste it into your client, and revoke or regenerate it whenever you need to."
        action={
          <PillLink href="/logs" variant="line" size="sm">
            Request log
          </PillLink>
        }
      />

      {readErrors.map((failure) => (
        <ErrorState
          key={failure.label}
          title={`${failure.label} could not be read`}
          body={failure.body}
          code={failure.code}
        />
      ))}

      <Panel as="section">
        <PanelHeader
          title="Limits that apply to every key"
          description="Documented platform numbers, not measurements of your traffic."
        />
        <PanelBody className="flex flex-col gap-3 text-[13px] leading-[1.7] text-mist">
          <p>
            <span className="text-paper">{formatNumber(DEFAULT_REQUESTS_PER_HOUR)} requests/hour</span>{" "}
            and{" "}
            <span className="text-paper">{formatNumber(DEFAULT_REQUESTS_PER_DAY)} requests/day</span>{" "}
            per key, in fixed windows. A request past either limit is refused with{" "}
            <span className="font-mono text-paper">429</span> and a{" "}
            <span className="font-mono text-paper">Retry-After</span> count of seconds.
          </p>
          <p>
            An endpoint may lower the hourly limit for itself.{" "}
            {overridden === null
              ? "Your endpoints could not be read, so this count is unknown."
              : overridden === 0
                ? "None of your endpoints does today, so every key runs at the platform hourly limit."
                : `${formatNumber(overridden)} of ${formatNumber(apis?.length ?? 0)} endpoints ${
                    overridden === 1 ? "sets its own override" : "set their own overrides"
                  } — the endpoint rows on Analytics list them.`}
          </p>
          <p className="text-dust">
            Keys are stored as a SHA-256 hash and shown in full exactly once.
            What survives on this page is the preview, e.g.{" "}
            <span className="font-mono">sz_live_ab12…c3d4</span>.
          </p>
        </PanelBody>
      </Panel>

      {apis === null ? (
        <Panel as="section">
          <PanelHeader
            title="Create a key"
            description="The endpoint picker needs your endpoint list, which failed to read above, so the restriction control is not offered."
          />
          <PanelBody>
            <p className="text-[13px] leading-[1.6] text-dust">
              Fix the read (retry the page) and the form returns with its endpoint picker. Nothing
              was created while it was unavailable.
            </p>
          </PanelBody>
        </Panel>
      ) : (
        <CreateKeyForm
          endpoints={apis.map((api) => ({
            id: api.id,
            name: api.name,
            sheetTitle: sheetTitles.get(api.spreadsheetId) ?? "Removed spreadsheet",
            tabTitle: api.tabTitle,
            enabled: api.enabled,
          }))}
        />
      )}

      {keys === null ? null : keys.length === 0 ? (
        <EmptyState
          title="No keys yet"
          body="Nothing can call your endpoints until you create a key. Use the form above — the full value is shown once, then only the preview remains."
        />
      ) : (
        <KeysTable rows={keys.map((key) => toRowView(key, nameById, now))} />
      )}

      {lapsed !== null && lapsed > 0 ? (
        <p className="text-[13px] leading-[1.7] text-dust">
          {formatNumber(lapsed)} {lapsed === 1 ? "key has" : "keys have"} passed its expiry. Lapsed
          keys are listed above labelled <span className="folio-strong">Expired</span> instead of
          hidden, and they no longer authenticate a request — regenerate one to replace it.
        </p>
      ) : null}

      <p className="text-[13px] leading-[1.7] text-dust">
        {meta(
          "Revoked keys never come back: use Regenerate for a rolling credential.",
          "A key's last-used stamp is written at most once a minute, so a busy key can read slightly behind.",
          "Scopes decide verbs; endpoint restrictions decide which endpoints; the endpoint's own permissions and allowed verbs decide the rest."
        )}
      </p>
    </div>
  )
}
