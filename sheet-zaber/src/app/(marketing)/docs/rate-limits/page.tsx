import type { Metadata } from "next"

import { BulletList, Em, Para } from "@/components/marketing/legal-doc"
import { Callout, DocsPage, DocsSection, ParamTable, ShapeBlock } from "@/components/docs/docs-page"
import { CodeBlock } from "@/components/ui/code"
import { PillLink } from "@/components/ui/button"
import { SnippetTabs } from "@/components/ui/snippet-tabs"
import type { SnippetRequest } from "@/lib/snippets"

/*
 * /docs/rate-limits — §1.4 reproduced exactly, then the machinery the other docs describe:
 * `rate_limit_buckets` and `rate_limit_per_hour` (docs/database-schema.md), the burst trade-off and
 * the upgrade path (docs/security.md §6), and the ceilings §1.2/§1.3 place next to the request-rate
 * limits. The defaults are called defaults, because §4.10 records that changing the platform default
 * has no storage yet.
 */

export const metadata: Metadata = {
  title: "Rate limits",
  description:
    "1000 requests an hour and 10000 a day per key in fixed windows, the per-API hourly override, Retry-After on every 429, and the other documented ceilings.",
}

const WINDOW_ROW = [
  {
    name: "1000 req / hour",
    type: "per key",
    meaning: (
      <>
        §1.4&#39;s default, and docs/database-schema.md puts <code className="inline">NULL</code> in{" "}
        <code className="inline">api_configurations.rate_limit_per_hour</code> squarely on it: “NULL =
        platform default (1000/h, 10000/day)”.
      </>
    ),
  },
  {
    name: "10000 req / day",
    type: "per key",
    meaning: (
      <>
        The other half of the same sentence in §1.4. Nothing in the docs gives a per-API day override,
        so the hourly column is the only documented knob.
      </>
    ),
  },
  {
    name: "Fixed windows",
    type: "how they are counted",
    meaning: (
      <>
        §1.4 names them and docs/database-schema.md shows why: the counter is a single-round-trip upsert
        keyed by <code className="inline">{"{scope}:{id}:{window}"}</code> with a{" "}
        <code className="inline">window_start</code> that resets once the interval has passed.
      </>
    ),
  },
  {
    name: "rate_limit_per_hour",
    type: "per API override",
    meaning: (
      <>
        A nullable integer on the API row, exposed as{" "}
        <code className="inline">ApiConfig.rateLimitPerHour</code> in the dashboard payload,
        not on key metadata. Null uses the platform default; §1.4 does not specify how this override
        composes with the per-key buckets.
      </>
    ),
  },
  {
    name: "429 + Retry-After",
    type: "the refusal",
    meaning: (
      <>
        §1.4 states the wait in seconds is carried by the <code className="inline">Retry-After</code>{" "}
        header, and §1.2 says the same from the error side. It is the only rate-limit response header
        the contract documents.
      </>
    ),
  },
]

const OTHER_CEILINGS = [
  {
    name: "1 MB",
    type: "request body",
    meaning: (
      <>
        §1.2 refuses anything larger with <code className="inline">413 body_too_large</code>, and
        docs/architecture.md&#39;s engine pipeline makes it step&nbsp;1: parse the body under a 1 MB
        ceiling before authentication even runs.
      </>
    ),
  },
  {
    name: "limit ≤ 1000",
    type: "page size",
    meaning: (
      <>
        §1.3 bounds the list <code className="inline">limit</code> parameter to 1–1000 rows with all
        rows as the documented default. A big page is a big response, not a way around the request
        counter.
      </>
    ),
  },
  {
    name: "≤ 500 objects",
    type: "create array",
    meaning: (
      <>
        §1.3 caps one POST at 500 records. Read the note on the Operations page first:
        docs/google-integration.md §4 documents v1 writes as one record per request, so the array form
        is the part of the contract the two documents disagree about.
      </>
    ),
  },
  {
    name: "5 per 15 min",
    type: "invitation attempts",
    meaning: (
      <>
        Not a <code className="inline">/api/v1</code> limit: contract §2 and §4.5 require a DB-backed
        fixed-window bucket inside the invitation service, per pending cookie <Em>and</Em> per IP,
        answered <code className="inline">429 rate_limited</code>. The contract explicitly supersedes
        the earlier in-memory description in the security and authentication documents.
      </>
    ),
  },
  {
    name: "Google's own quota",
    type: "upstream",
    meaning: (
      <>
        Google quota is separate from Sheet Zaber&#39;s request windows. §1.5 states the engine maps
        an upstream Google 429 to{" "}
        <code className="inline">503 google_quota_exceeded</code> with Google&#39;s{" "}
        <code className="inline">Retry-After</code> rather than inventing a number.
      </>
    ),
  },
]

const BUCKET_PLATE = `rate_limit_buckets
  bucket_key      text PK   "{scope}:{id}:{window}"   e.g.  key:<keyId>:h
  count           int  NOT NULL
  window_start    timestamptz NOT NULL`

const REFUSAL_REQUEST: SnippetRequest = {
  baseUrl: "https://sheet.zaber.tech/api/v1",
  method: "GET",
  apiId: "<api-id>",
  apiKey: "sz_live_…",
  query: { limit: "1000" },
}

export default function DocsRateLimitsPage() {
  return (
    <DocsPage
      folio="Docs · 07 Rate limits"
      title="Rate limits"
      lead={
        <>
          §1.4 of docs/backend-api-contract.md is the whole policy in two sentences:{" "}
          <Em>1000 requests an hour and 10000 requests a day, per key</Em>, counted in fixed windows in{" "}
          <code className="inline">rate_limit_buckets</code>, with a per-API hourly override and a{" "}
          <code className="inline">Retry-After</code> header on every refusal. Everything below is that
          sentence plus the machinery the other docs record around it — and a plain statement of which
          numbers are platform defaults rather than somebody&#39;s configuration.
        </>
      }
      facts={[
        { label: "Per key, per hour", value: "1000 requests" },
        { label: "Per key, per day", value: "10000 requests" },
        { label: "Counting", value: "Fixed windows in rate_limit_buckets" },
        { label: "Override", value: "api_configurations.rate_limit_per_hour" },
        { label: "On refusal", value: "429 rate_limited + Retry-After seconds" },
      ]}
    >
      <DocsSection
        id="the-policy"
        index="7.1"
        heading="The documented policy"
        source="docs/backend-api-contract.md §1.4, as written"
      >
        <CodeBlock
          label="§1.4"
          copyable={false}
          code={`Default per key: 1000 req/hour, 10000 req/day (fixed windows, rate_limit_buckets);
per-API override rate_limit_per_hour. 429 carries Retry-After seconds. Limits are
documented in /docs and surfaced in the dashboard key UI.`}
        />
        <ParamTable
          label="The five parts of the policy"
          nameLabel="Term"
          typeLabel="Applies to"
          meaningLabel="What the documents say"
          rows={WINDOW_ROW}
        />
        <Para>
          §1.4 requires these limits to be surfaced in the dashboard key UI. These are documented
          defaults, not measured usage or a reading of your account&#39;s current configuration.
        </Para>
        <div className="flex flex-wrap gap-2.5 pt-1">
          <PillLink href="/keys" variant="line">
            Your keys and their limits
          </PillLink>
          <PillLink href="/docs/errors" variant="line">
            What the 429 body looks like
          </PillLink>
        </div>
      </DocsSection>

      <DocsSection
        id="when-you-are-limited"
        index="7.2"
        heading="When you are limited"
        source="docs/backend-api-contract.md §1.2 · §1.4 · §4.4"
      >
        <Para>
          A refused request is not executed: <code className="inline">rate_limit</code> is checked in
          the pipeline before the spreadsheet is read, so a 429 costs you no rows and no Google call.
          The code is <code className="inline">rate_limited</code>, the category is{" "}
          <code className="inline">rate_limit</code>, and the wait is in the header.
        </Para>
        <SnippetTabs request={REFUSAL_REQUEST} />
        <ShapeBlock
          label="429 · §1.2 shape, §1.4 header"
          shape={`HTTP/1.1 429 Too Many Requests
Retry-After: <seconds>

{
  "error": {
    "code": "rate_limited",
    "message": "<text — not specified by the contract>",
    "category": "rate_limit"
  }
}`}
          note="Only the status, the code, the category and the presence of Retry-After are documented; the message text is a placeholder, so branch on the code."
        />
        <BulletList
          items={[
            <>
              <Em>Wait for the header, not for a guess.</Em> §1.4 puts the seconds in{" "}
              <code className="inline">Retry-After</code>. Internally, §4.4 has the same number as{" "}
              <code className="inline">fields.retry_after</code> so a route and a server action read one
              value; on <code className="inline">/api/v1</code> there is no documented{" "}
              <code className="inline">fields</code> member, so read the header.
            </>,
            <>
              <Em>There are no remaining-quota headers to read.</Em> The contract documents{" "}
              <code className="inline">Retry-After</code> and nothing else — no{" "}
              <code className="inline">X-RateLimit-*</code> set, no remaining/limit/reset triple. Build
              no backoff logic on numbers you cannot get.
            </>,
            <>
              <Em>Retrying inside the window repeats the refusal.</Em>{" "}
              <code className="inline">rate_limit</code> is one of the two documented retryable
              categories, and both of them mean “later”, not “again now”.
            </>,
          ]}
        />
      </DocsSection>

      <DocsSection
        id="how-counting-works"
        index="7.3"
        heading="How the counting works"
        source="docs/backend-api-contract.md §1.4 · docs/database-schema.md · docs/plan.md D13"
      >
        <Para>
          The counters are a Postgres table, not a cache. docs/database-schema.md lists{" "}
          <code className="inline">rate_limit_buckets</code> among the standalone counters: its primary
          key is a composed text string rather than a foreign key to a key or API row, so the bucket a
          request spends is named by that string alone.
        </Para>
        <ShapeBlock
          label="docs/database-schema.md"
          shape={BUCKET_PLATE}
          note="`h` is the hour window in the documented example key. Nothing in the docs names the day window's tag, so this page does not either."
        />
        <Para>
          Each request is one upsert: insert the bucket, or on conflict add one to{" "}
          <code className="inline">count</code> and reset <code className="inline">window_start</code>{" "}
          only when the interval has already elapsed. docs/database-schema.md calls that a single
          round-trip fixed-window counter and docs/plan.md D13 records the reasoning — a Postgres
          counter table with atomic upsert for the hour and day windows, per key and per public API,
          chosen over a Redis vendor at this scale, with request logs already available for analytics.
          The same D13 row names Upstash as the documented scale-up path, and docs/security.md §6
          repeats it as the answer to the burst trade-off below.
        </Para>
        <Callout label="One more bucket, from the security review" tone="outline">
          <p>
            docs/security-review.md records that the engine threads the caller&#39;s IP into the limiter
            and consumes an additional hour bucket keyed by IP, skipping it only when the deployment
            forwards no client address at all. That is a second, per-source-hour ceiling on top of the
            per-key ones — and it is documented in a review of the code rather than in §1.4, so treat
            §1.4 as the contract. Multiple keys sharing one source may meet an additional IP ceiling;
            distributing one key over sources does not remove its per-key limits.
          </p>
        </Callout>
      </DocsSection>

      <DocsSection
        id="defaults-not-config"
        index="7.4"
        heading="These are defaults, not your configuration"
        source="docs/backend-api-contract.md §1.4 · §4.10 · docs/database-schema.md"
      >
        <Para>
          The numbers on this page are the <Em>platform&#39;s documented defaults</Em>. They are not a
          customer&#39;s settings, and today there is no documented way to raise a default: the
          <code className="inline">updatePlatformSettings</code> action that would take{" "}
          <code className="inline">defaultRateLimits</code> is listed in §2 and marked{" "}
          <Em>blocked</Em> in §4.10 — no platform-settings table exists among the eleven, and the only
          rate-limit column in the schema is the per-API{" "}
          <code className="inline">rate_limit_per_hour</code>.
        </Para>
        <BulletList
          items={[
            <>
              <Em>What you can set:</Em> a lower hourly ceiling for one endpoint, via{" "}
              <code className="inline">rate_limit_per_hour</code>. docs/database-schema.md
              describes write verbs on the API row separately, and the dashboard surfaces the count of
              endpoints that override.
            </>,
            <>
              <Em>What you cannot set, per the docs:</Em> the day ceiling, a per-key override, or a
              platform-wide change. Nothing in §1.4, §4.6 or docs/database-schema.md offers them, and
              §4.10 is explicit that the settings action is not typeable until a storage decision
              exists.
            </>,
            <>
              <Em>What this page will not do:</Em> print a “contact us for higher limits” promise, a
              tier table, or a number that is not in the contract. No documented route to an increase
              exists in §1.4, §4.6 or §4.10, so this page offers none either.
            </>,
          ]}
        />
      </DocsSection>

      <DocsSection
        id="other-ceilings"
        index="7.5"
        heading="The other ceilings, next to the request limits"
        source="docs/backend-api-contract.md §1.2 · §1.3 · §1.5 · docs/architecture.md · docs/security.md §2"
      >
        <Para>
          A 429 means you asked too often. These mean you asked for too much at once, and they refuse
          with different codes — worth separating before you write a retry loop.
        </Para>
        <ParamTable
          label="Ceilings that are not request-rate limits"
          nameLabel="Ceiling"
          typeLabel="Scope"
          meaningLabel="Documented behaviour"
          rows={OTHER_CEILINGS}
        />
      </DocsSection>

      <DocsSection
        id="tradeoffs"
        index="7.6"
        heading="Trade-offs the docs state out loud"
        source="docs/security.md §6 · docs/plan.md D13"
      >
        <BulletList
          items={[
            <>
              <Em>A fixed window can burst roughly twice at its edges.</Em> docs/security.md §6 lists
              this as an accepted trade-off, with the reasoning that the windows are small and the
              Upstash upgrade path is documented. In practice: 1000 requests just before the hour turns
              over and 1000 just after is a legal burst of 2000 in an hour of wall-clock time — so the
              day ceiling, not the hour one, is what bounds a runaway client.
            </>,
            <>
              <Em>The in-memory invitation note is superseded.</Em> docs/security.md §6 still describes
              a cold-instance reset, but contract §2 explicitly requires a DB fixed-window invitation
              bucket shared across instances. That older trade-off is not the current contract.
            </>,
            <>
              <Em>“Sliding-window” appears in one document and not in the others.</Em> docs/architecture.md’s
              engine walkthrough describes step 4 as sliding-window counters, while §1.4 and
              docs/database-schema.md both say fixed windows and describe a fixed-window upsert. This page
              follows §1.4; the discrepancy is recorded for the maintainers rather than smoothed over.
            </>,
            <>
              <Em>Buckets are pruned, limits are not journalled.</Em> docs/database-schema.md notes{" "}
              <code className="inline">rate_limit_buckets</code> is pruned nightly alongside the logs, so
              there is no historical record of when you were limited.{" "}
              <code className="inline">api_request_logs</code> is where a 429 shows up — with the{" "}
              <code className="inline">error_category</code> column that stores{" "}
              <code className="inline">rate_limit</code> as one of its six documented values.
            </>,
          ]}
        />
      </DocsSection>

      <DocsSection
        id="being-a-good-citizen"
        index="7.7"
        heading="Calling within the limits"
        source="Guidance derived from §1.3 · §1.4 · §1.5 — the contract itself does not prescribe a client"
      >
        <Para>
          This section is advice, and it says so. What the contract gives you is fixed windows, a
          documented page size, and one honest response header; the rest follows from those.
        </Para>
        <BulletList
          items={[
            <>
              <Em>Page instead of polling.</Em> <code className="inline">limit</code> and{" "}
              <code className="inline">offset</code> (or <code className="inline">page</code>/
              <code className="inline">per_page</code>, which §1.3 defines as{" "}
              <code className="inline">offset = (page-1)*per_page</code>) get a large tab through 1000
              requests an hour. Mixing the two families is a documented{" "}
              <code className="inline">400</code>.
            </>,
            <>
              <Em>Ask for the columns you use.</Em> <code className="inline">fields</code>/<code className="inline">select</code>{" "}
              is applied after filtering, so it shrinks the response, not the counter.
            </>,
            <>
              <Em>One in-flight request per key, and back off on 429 by Retry-After.</Em>{" "}
              <code className="inline">rate_limit</code> and <code className="inline">google</code> are the
              two retryable categories; treat the other four as “changing nothing”.
            </>,
            <>
              <Em>Remember whose quota you are spending.</Em> Every read and write runs on the
              spreadsheet owner&#39;s Google grant, so a client that hammers the API spends a person&#39;s
              upstream quota as well as its own bucket.
            </>,
          ]}
        />
        <Callout label="Not implemented, not advertised">
          <p>
            No bulk export, no webhook, no batched multi-key bucket, no raised-limit request form is
            documented for <code className="inline">/api/v1</code>. §1.3 answers its own question about
            bulk forms with <Em>No</Em>, and §4.10 lists what is deferred. If a page somewhere promises
            one of those, that page is wrong.
          </p>
        </Callout>
      </DocsSection>
    </DocsPage>
  )
}
