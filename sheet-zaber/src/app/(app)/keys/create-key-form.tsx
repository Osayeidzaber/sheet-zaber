"use client"

/*
 * Create-key form. One submit = one `createKey` service call
 * (`src/server/keys/service.ts:132`), validated there by `createKeySchema`
 * (`src/lib/schemas.ts:88`), and the resulting `CreatedApiKey.plaintext` goes straight into the
 * one-time reveal below the form. The field state here is only what the controls display; no key
 * material is ever held outside the action's return value.
 */

import { useActionState, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckRow, TextField, Toggle } from "@/components/ui/field"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import type { CreateKeyState, KeyActionFields } from "./actions"
import { createKeyFormAction } from "./actions"
import { KeyReveal } from "./key-reveal"

/** A `{ status: "idle" }` start value kept LOCAL to this client file: a `"use server"` module may
 *  export functions only, so the initial state cannot come from `./actions`. */
const INITIAL_STATE: CreateKeyState = { status: "idle" }

const INITIAL_FIELDS: KeyActionFields = {}

export type EndpointOption = {
  id: string
  name: string
  tabTitle: string
  enabled: boolean
}

function fieldError(fields: KeyActionFields | undefined, key: keyof KeyActionFields): string | undefined {
  return fields?.[key]
}

export function CreateKeyForm({ endpoints }: { endpoints: EndpointOption[] }) {
  const [generation, setGeneration] = useState(0)
  return (
    <CreateKeySession
      key={generation}
      endpoints={endpoints}
      dismissed={generation > 0}
      onDismiss={() => setGeneration((value) => value + 1)}
    />
  )
}

function CreateKeySession({
  endpoints,
  dismissed,
  onDismiss,
}: {
  endpoints: EndpointOption[]
  dismissed: boolean
  onDismiss: () => void
}) {
  // Never send a previous action result containing plaintext back on another POST.
  const [state, formAction, isPending] = useActionState(
    (_previous: CreateKeyState, formData: FormData) => createKeyFormAction(INITIAL_STATE, formData),
    INITIAL_STATE
  )
  const [read, setRead] = useState(true)
  const [write, setWrite] = useState(false)
  const [restricted, setRestricted] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  const error = state.status === "error" ? state : null
  const fields = error?.fields ?? INITIAL_FIELDS

  const selectedCount = selected.filter((id) => endpoints.some((api) => api.id === id)).length

  return (
    <Panel as="section">
      <PanelHeader
        title="Create a key"
        description="A key carries scopes and, optionally, a list of endpoints it may call. It is hashed with SHA-256 at rest and shown in full once."
      />
      <PanelBody className="flex flex-col gap-5">
        <form action={formAction} className="flex flex-col gap-5">
          <TextField
            label="Key name"
            name="name"
            required
            maxLength={80}
            spellCheck={false}
            autoComplete="off"
            placeholder="production web app"
            hint="Up to 80 characters. The name is what you will recognise in the list and in support tickets."
            error={fieldError(fields, "name")}
            disabled={isPending}
          />

          <fieldset className="flex min-w-0 flex-col gap-2" disabled={isPending}>
            <legend className="text-[14px] text-mist">
              Scopes<span className="text-paper"> *</span>
            </legend>
            <CheckRow
              label="read"
              description="GET, search and range calls only."
              checked={read}
              onChange={setRead}
            />
            <CheckRow
              label="write"
              description="POST, PATCH, PUT and DELETE, on endpoints that allow those verbs."
              checked={write}
              onChange={setWrite}
            />
            {/* With both scopes off, the adapter forwards [] and the backend schema refuses it.
                It never omits the scopes field, which would apply the default read scope. */}
            {!read && !write ? (
              <p className="text-[13px] text-paper">⚠ Pick at least one scope.</p>
            ) : null}
            {read ? <input type="hidden" name="scopes" value="read" readOnly /> : null}
            {write ? <input type="hidden" name="scopes" value="write" readOnly /> : null}
          </fieldset>

          <div className="flex flex-col gap-3 border-t border-rule pt-5">
            <Toggle
              label="Restrict this key to selected endpoints"
              checked={restricted}
              onChange={setRestricted}
              disabled={isPending}
              hint="Off: the key may call every endpoint you own. On: it may call only the ones checked below — anything else gets 403 key_restricted."
            />

            <input type="hidden" name="restricted" value={restricted ? "yes" : "no"} readOnly />

            {restricted ? (
              endpoints.length === 0 ? (
                <p className="text-[13px] leading-[1.6] text-dust">
                  You have no endpoints yet, so there is nothing to restrict a key to. Create an
                  endpoint first, or leave this restriction off.
                </p>
              ) : (
                <fieldset className="flex flex-col gap-1" disabled={isPending}>
                  <legend className="sr-only">Allowed endpoints</legend>
                  {endpoints.map((api) => (
                    <CheckRow
                      key={api.id}
                      label={api.name}
                      description={api.enabled ? api.tabTitle : `${api.tabTitle} · endpoint disabled`}
                      checked={selected.includes(api.id)}
                      onChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, api.id]
                            : current.filter((id) => id !== api.id)
                        )
                      }
                    />
                  ))}
                  {/* Only the ids still checked are submitted, so an unticked row cannot appear in
                      `allowedApiIds` as an empty string. */}
                  {selected
                    .filter((id) => endpoints.some((api) => api.id === id))
                    .map((id) => (
                      <input key={id} type="hidden" name="allowedApiIds" value={id} readOnly />
                    ))}
                  <p className="pt-1 font-mono text-[12px] text-dust">
                    {selectedCount} of {endpoints.length} selected · up to 200 endpoints per key
                  </p>
                </fieldset>
              )
            ) : null}
            {fieldError(fields, "allowedApiIds") ? (
              <p role="alert" className="text-[13px] text-paper">
                ⚠ {fieldError(fields, "allowedApiIds")}
              </p>
            ) : null}
            {fieldError(fields, "scopes") ? (
              <p role="alert" className="text-[13px] text-paper">
                ⚠ {fieldError(fields, "scopes")}
              </p>
            ) : null}
          </div>

          <div className="border-t border-rule pt-5">
            <TextField
              label="Expiry date (optional)"
              name="expiresAt"
              type="date"
              hint="Leave empty for a key that never expires. A dated key stops authenticating the moment it lapses; the list labels it instead of hiding it."
              error={fieldError(fields, "expiresAt")}
              disabled={isPending}
            />
          </div>

          {error ? (
            <p role="alert" className="text-[13px] leading-[1.6] text-paper">
              ⚠ {error.message}
              <span className="ml-2 font-mono text-[11px] tracking-[0.08em] text-dust uppercase">
                {error.code}
              </span>
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="solid" loading={isPending}>
              {isPending ? "Creating key…" : "Create key"}
            </Button>
            <span aria-live="polite" className="folio">
              {state.status === "created" ? "saved · listed below" : ""}
            </span>
          </div>
        </form>

        {state.status === "created" ? (
          <div className="border-t border-rule pt-5">
            <KeyReveal
              name={state.key.name}
              keyPreview={state.key.keyPreview}
              plaintext={state.key.plaintext}
              detail={
                state.key.allowedApiIds === null
                  ? "all endpoints"
                  : `${state.key.allowedApiIds.length} endpoint${
                      state.key.allowedApiIds.length === 1 ? "" : "s"
                    }`
              }
              onDismiss={onDismiss}
            />
          </div>
        ) : null}
        {dismissed && state.status === "idle" ? (
          <div role="status" className="flex flex-wrap items-center gap-3 border-t border-rule pt-5">
            <Badge variant="outline">Hidden</Badge>
            <p className="text-[13px] text-dust">
              The full key is gone from this screen and cannot be shown again. Regenerate the
              row in the list if you did not copy it.
            </p>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  )
}
