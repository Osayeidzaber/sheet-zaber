import type { Metadata } from "next"

import { BulletList, Em, Para } from "@/components/marketing/legal-doc"
import { Callout, DocsPage, DocsSection, ParamTable, ShapeBlock, SubHeading } from "@/components/docs/docs-page"
import { PillLink } from "@/components/ui/button"
import { CodeBlock } from "@/components/ui/code"
import { SnippetTabs } from "@/components/ui/snippet-tabs"
import type { SnippetRequest } from "@/lib/snippets"

/*
 * /docs/authentication — docs/backend-api-contract.md §1.1, with the key payload facts from §4.6,
 * the hashing facts from docs/security.md §2 and the "shown once" property from §4.6/§4.8.
 */

export const metadata: Metadata = {
  title: "Authentication",
  description:
    "How a /api/v1 request authorises: the Bearer header, key scopes and per-API restrictions, expiry and revocation, and why the plaintext key is shown exactly once.",
}

const HEADER_PLATE = `Authorization: Bearer sz_live_<32 hex>`

const KEY_ANATOMY = `sz_live_  +  32 hex characters
         ^              ^
         prefix         crypto.randomBytes(16).toString("hex") — 128 bits, docs/plan.md D10`

const REQUEST: SnippetRequest = {
  baseUrl: "https://sheet.zaber.tech/api/v1",
  method: "GET",
  apiId: "<api-id>",
  query: { limit: "1" },
  apiKey: "sz_live_…",
}

const UNAUTHORISED_PLATE = `{
  "error": {
    "code": "missing_key",
    "message": "<what failed>",
    "category": "auth"
  }
}`

export default function DocsAuthenticationPage() {
  return (
    <DocsPage
      folio="Docs · 03 Authentication"
      title="Authentication"
      lead={
        <>
          <code className="inline">/api/v1</code> has one credential: an API key in the{" "}
          <code className="inline">Authorization</code> header. There is no session, no OAuth token and
          no signed request. §1.1 of the contract defines the header, the five properties a key must have
          and the two statuses that refuse it.
        </>
      }
      facts={[
        { label: "Header", value: <code className="inline">Authorization: Bearer …</code> },
        { label: "Key format", value: "sz_live_ + 32 hex" },
        { label: "Missing or invalid", value: "401" },
        { label: "Scope or restriction violated", value: "403" },
        { label: "Query-parameter auth", value: "not supported" },
        { label: "Where keys are issued", value: "/keys, after sign-in" },
      ]}
    >
      <DocsSection
        id="the-header"
        index="3.1"
        heading="The header"
        source="docs/backend-api-contract.md §1.1"
      >
        <CodeBlock label="Exactly as §1.1 prints it" code={HEADER_PLATE} copyable={false} />
        <Para>
          A key is <Em>Bearer</Em>-style: whoever presents it is treated as its owner, so it belongs in a
          header on a TLS connection and nowhere else. The shape is a fixed prefix plus 32 hex characters{" "}
:
        </Para>
        <ShapeBlock label="Anatomy" shape={KEY_ANATOMY} />
        <Callout label="Query-string authentication is refused, and the reason is printed">
          <p>
            §1.1 states it in one line: <code className="inline">?key=</code> is not supported, because a
            key in a URL leaks into logs and referrers. The same reasoning is why request-log rows carry a
            path with no data-carrying query string and why nothing on this site
            asks you to paste a key into a browser field.
          </p>
        </Callout>
      </DocsSection>

      <DocsSection
        id="five-conditions"
        index="3.2"
        heading="The five conditions a key must meet"
        source="docs/backend-api-contract.md §1.1 · refusal statuses from §1.1 and §1.2"
      >
        <Para>
          Every request is checked against all five. A failure of the first three is an authentication
          problem (401); a failure of the last two is an authorisation problem (403).
        </Para>
        <ParamTable
          label="Key conditions"
          nameLabel="Condition"
          typeLabel="Status if it fails"
          meaningLabel="What it means, and the field behind it"
          rows={[
            {
              name: "unrevoked",
              type: "401",
              meaning: (
                <>
                  <code className="inline">api_keys.revoked_at</code> is null. A revoked key is answered
                  the same way as one that never existed, so a refusal is not a probe result
                  (docs/security.md §3 item 2).
                </>
              ),
            },
            {
              name: "unexpired",
              type: "401",
              meaning: (
                <>
                  <code className="inline">api_keys.expires_at</code> is null or in the future. Expiry is a
                  field you set when creating the key.
                </>
              ),
            },
            {
              name: "owned by the API's user",
              type: "401",
              meaning: (
                <>
                  The key&#39;s owner and the API&#39;s owner are the same account. The engine walks key →
                  key owner → API owner equality, and there is no path that accepts a caller-supplied
                  connection or token.
                </>
              ),
            },
            {
              name: "scope-compatible with the verb",
              type: "403",
              meaning: (
                <>
                  <code className="inline">read</code> covers GET;{" "}
                  <code className="inline">write</code> covers POST, PATCH, PUT and DELETE. A key&#39;s{" "}
                  <code className="inline">scopes</code> is either <code className="inline">[&quot;read&quot;]</code> or{" "}
                  <code className="inline">[&quot;read&quot;,&quot;write&quot;]</code>.
                </>
              ),
            },
            {
              name: "within its API restriction",
              type: "403",
              meaning: (
                <>
                  If <code className="inline">allowed_api_ids</code> is set, the requested API must be in that
                  list; null means every API the same user owns.
                </>
              ),
            },
          ]}
        />
        <BulletList
          items={[
            <>
              <Em>The API itself must be enabled.</Em> A toggled-off API answers 403{" "}
              <code className="inline">api_disabled</code> — the owner flips it back in the dashboard.
            </>,
            <>
              <Em>The verb must be allowed on the API.</Em> Each API carries an{" "}
              <code className="inline">allowed_operations</code> subset of the five verbs; anything
              outside it is 403 <code className="inline">operation_not_allowed</code>.
            </>,
            <>
              <Em>If the owner of the key is disabled, the key stops working.</Em> Disabling a user takes
              effect on the next request — logout for the session and 403 for the API (contract §2, admin
              row for <code className="inline">setUserStatus</code>).
            </>,
          ]}
        />
      </DocsSection>

      <DocsSection
        id="scopes-and-restrictions"
        index="3.3"
        heading="Scopes and per-key restrictions"
        source="docs/backend-api-contract.md §1.1 · §4.6 ApiKeyMeta"
      >
        <Para>
          Two independent controls narrow what a key can do, and both are set at creation:
        </Para>
        <BulletList
          items={[
            <>
              <Em>Scopes</Em> decide <em>which verbs</em> are reachable. A read-only integration gets{" "}
              <code className="inline">read</code>, and a POST/PATCH/PUT/DELETE call against it is a 403{" "}
              <code className="inline">key_scope_insufficient</code> rather than a silently ignored write.
            </>,
            <>
              <Em>
                <code className="inline">allowed_api_ids</code>
              </Em>{" "}
              decides <em>which endpoints</em> are reachable. Give a partner one API and list only that id;
              leave it null for a key that should reach everything the account owns. A call outside the list
              is 403 <code className="inline">key_restricted</code>.
            </>,
          ]}
        />
        <Para>
          Scope is necessary but not sufficient: a write-scoped key still needs the API to be{" "}
          <code className="inline">read_write</code>, the verb in its <code className="inline">allowed_operations</code>
          , and — for PATCH, PUT and DELETE — a configured primary-key column. Those
          refusals are documented per operation on the Operations page.
        </Para>
      </DocsSection>

      <DocsSection
        id="preview-versus-plaintext"
        index="3.4"
        heading="Key preview versus plaintext"
        source="docs/backend-api-contract.md §4.6, §4.8 · docs/security.md §2, §4"
      >
        <Para>
          This is a documented security property, so it is stated here rather than buried in the dashboard:{" "}
          <Em>a plaintext API key is shown exactly once, at creation.</Em>
        </Para>
        <BulletList
          items={[
            <>
              The database stores <code className="inline">key_hash</code> — the SHA-256 of the plaintext —
              and nothing else. Authentication hashes what you send and looks that hash up (§4.7{" "}
              <code className="inline">authenticateKey</code>), so the platform cannot read your key back
.
            </>,
            <>
              The only displayable form is <code className="inline">keyPreview</code>, documented as{" "}
              <code className="inline">&quot;sz_live_ab12…last4&quot;</code> — the first 10 plus the last 4 characters
. A key list never carries the hash or the plaintext: both are
              projected out before serialization.
            </>,
            <>
              The plaintext exists only in the return value of <code className="inline">createKey</code> and{" "}
              <code className="inline">regenerateKey</code> (<code className="inline">CreatedApiKey = ApiKeyMeta &amp; {"{ plaintext }"}</code>,
              §4.6). Losing it means issuing a new key — there is no recovery, and that is the design.
            </>,
            <>
              Regenerating is revoke-plus-create, never an in-place mutation of a hash, so the history of the
              old key survives and a fresh plaintext comes back once.
            </>,
            <>
              Even the dashboard&#39;s own playground sends a key <em>id</em>, never a key string: it calls the
              engine in process with <code className="inline">{"{ kind: \"keyId\" }"}</code>, so no plaintext
              enters the browser or a network log.
            </>,
          ]}
        />
        <Callout label="Last-used is approximate, on purpose">
          <p>
            <code className="inline">ApiKeyMeta.lastUsedAt</code> is written at most once a minute, so the
            dashboard can show a time that lags by up to a minute. Treat it as a hint about whether a
            key is still in use, not as an audit trail — the per-request log is the audit trail.
          </p>
        </Callout>
      </DocsSection>

      <DocsSection
        id="an-authenticated-call"
        index="3.5"
        heading="An authenticated call, and a refusal"
        source="docs/backend-api-contract.md §1.1, §1.2"
      >
        <SubHeading>The request</SubHeading>
        <p className="max-w-[70ch] text-[13px] leading-[1.6] text-dust">
          The builders add the <code className="inline">Authorization</code> header themselves from the{" "}
          <code className="inline">apiKey</code> field, so the header is not something an example can forget.
        </p>
        <SnippetTabs request={REQUEST} />

        <SubHeading>No header at all</SubHeading>
        <ShapeBlock
          label="401 · application/json"
          shape={UNAUTHORISED_PLATE}
          note="`code` names the reason — `missing_key` when the header is absent, `invalid_key` when it does not resolve."
        />

        <SubHeading>Where a key comes from</SubHeading>
        <Para>
          Keys are issued in the dashboard, where you also set the name, the scopes, the API restriction and
          the expiry. The creation form returns the plaintext once; the list after that shows previews only.
        </Para>
        <div className="flex flex-wrap items-center gap-3">
          <PillLink href="/keys" variant="solid" size="md">
            Create or revoke a key
          </PillLink>
          <PillLink href="/login" variant="line" size="md">
            Sign in first
          </PillLink>
        </div>
      </DocsSection>
    </DocsPage>
  )
}
