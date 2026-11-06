import type { Metadata } from "next"
import Link from "next/link"

import { BulletList, Em, Para } from "@/components/marketing/legal-doc"
import { DOCS_NAV } from "@/components/docs/docs-nav-data"
import { Callout, DocsPage, DocsSection, FactList } from "@/components/docs/docs-page"
import { PillLink } from "@/components/ui/button"
import { CodeBlock } from "@/components/ui/code"

/*
 * /docs — the overview page, and the source list for every other page in the group.
 *
 * Content policy: every claim on this page is a line of docs/backend-api-contract.md §1 (the
 * public API), §3 (what /docs owes), §4.4 (the status mapping) or §4.10 (what is deferred), and
 * the citations are printed so a reader can check them. A claim that no document makes — a
 * latency figure, an uptime promise, a customer count, a "recommended" limit — is absent.
 */

export const metadata: Metadata = {
  title: "API documentation",
  description:
    "The Sheet Zaber public API at https://sheet.zaber.tech/api/v1: Bearer-key authentication, the { data, meta } envelope, one documented error shape, eight operations, and the limits that come with them.",
}

const BASE_URL_PLATE = `https://sheet.zaber.tech/api/v1`

const AUTH_PLATE = `Authorization: Bearer sz_live_<32 hex>`

export default function DocsOverviewPage() {
  return (
    <DocsPage
      folio="Docs · 01 Overview"
      title="API documentation"
      lead={
        <>
          Sheet Zaber turns one tab of one Google spreadsheet into one HTTP endpoint that you read and
          write with a Bearer key, using the spreadsheet owner&#39;s own Google grant underneath. These
          pages document that public surface —{" "}
          <Em>
            <code className="inline">/api/v1</code>
          </Em>{" "}
          — using <code className="inline">docs/backend-api-contract.md</code> as the reference.
          Request snippets use the shared builders; response shapes illustrate the contract, not live data.
        </>
      }
      facts={[
        {
          label: "Base URL",
          value: <code className="inline">https://sheet.zaber.tech/api/v1</code>,
        },
        {
          label: "Authentication",
          value: <code className="inline">Authorization: Bearer sz_live_…</code>,
        },
        { label: "Success envelope", value: <code className="inline">{ "{ data, meta }" }</code> },
        { label: "Every refusal", value: <code className="inline">{ "{ error: { code, message, category } }" }</code> },
        { label: "Documented defaults", value: "1000 requests/hour and 10000/day per key" },
        { label: "Request body ceiling", value: "1 MB — larger is 413" },
        { label: "Page size ceiling", value: "limit ≤ 1000" },
        { label: "Access", value: "Private platform; an invitation code, then Google sign-in" },
      ]}
    >
      <DocsSection
        id="at-a-glance"
        index="1.1"
        heading="At a glance"
        source="docs/backend-api-contract.md §1, §1.1, §1.2"
      >
        <Para>
          Four facts carry the whole surface. Everything later in these pages is a consequence of them,
          which is why they come first and in their own plates.
        </Para>
        <div className="grid gap-4 lg:grid-cols-2">
          <CodeBlock label="Where the API lives" code={BASE_URL_PLATE} copyable={false} />
          <CodeBlock label="How you authorise" code={AUTH_PLATE} copyable={false} />
        </div>
        <BulletList
          items={[
            <>
              <Em>One API id is one tab.</Em> <code className="inline">{"{api}"}</code> in every path is{" "}
              <code className="inline">api_configurations.id</code> — a uuid, unguessable, assigned when
              the API is created. The header row you designate is the row the
              record keys come from, and data rows start immediately below it.
            </>,
            <>
              <Em>A key is a bearer token, not a login.</Em> It must be unrevoked, unexpired, owned by
              the same user as the API, scope-compatible with the verb, and — if it carries a restriction
              — allowed to reach that API. Missing or invalid is 401; a scope or restriction
              violation is 403.
            </>,
            <>
              <Em>Success is always { "{ data, meta }" }.</Em> <code className="inline">data</code> holds
              the array, the single record, or the write counter; <code className="inline">meta</code>{" "}
              carries <code className="inline">api_id</code>, <code className="inline">count</code>,{" "}
              <code className="inline">limit</code>, <code className="inline">offset</code> and{" "}
              <code className="inline">duration_ms</code>.
            </>,
            <>
              <Em>Refusal is always one shape.</Em> Every non-2xx response is{" "}
              <code className="inline">{ "{ error: { code, message, category } }" } </code>, so your
              error handling is a switch on <code className="inline">error.code</code>, not a parser of
              prose. The category set is <code className="inline">auth</code>,{" "}
              <code className="inline">rate_limit</code>, <code className="inline">validation</code>,{" "}
              <code className="inline">google</code>, <code className="inline">not_found</code> and{" "}
              <code className="inline">internal</code>.
            </>,
          ]}
        />
      </DocsSection>

      <DocsSection
        id="invitation-only"
        index="1.2"
        heading="What invitation-only means here"
        source="docs/plan.md D5, D11, D12 · docs/authentication-flow.md §1, §4"
      >
        <Para>
          There is no signup form. An account exists only once a Google identity has been verified and a
          code the operator issued has been redeemed, and the code is stored as a SHA-256 hash with a use
          limit, an optional expiry and revocation. The platform has
          one operator: the single account holding the <code className="inline">owner</code> role, granted
          only to the configured owner email at first sign-in.
        </Para>
        <Para>
          For an API consumer, that has three practical consequences, and none of them is a marketing
          sentence:
        </Para>
        <BulletList
          items={[
            <>
              <Em>Your endpoints are not public by default.</Em> Anyone who reaches{" "}
              <code className="inline">/api/v1/{"{api}"}</code> without a valid key gets a 401 — and an id
              belonging to another user gets the same 404 as an id that does not exist (§1.1,
              docs/security.md §3), so the uuid space cannot be enumerated for content.
            </>,
            <>
              <Em>Documentation is public, data is not.</Em> These pages are readable without a session;
              the API they describe is not, and the dashboard that issues keys sits behind the invitation
              step.
            </>,
            <>
              <Em>There is no self-service rate-limit negotiation.</Em> The limits in §1.4 are the
              documented platform defaults, surfaced per key in the dashboard; the only documented knob is
              a per-API hourly override, and owner-level settings have no storage yet.
            </>,
          ]}
        />
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <PillLink href="/login" variant="solid" size="md">
            Sign in
          </PillLink>
          <PillLink href="/keys" variant="line" size="md">
            Create an API key
          </PillLink>
          <PillLink href="/playground" variant="line" size="md">
            Open the playground
          </PillLink>
        </div>
      </DocsSection>

      <DocsSection
        id="sections"
        index="1.3"
        heading="Sections"
        source="the /docs routes that exist today"
      >
        <p className="max-w-[70ch] text-[15px] leading-[1.7] text-mist">
          Read in order for a first call, or jump to the one you need. Each page is a route of its own,
          and the rail on the left always shows which one you are on.
        </p>
        <ol className="grid gap-3 sm:grid-cols-2">
          {DOCS_NAV.slice(1).map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="group flex h-full flex-col gap-1.5 rounded-panel border border-rule bg-deep px-4 py-3.5 transition-colors duration-(--dur-fast) hover:border-edge"
              >
                <span className="folio num">{item.index}</span>
                <span className="text-[15px] font-semibold tracking-[-0.02em] text-paper">
                  {item.label}
                </span>
                <span className="text-[13px] leading-[1.6] text-dust">{item.blurb}</span>
              </Link>
            </li>
          ))}
        </ol>
      </DocsSection>

      <DocsSection
        id="how-to-read"
        index="1.4"
        heading="How to read the examples"
        source="docs/backend-api-contract.md §3 · src/lib/snippets.ts"
      >
        <Para>
          §3 of the contract requires /docs to render examples <Em>generated from the spec&#39;s tested
          behaviour</Em> using the shared snippet builders. That is what every cURL/JavaScript/Python
          plate in these pages is: a real <code className="inline">SnippetRequest</code> passed to{" "}
          <code className="inline">SnippetTabs</code>, built by{" "}
          <code className="inline">src/lib/snippets.ts</code> — the same pure functions the playground
          uses. The builders validate request structure, not sheet headers, credentials or live engine
          behaviour; sharing them does not replace contract verification.
        </Para>
        <BulletList
          items={[
            <>
              <Em>Placeholders are literal.</Em> <code className="inline">{"<api-id>"}</code>,{" "}
              <code className="inline">{"<record>"}</code> and <code className="inline">sz_live_…</code>{" "}
              stand for your values. Nothing on these pages is a live credential or a captured response.
            </>,
            <>
              Response plates use angle brackets for values too ({" "}
              <code className="inline">&quot;count&quot;: &lt;rows returned&gt;</code>) where the contract gives a
              field but no number.
            </>,
            <>
              Query strings are serialized exactly as{" "}
              <code className="inline">application/x-www-form-urlencoded</code> — a space becomes{" "}
              <code className="inline">+</code>, a repeated key repeats (
              <code className="inline">sort=-created_at&amp;sort=id</code>), and a comma in{" "}
              <code className="inline">fields</code> appears as <code className="inline">%2C</code>, which
              the server decodes back. That is the shipped builder&#39;s behaviour, not a typo.
            </>,
            <>
              A contract change obliges the same commit to update these pages and the engine tests.
              If you find a page and a real response disagree, the page is the bug — report it.
            </>,
          ]}
        />
      </DocsSection>

      <DocsSection
        id="status"
        index="1.5"
        heading="Status of this documentation"
        source="docs/backend-api-contract.md §4.10 · docs/integration-status.md (Measured vs asserted)"
      >
        <Para>
          Two kinds of honesty belong on a docs landing page: what the platform does not do yet, and how
          much of it has been executed rather than written down.
        </Para>
        <Callout label="Deferred or blocked in §4.10 — not advertised anywhere in these pages">
          <p>
            The Google Picker is deferred by the user (2026-11-05), so registering a spreadsheet is the
            documented paste URL/ID → <code className="inline">spreadsheets.get</code> → tab-snapshot flow
.{" "}
            <code className="inline">updatePlatformSettings({"{defaultRateLimits, logRetentionDays}"})</code>{" "}
            is blocked — no platform-settings table exists, so the numbers in §1.4 are the documented
            defaults rather than somebody&#39;s configuration. Whether request logs survive the deletion of
            the API they describe is an open decision; today they cascade with it, and nothing here
            promises otherwise. <code className="inline">GET /api/internal/connections/status</code> was
            dropped in v0.2 and is not mentioned.
          </p>
        </Callout>
        <Callout label="Measured versus asserted" tone="outline">
          <p>
            <code className="inline">docs/integration-status.md</code> keeps a board of what has been run
            against a real PostgreSQL and what is only written down. Its public{" "}
            <code className="inline">/api/v1</code> engine row is recorded as <Em>asserted</Em> — “contract
            frozen in §1; implementation and tests in flight” as of that row&#39;s date — and so is{" "}
            <code className="inline">POST /api/internal/playground</code>. Treat these pages as the frozen
            contract, and treat a difference between a page and a live response as a defect in one of the
            two.
          </p>
        </Callout>
        <Para>
          The surfaces documented here are also the surfaces the playground exercises:{" "}
          <code className="inline">/api/internal/playground</code> calls the same engine in process, keyed
          by the key&#39;s row id rather than a plaintext, so a rule the playground can bend is a rule a real
          client can break too.
        </Para>
      </DocsSection>

      <DocsSection
        id="elsewhere"
        index="1.6"
        heading="Elsewhere on this site"
        source="the public pages and the dashboard they lead to"
      >
        <FactList
          facts={[
            {
              label: "Landing",
              value: <Link href="/" className="text-mist underline decoration-edge underline-offset-4 hover:text-paper">/</Link>,
            },
            {
              label: "Sign in",
              value: <Link href="/login" className="text-mist underline decoration-edge underline-offset-4 hover:text-paper">/login</Link>,
            },
            {
              label: "API keys",
              value: <Link href="/keys" className="text-mist underline decoration-edge underline-offset-4 hover:text-paper">/keys</Link>,
            },
            {
              label: "Playground",
              value: <Link href="/playground" className="text-mist underline decoration-edge underline-offset-4 hover:text-paper">/playground</Link>,
            },
            {
              label: "Legal",
              value: (
                <>
                  <Link href="/privacy" className="text-mist underline decoration-edge underline-offset-4 hover:text-paper">/privacy</Link>{" "}
                  and{" "}
                  <Link href="/terms" className="text-mist underline decoration-edge underline-offset-4 hover:text-paper">/terms</Link>
                </>
              ),
            },
          ]}
        />
      </DocsSection>
    </DocsPage>
  )
}
