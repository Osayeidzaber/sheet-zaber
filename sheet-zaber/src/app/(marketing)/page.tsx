import type { Metadata } from "next"

import { PillLink } from "@/components/ui/button"
import { CodeBlock } from "@/components/ui/code"
import { InkOrbitFeatures } from "@/components/fx/ink-features"
import type {
  InkFeatureGate,
  InkFeatureGuarantee,
  InkFeatureRoute,
} from "@/components/fx/ink-features"
import { Magnet } from "@/components/fx/magnet"
import { Noise } from "@/components/fx/noise"
import { Faq, type FaqItem } from "@/components/marketing/faq"
import { NumberedSteps, SectionIntro } from "@/components/marketing/landing-section"
import { Ribbon } from "@/components/marketing/ribbon"
import { Testimonials } from "@/components/marketing/testimonials"
import { TabToEndpoint } from "@/components/marketing/tab-to-endpoint"
import { Rings, TitleAside } from "@/components/ui/chapter"
import { Panel, PanelHeader } from "@/components/ui/panel"
import { StatBand } from "@/components/ui/stat-band"
import { SnippetTabs } from "@/components/ui/snippet-tabs"
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "@/lib/site"
import type { SnippetRequest } from "@/lib/snippets"

/*
 * Landing page for the public surface.
 *
 * Content policy obeyed on this page: every claim below is either a line from docs/ or a fact
 * about this repository's own code, and each is cited where it is written. What is deliberately
 * absent: metrics about usage, customers, logos, testimonials, pricing, screenshots, uptime or
 * performance promises. The platform is private and invitation-only, so there is nothing to
 * boast with, and the docs are the contract.
 */

export const metadata: Metadata = {
  title: { absolute: SITE_TITLE },
  description:
    "Sheet Zaber publishes one Google Sheets tab as one REST endpoint: Bearer-key reads and writes, your own Google grant on the data, every limit documented. Private and invitation-only.",
}

/* ------------------------------------------------------------------ features section copy */

/** docs/architecture.md §3 steps 2-4 and 6 — the four checks, in the order the engine runs them. */
const GATES: InkFeatureGate[] = [
  {
    name: "key",
    // docs/backend-api-contract.md §1.1 + docs/plan.md D10 (only the SHA-256 hash was ever stored)
    detail:
      "Authorization: Bearer sz_live_… is hashed and looked up by hash, because the hash is all the database holds. Missing, revoked or expired is a 401.",
  },
  {
    // docs/backend-api-contract.md §1.1 + docs/security.md §3 items 2-3
    name: "access",
    detail:
      "The key must be yours, its scope must cover the verb, any per-key API restriction must allow this endpoint, and the API must be enabled. A foreign key reads like an API that does not exist.",
  },
  {
    // docs/backend-api-contract.md §1.4 + docs/plan.md D13
    name: "limits",
    detail:
      "Hour and day counters per key, in Postgres, with a per-API hourly override. Past a window comes a 429 with Retry-After.",
  },
  {
    // docs/plan.md D9 + docs/backend-api-contract.md §1.3 and docs/google-integration.md §4
    name: "row",
    detail:
      "For PATCH, PUT and DELETE the primary-key value is matched against its column right now to find the row index: no match is 404, two matches are 409 ambiguous_record.",
  },
]

/** docs/backend-api-contract.md §1.3 — verbs, required scope and the `data` each returns. */
const ROUTES: InkFeatureRoute[] = [
  {
    verb: "GET",
    route: "/{api}",
    scope: "read",
    status: 200,
    outcome: "[ ]",
    note: "List records: column=value filters, sort, limit/offset paging and a fields subset, all applied to the tab server-side. No limit means every row of the tab.",
  },
  {
    verb: "GET",
    route: "/{api}/{pk}",
    scope: "read",
    status: 200,
    outcome: "{ }",
    note: "One record, addressed by its primary-key value. The row index is computed at request time and never returned.",
  },
  {
    verb: "GET",
    route: "/{api}/search",
    scope: "read",
    status: 200,
    outcome: "[ ]",
    note: "Case-insensitive substring match across every column, with the same paging, sort and fields parameters. An empty q is a 400.",
  },
  {
    verb: "GET",
    route: "/{api}/range/{A1}",
    scope: "read",
    status: 200,
    outcome: "{ rows, headers }",
    note: "The raw 2-D slice of the tab you asked for, e.g. range/A1:D20. Notation is checked by regex and against the tab size; a sheet part that is not your configured tab is refused.",
  },
  {
    verb: "POST",
    route: "/{api}",
    scope: "write",
    status: 201,
    outcome: "{ created, records }",
    note: "Appends one object after the last non-empty row. Needs write scope, the verb in the API's allowed operations and a read_write API; a key your header row does not know is a 422 header_mismatch.",
  },
  {
    verb: "PATCH",
    route: "/{api}/{pk}",
    scope: "write",
    status: 200,
    outcome: "{ updated: 1 }",
    note: "Merges only the columns you send. Needs a designated, unique primary key: zero rows is 404, more than one is 409.",
  },
  {
    verb: "DELETE",
    route: "/{api}/{pk}",
    scope: "write",
    status: 200,
    outcome: "{ deleted: 1 }",
    note: "Resolves the key, then deletes that single row with a batchUpdate. A body on a delete is refused with 400.",
  },
]

/** docs/plan.md D5/D8/D10/D11/D13, docs/security.md §2, docs/authentication-flow.md §2. */
const GUARANTEES: InkFeatureGuarantee[] = [
  {
    label: "Invitation only",
    detail:
      "ZABER-XXXX-XXXX codes, stored as SHA-256 hashes, with a use limit, an expiry and revocation.",
  },
  {
    label: "Sign-in",
    detail:
      "Google authorization-code flow with PKCE; identity comes from an ID token verified server-side, anchored on its sub claim.",
  },
  {
    label: "Sessions",
    detail:
      "HMAC-SHA-256 signed httpOnly cookie (__Host- prefixed and Secure in production), re-checked against the users row on every guarded request.",
  },
  {
    label: "Tokens at rest",
    detail:
      "Google refresh tokens sealed with AES-256-GCM, so a leaked database is not a usable credential.",
  },
  {
    label: "API keys",
    detail:
      "sz_live_ plus 32 hex characters, kept only as a hash, shown once when you create them.",
  },
  {
    label: "Log retention",
    detail:
      "90 days by default, owner-configurable. No headers, no bodies, no keys and no cell contents in any log.",
  },
  {
    label: "Google data",
    detail:
      "Used only to publish the tabs you register. Not sold, not shared with another app, not used for advertising — and cell contents are never copied into this database.",
  },
]

/* ---------------------------------------------------------------------- example request */

/*
 * A real SnippetRequest, rendered by the same pure builders the playground and /docs use
 * (src/lib/snippets.ts). Base URL is the documented one (docs/backend-api-contract.md §1:
 * "Base: https://sheet.zaber.tech/api/v1"); `<api-id>` and `sz_live_…` are placeholders, never
 * a live credential.
 */
const EXAMPLE_REQUEST: SnippetRequest = {
  baseUrl: "https://sheet.zaber.tech/api/v1",
  method: "GET",
  apiId: "<api-id>",
  query: { limit: "25" },
  apiKey: "sz_live_…",
}

/** Field names from docs/backend-api-contract.md §1.2; values are angle-bracket placeholders. */
const SUCCESS_ENVELOPE = `{
  "data": [ { "<header cell>": "<cell value>" } ],
  "meta": {
    "api_id":     "<api-id>",
    "count":      <rows returned>,
    "limit":      25,
    "offset":     0,
    "duration_ms": <server milliseconds>
  }
}`

/** The one error shape every refusal uses (docs/backend-api-contract.md §1.2). */
const ERROR_ENVELOPE = `{
  "error": {
    "code":     "<error code, e.g. rate_limited>",
    "message":  "<what failed>",
    "category": "auth | rate_limit | validation | google | not_found | internal"
  }
}`

/** Every answer restates a documented fact already on this page. */
const FAQ: FaqItem[] = [
  {
    question: "Can I use a Google Sheet as a REST API?",
    answer: "Yes. Sheet Zaber publishes one tab of one Google spreadsheet as one HTTP endpoint that can list, read one record, search, take an A1 range, append, merge, replace and delete.",
  },
  {
    question: "How are requests authenticated?",
    answer: "With an API key in the Authorization: Bearer header. Keys are shown once when created and stored only as a SHA-256 hash. Query-string keys are refused.",
  },
  {
    question: "What are the rate limits?",
    answer: "By default 1000 requests an hour and 10000 a day per key, with a per-API hourly override. Past a window comes a 429 with Retry-After.",
  },
  {
    question: "Does Sheet Zaber copy my spreadsheet data?",
    answer: "No. Your own Google grant does the read and the write, and cell contents are never copied into its database or written to its logs.",
  },
  {
    question: "Can anyone sign up?",
    answer: "No. The platform is private: an account is created only when an invitation code issued by the owner is redeemed after signing in with Google.",
  },
]

/* Describes the product and repeats the visible FAQ. No ratings, prices or counts: none exist. */
const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", name: SITE_NAME, url: SITE_URL, description: SITE_DESCRIPTION },
    {
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      url: SITE_URL,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      description: SITE_DESCRIPTION,
      author: { "@type": "Person", name: "Osayeed Zaber" },
    },
    {
      "@type": "FAQPage",
      mainEntity: FAQ.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
  ],
}

/* --------------------------------------------------------------------------- the page */

export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA).replace(/</g, "\\u003c") }}
      />

      {/* Cover, after the portfolio's: folio row, the type at full size, a rule, then the promise.
          The rings stand still; the only motion is the opening rise and the magnet on the action. */}
      <section
        aria-labelledby="hero-title"
        className="relative isolate flex min-h-[min(calc(100svh-57px),960px)] flex-col justify-end overflow-hidden border-b border-rule"
      >
        <Rings at={["78%", "38%"]} className="-z-10" />
        <Noise opacity={0.06} size={2} />

        <div className="gutter relative flex w-full flex-col gap-7 pt-[clamp(48px,8vw,96px)] pb-7">
          <div className="folio hero-fade flex flex-wrap justify-between gap-3">
            <span>00 — Cover</span>
            <span className="folio-strong">Private · Invitation only · sheet.zaber.tech</span>
          </div>

          <h1
            id="hero-title"
            className="display text-[clamp(50px,10.4vw,176px)] text-paper"
          >
            <span className="hero-line">
              <span className="hero-rise">Publish a sheet</span>
            </span>
            <span className="hero-line">
              <span className="hero-rise [--d:120ms]">
                tab <TitleAside>as an API.</TitleAside>
              </span>
            </span>
          </h1>

          <div className="rule-draw h-px w-full bg-rule" />

          <div className="flex flex-wrap items-end justify-between gap-8">
            <div className="flex max-w-[64ch] flex-col gap-4">
              {/* Honest sub: one spreadsheet tab → one API (docs/plan.md §2), verbs from
                  docs/backend-api-contract.md §1.3, "your own grant" from docs/google-integration.md §3,
                  row numbers never exposed from §1.5. */}
              <p className="text-[clamp(16px,1.6vw,19px)] leading-[1.6] text-mist">
                Sheet Zaber turns one tab of one Google spreadsheet into one HTTP endpoint: list, read
                one, search, take an A1 range, append, merge, replace, delete — over a{" "}
                <code className="inline">Bearer</code> key, with your own Google grant doing the read
                and the write. Row numbers are never handed back to you, and every limit is printed in
                the docs before you meet it.
              </p>
              <p className="aside text-[clamp(18px,2vw,23px)] leading-[1.4] text-paper">
                If it is not documented at /docs, this page does not promise it.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Travel is clamped, engages only while the pointer is inside the button, and
                  registers nothing at all under prefers-reduced-motion. */}
              <Magnet maxOffset={6} scale={1.02}>
                <PillLink href="/login" variant="solid" size="lg">
                  Sign in with Google <span aria-hidden="true">↗</span>
                </PillLink>
              </Magnet>
              <PillLink href="/docs" variant="line" size="lg">
                Read the API docs
              </PillLink>
            </div>
          </div>

          {/* docs/authentication-flow.md §1 and §4: no self-service signup exists. */}
          <div className="folio flex flex-wrap justify-between gap-4">
            <span>
              There is no open signup — an account is created only when an invitation code the owner
              issued is redeemed.
            </span>
            <a href="#tab-title" className="transition-colors duration-(--dur-fast) hover:text-paper">
              Scroll — 01 The idea ↘
            </a>
          </div>
        </div>
      </section>

      {/* Every word on the strip is a verb from docs/backend-api-contract.md §1.3 or a fact above. */}
      <Ribbon words={["One tab", "One endpoint", "List", "Search", "Append", "Merge", "Replace", "Delete", "Your own Google grant"]} />

      <section aria-labelledby="tab-title" className="border-b border-rule">
        <div className="gutter w-full py-[clamp(56px,8vw,96px)]">
          <SectionIntro folio="01 — The idea" title="A spreadsheet," titleAside="with an address" titleId="tab-title" />
          <TabToEndpoint />
        </div>
      </section>

      {/* The documented defaults, and nothing else. No traffic, no customers, no scores. */}
      <section aria-labelledby="defaults-title" className="border-b border-rule">
        <div className="gutter w-full py-[clamp(48px,7vw,80px)]">
          <SectionIntro
            folio="02 — Documented defaults"
            title="Four numbers,"
            titleAside="all from the contract"
            titleId="defaults-title"
            lead={
              <>
                These are the platform&#39;s stated defaults —{" "}
                <code className="inline">1000</code> requests an hour and{" "}
                <code className="inline">10000</code> a day per key, a 1 MB request body, and 90 days of request-log
                retention. They are not statistics about traffic here.
              </>
            }
          />
          <StatBand
            label="Documented defaults"
            className="scroll-rise mt-10"
            items={[
              { label: "Per key, per hour", value: "1000", sub: "override per API by the hour" },
              { label: "Per key, per day", value: "10000", sub: "a 429 carries Retry-After" },
              { label: "Request body", value: "1 MB", sub: "larger POST → 413" },
              { label: "Log retention", value: "90 days", sub: "owner-configurable" },
            ]}
          />
        </div>
      </section>

      {/* The three live diagrams. InkOrbitFeatures was vendored for this product specifically:
          each diagram traces a documented path, is keyboard-operable, has a DOM text equivalent
          beside it, pauses on user intent and rests under reduced motion. */}
      <InkOrbitFeatures
        brand="Sheet Zaber"
        tag="03 — How a request travels"
        title="One key, four checks,\n*one envelope*"
        endpoints={{
          // docs/backend-api-contract.md §1.1-§1.3
          title: "The verb set, one envelope",
          description:
            "List, read one by key, case-insensitive substring search, a raw A1 range, then append, merge, replace and delete — all answered with { data, meta } or the single { error } shape, over Authorization: Bearer, never a query-string key.",
        }}
        records={{
          // docs/plan.md D9, docs/backend-api-contract.md §1.3, docs/google-integration.md §4
          title: "Rows have keys, not numbers",
          description:
            "PATCH, PUT and DELETE address a row through the primary-key column you designate per API, resolved at request time. No row number is stored, and an API without a key is read-and-append only.",
        }}
        checks={{
          // docs/architecture.md §3
          title: "Four checks before Google",
          description:
            "Key-hash lookup, ownership and scope, the hour and day counters, then primary-key resolution. Fail one and your sheet is never read, the refusal comes back in the same error envelope, and the request is still logged.",
          gates: GATES,
        }}
        limits={{
          // docs/backend-api-contract.md §1.4
          title: "Limits you can plan around",
          description:
            "1000 requests an hour and 10000 a day per key by default, with a per-API hourly override on top. A 429 carries Retry-After and the same error envelope as every other refusal.",
          perHour: 1000,
          perDay: 10000,
        }}
        routes={ROUTES}
        guarantees={GUARANTEES}
      />

      {/* The example call. Request builders are the shipped pure functions; the two plates on
          the right are envelope shapes from the contract with angle-bracket placeholders, so
          nothing here can be mistaken for a captured response or a real credential. */}
      <section aria-labelledby="example-title" className="border-b border-rule">
        <div className="gutter w-full py-[clamp(56px,8vw,96px)]">
          <SectionIntro
            folio="04 — Example request shape"
            title="What a call"
            titleAside="looks like"
            titleId="example-title"
            lead="The same snippets the playground and the docs use."
            action={
              <PillLink href="/docs" variant="line" size="md">
                Every parameter, in the docs
              </PillLink>
            }
          />

          <Panel as="div" className="scroll-rise mt-8">
            <PanelHeader
              title="GET one API, first 25 rows"
              description="Placeholders, not credentials: <api-id> and sz_live_… stand for your own values."
            />
            <div className="grid min-w-0 gap-6 px-5 py-5 lg:grid-cols-2">
              <SnippetTabs request={EXAMPLE_REQUEST} />
              <div className="flex min-w-0 flex-col gap-4">
                <CodeBlock label="Success envelope" code={SUCCESS_ENVELOPE} copyable={false} />
                <CodeBlock label="Every non-2xx" code={ERROR_ENVELOPE} copyable={false} />
              </div>
            </div>
            <div className="hairline-top flex flex-col gap-3 px-5 py-4">
              <p className="max-w-[86ch] text-[13px] leading-[1.7] text-dust">
                The two plates above are the documented response <em>shapes</em> — field names from
                the contract, values left as angle brackets on purpose. They are not a working
                credential and not a live response.
              </p>
              {/* docs/backend-api-contract.md §1.1 and docs/plan.md D10 */}
              <p className="max-w-[86ch] text-[13px] leading-[1.7] text-dust">
                A real key is <code className="inline">sz_live_</code> plus 32 hex characters, is
                shown once when you create it, is stored only as its SHA-256 hash, and must travel
                in the <code className="inline">Authorization</code> header: query-string auth is
                refused because it leaks into logs and referrers.
              </p>
            </div>
          </Panel>
        </div>
      </section>

      {/* Getting in: docs/authentication-flow.md §1 and §4, docs/plan.md D11 and D12,
          docs/google-integration.md §1, §3 and §5. */}
      <section aria-labelledby="access-title" className="border-b border-rule">
        <div className="gutter w-full py-[clamp(56px,8vw,96px)]">
          <SectionIntro
            folio="05 — Access"
            title="How you"
            titleAside="get in"
            titleId="access-title"
            lead="Four steps, and none of them are a signup form."
          />
          <div className="mt-8">
            <NumberedSteps
              items={[
                {
                  title: "Receive an invitation code",
                  body: [
                    <span key="b">
                      The platform owner issues <code className="inline">ZABER-XXXX-XXXX</code>{" "}
                      codes. Only the SHA-256 hash is stored, and a code carries a
                      use limit, an optional expiry and revocation.
                    </span>,
                  ],
                },
                {
                  title: "Sign in with Google",
                  body: [
                    <span key="b">
                      Authorization-code flow with PKCE, and the ID token is verified server-side
                      before anything is trusted: identity is anchored on the verified{" "}
                      <code className="inline">sub</code>, never on a typed email
. The consent request asks for{" "}
                      <code className="inline">openid email profile</code> plus the Sheets read/write
                      scope — no Drive scope, because the Picker is deferred.
                    </span>,
                  ],
                },
                {
                  title: "Redeem the code",
                  body: [
                    <span key="b">
                      Redemption is one atomic conditional{" "}
                      <code className="inline">UPDATE</code> inside the registration transaction, so
                      two people racing on a single-use code produce exactly one account
. Your row is created with{" "}
                      <code className="inline">role = &#39;user&#39;</code>; only the configured
                      owner email can ever be <code className="inline">owner</code>.
                    </span>,
                  ],
                },
                {
                  title: "Register a spreadsheet",
                  body: [
                    <span key="b">
                      You paste a sheet URL or id, and the backend proves the grant by calling{" "}
                      <code className="inline">spreadsheets.get</code> with your own connection:
                      a spreadsheet only someone else can read is never created
.
                    </span>,
                  ],
                },
              ]}
            />
          </div>
          {/* docs/authentication-flow.md §2: the DB row is re-read on every guarded request. */}
          <p className="folio mt-4">
            One more rule worth knowing: disable a user and their session stops working on the next
            request, because the cookie is only a signature — the users row is the authority.
          </p>
        </div>
      </section>

      <section aria-labelledby="voices-title" className="border-b border-rule">
        <div className="gutter w-full py-[clamp(56px,8vw,96px)]">
          <SectionIntro folio="06 — Stores" title="Stores" titleAside="using it" titleId="voices-title" />
          <Testimonials />
        </div>
      </section>

      <section aria-labelledby="faq-title" className="border-b border-rule">
        <div className="gutter w-full py-[clamp(56px,8vw,96px)]">
          <SectionIntro folio="07 — Questions" title="Asked," titleAside="and answered" titleId="faq-title" />
          <Faq items={FAQ} />
        </div>
      </section>

      {/* Closing band. No logos, no quotes, no numbers we do not own — the reason is stated
          instead of decorated. */}
      <section aria-labelledby="closing-title">
        <div className="gutter flex w-full flex-wrap items-end justify-between gap-x-10 gap-y-8 py-[clamp(48px,7vw,88px)]">
          <div className="min-w-0">
            <p className="folio">08 — Where to read further</p>
            <h2
              id="closing-title"
              className="display mt-4 max-w-[16ch] text-[clamp(38px,7vw,104px)] text-paper"
            >
              The contract is <TitleAside>the product.</TitleAside>
            </h2>
            <p className="mt-5 max-w-[62ch] text-[15px] leading-[1.7] text-mist">
              One published contract is the source of truth
              for every verb, error code and default on this page; the docs site renders its
              examples from the same builders as the playground. The platform is private, and its
              request logs are nobody&#39;s marketing material.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PillLink href="/docs" variant="solid" size="md">
              Open the docs
            </PillLink>
          </div>
        </div>
      </section>
    </>
  )
}
