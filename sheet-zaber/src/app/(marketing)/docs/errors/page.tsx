import type { Metadata } from "next"

import { BulletList, Em, Para } from "@/components/marketing/legal-doc"
import {
  Callout,
  DocsPage,
  DocsSection,
  ErrorCodeTable,
  ParamTable,
  ShapeBlock,
  SubHeading,
  type ErrorCodeRow,
} from "@/components/docs/docs-page"
import { PillLink } from "@/components/ui/button"
import { SnippetTabs } from "@/components/ui/snippet-tabs"
import type { SnippetRequest } from "@/lib/snippets"

/*
 * /docs/errors — the public code set is docs/backend-api-contract.md §1.2's status table, code for
 * code; the category→status map is `CATEGORY_STATUS`/`statusFor` as §4.4 documents it and as it is
 * written in src/lib/action-result.ts. Where the two disagree this page says so instead of picking
 * a favourite: §1.2 governs what an /api/v1 caller sees, §4.4 governs the dashboard's JSON routes,
 * and the 403/405 carve-outs are §4.4's own words.
 */

export const metadata: Metadata = {
  title: "Error reference",
  description:
    "Every documented Sheet Zaber API error code with its HTTP status, its category, and what the caller should do about it.",
}

const REFUSAL_REQUEST: SnippetRequest = {
  baseUrl: "https://sheet.zaber.tech/api/v1",
  method: "GET",
  apiId: "<api-id>",
  recordId: "<record>",
  apiKey: "sz_live_…",
}

/**
 * §1.2 in full — eleven status rows, twenty-one code names. The action column is guidance derived
 * from what the contract states about each code; the status, code and category columns are the
 * table itself.
 */
const PUBLIC_CODES: ErrorCodeRow[] = [
  {
    code: "validation_failed",
    status: 400,
    category: "validation",
    action: (
      <>
        The request asked for something the engine can check without touching Google: a bad page
        value, <code className="inline">page</code> mixed with <code className="inline">offset</code>,
        an unknown column in a filter or sort, an empty <code className="inline">q</code> on
        search. Fix the query or the body; retrying it unchanged answers the same way.
      </>
    ),
  },
  {
    code: "invalid_range",
    status: 400,
    category: "validation",
    action: (
      <>
        The <code className="inline">/range/…</code> segment failed the A1 regex or fell outside the
        tab&#39;s bounds. Re-derive the notation from the tab you are reading and check the
        sheet name against the configured tab.
      </>
    ),
  },
  {
    code: "invalid_json",
    status: 400,
    category: "validation",
    action: (
      <>
        The body did not parse as JSON. Send a parsed object (or array, where the operation allows
        one) rather than a form-encoded or truncated payload.
      </>
    ),
  },
  {
    code: "missing_key",
    status: 401,
    category: "auth",
    action: (
      <>
        No <code className="inline">Authorization: Bearer</code> header arrived. Add it — and
        do not fall back to <code className="inline">?key=</code>, which §1.1 explicitly does not
        support.
      </>
    ),
  },
  {
    code: "invalid_key",
    status: 401,
    category: "auth",
    action: (
      <>
        The key is not one the engine will honour: revoked, expired, or not the key of that API&#39;s
        user. §1.2 and docs/security.md §2 keep this message identical for all three so the
        endpoint stays a bad-key check and not an existence oracle. Rotate one at <code className="inline">/keys</code>.
      </>
    ),
  },
  {
    code: "key_scope_insufficient",
    status: 403,
    category: "auth",
    action: (
      <>
        A <code className="inline">read</code> key was used on a write verb, or a write key on a read
        (§1.1 maps <code className="inline">read</code> to GET and <code className="inline">write</code>{" "}
        to POST/PATCH/PUT/DELETE). Use a key with the scope the verb needs.
      </>
    ),
  },
  {
    code: "key_restricted",
    status: 403,
    category: "auth",
    action: (
      <>
        The key&#39;s <code className="inline">allowed_api_ids</code> is set and this API is not in it
. Use a key authorised for this API. The API&#39;s{" "}
        <code className="inline">allowed_operations</code> is a separate control; a disallowed verb
        is <code className="inline">operation_not_allowed</code>, not a key restriction.
      </>
    ),
  },
  {
    code: "api_disabled",
    status: 403,
    category: "auth",
    action: (
      <>
        The API exists but is switched off, so the engine refuses before reading the tab. Nothing a
        client can retry — the owner re-enables it in the dashboard.
      </>
    ),
  },
  {
    code: "operation_not_allowed",
    status: 403,
    category: "auth",
    action: (
      <>
        The operation is not available for that API. §1.3 names the documented case: a single-record
        read on an API with no <code className="inline">primary_key_column</code>, where the message
        tells you to set a primary key or use list plus filter.
      </>
    ),
  },
  {
    code: "write_requires_primary_key",
    status: 403,
    category: "auth",
    action: (
      <>
        A write was attempted against an API the engine cannot resolve a row for. §1.3 makes every
        PATCH, PUT and DELETE a primary-key lookup, so the fix is the same configured primary key.
      </>
    ),
  },
  {
    code: "api_not_found",
    status: 404,
    category: "not_found",
    action: (
      <>
        The path segment names no API. Check it against{" "}
        <code className="inline">api_configurations.id</code>, which is the same value{" "}
        <code className="inline">meta.api_id</code> echoes on a success.
      </>
    ),
  },
  {
    code: "record_not_found",
    status: 404,
    category: "not_found",
    action: (
      <>
        Zero rows matched the primary-key value. §1.3: matching is exact and case-sensitive, so retry
        only with the value as the sheet stores it, or read it back from a list call.
      </>
    ),
  },
  {
    code: "ambiguous_record",
    status: 409,
    category: "validation",
    action: (
      <>
        More than one row matched (§1.2 names the case: PK matched &gt;1 row; §1.3 gives 409 for a
        single read). Nothing was written — §1.5 promises ambiguity always 409s rather than silently
        touching two rows. Make the key unique, or address the row with list plus filter.
      </>
    ),
  },
  {
    code: "body_too_large",
    status: 413,
    category: "validation",
    action: (
      <>
        The request body crossed the 1 MB ceiling §1.2 names. Split the work into smaller requests;
        §1.3 also caps a create array at 500 objects per request.
      </>
    ),
  },
  {
    code: "google_sheet_inaccessible",
    status: 422,
    category: "google/validation",
    action: (
      <>
        The spreadsheet behind the API could not be read. docs/google-integration.md §3 ties this to{" "}
        <code className="inline">spreadsheets.get</code> returning 403/404 at register or refresh
        time, and docs/database-schema.md records the state as an API whose snapshot is unusable.
        The owner re-checks the sheet and the connection.
      </>
    ),
  },
  {
    code: "tab_not_found",
    status: 422,
    category: "google/validation",
    action: (
      <>
        The configured tab no longer exists in the spreadsheet — it was renamed or deleted after
        registration. Repoint the API at the tab, or rename the tab back.
      </>
    ),
  },
  {
    code: "header_mismatch",
    status: 422,
    category: "google/validation",
    action: (
      <>
        A write body used keys that are not in the header row; §1.2 says the response lists the
        offenders, and §1.3 confirms missing keys are allowed while unknown ones are not. Align the
        object&#39;s keys to the header row and resend.
      </>
    ),
  },
  {
    code: "rate_limited",
    status: 429,
    category: "rate_limit",
    action: (
      <>
        A documented window is full. §1.2 and §1.4 both put the wait in the{" "}
        <code className="inline">Retry-After</code> header, in seconds — wait that long and resend;
        do not retry immediately and do not fan out. See the Rate limits page.
      </>
    ),
  },
  {
    code: "google_reauth_required",
    status: 503,
    category: "google",
    action: (
      <>
        The owner&#39;s Google grant needs a fresh consent. §1.5 describes the engine&#39;s side: one
        token refresh and retry, and this code when that fails. A client cannot fix it — the owner
        re-connects, and the request is safe to retry once they have.
      </>
    ),
  },
  {
    code: "google_quota_exceeded",
    status: 503,
    category: "google",
    action: (
      <>
        Google itself throttled the call. §1.5 states the engine passes the Google{" "}
        <code className="inline">Retry-After</code> through rather than inventing a number, so honour
        the header and retry after it.
      </>
    ),
  },
  {
    code: "internal_error",
    status: 500,
    category: "internal",
    action: (
      <>
        The engine failed in a way it does not describe to callers — §1.2 notes the message never
        leaks internals. Keep the status, code and request time for support. For a failed write,
        check the sheet before retrying: the contract provides no idempotency-key guarantee.
      </>
    ),
  },
]

/** `CATEGORY_STATUS` as written in src/lib/action-result.ts, quoted by §4.4. */
const CATEGORY_ROWS = [
  { name: "validation", type: "400", meaning: <>Malformed or impossible input; nothing was read or written.</> },
  { name: "auth", type: "401", meaning: <>The caller itself is not established. §4.4&#39;s carve-out below is the only 403.</> },
  { name: "not_found", type: "404", meaning: <>The named resource does not exist for this caller.</> },
  { name: "rate_limit", type: "429", meaning: <>A documented window is full; the wait is in <code className="inline">Retry-After</code>.</> },
  { name: "google", type: "503", meaning: <>Upstream Google problem — retryable, never a caller bug.</> },
  { name: "internal", type: "500", meaning: <>Anything else, with no detail in the body by design.</> },
]

/** §4.4's internal code set: the dashboard's session-cookie surface, not /api/v1. */
const INTERNAL_CODES: ErrorCodeRow[] = [
  {
    code: "validation_failed",
    status: 400,
    category: "validation",
    action: <>Input rejected by zod; <code className="inline">fields</code> carries the per-field messages.</>,
  },
  {
    code: "unauthenticated",
    status: 401,
    category: "auth",
    action: (
      <>
        No <code className="inline">sz_session</code> cookie, one that fails signature or expiry
        verification, or one whose user row is gone or <code className="inline">disabled</code>.
        Sign in again.
      </>
    ),
  },
  {
    code: "forbidden",
    status: 403,
    category: "auth",
    action: (
      <>
        A <Em>valid</Em> session whose role is not enough (§4.4: answered 403, never 401, because 401
        would claim a working cookie is broken). Ask an owner for the role.
      </>
    ),
  },
  {
    code: "method_not_allowed",
    status: 405,
    category: "validation",
    action: (
      <>
        A verb the route does not export; §4.4 states it is answered 405 with{" "}
        <code className="inline">Allow</code>. Use a listed verb.
      </>
    ),
  },
  {
    code: "invalid_invitation",
    status: 401,
    category: "auth",
    action: (
      <>
        Unknown, expired, revoked or exhausted code — byte-identical in all four cases so the route is
        not an oracle. Ask for a fresh invitation.
      </>
    ),
  },
  {
    code: "already_registered",
    status: 401,
    category: "auth",
    action: (
      <>
        Redemption collided with the unique Google subject or the partial unique on email. Sign in
        with the account that already holds it.
      </>
    ),
  },
  {
    code: "pending_expired",
    status: 401,
    category: "auth",
    action: (
      <>
        A missing, tampered or past-<code className="inline">exp</code>{" "}
        <code className="inline">sz_pending</code> cookie. §4.4: the fix is a round trip to{" "}
        <code className="inline">/auth/google</code>, not a retry of the code; the error carries
        nothing.
      </>
    ),
  },
  {
    code: "rate_limited",
    status: 429,
    category: "rate_limit",
    action: (
      <>
        The invitation bucket is full — 5 per 15 minutes per pending cookie <Em>and</Em> per IP
. <code className="inline">fields.retry_after</code> carries the seconds.
      </>
    ),
  },
  {
    code: "invalid_key",
    status: 401,
    category: "auth",
    action: (
      <>
        On the internal surface this is a playground key id that is absent <Em>or</Em> not owned by the
        session user — one shape for both, no existence oracle.
      </>
    ),
  },
  {
    code: "not_found",
    status: 404,
    category: "not_found",
    action: (
      <>
        A mutation id naming no row the session user owns; identical for “does not exist” and “not
        yours”.
      </>
    ),
  },
  {
    code: "google_reauth_required",
    status: 503,
    category: "google",
    action: (
      <>
        The action needs a connection whose status is <code className="inline">reauth_required</code>{" "}
. Re-consent.
      </>
    ),
  },
  {
    code: "google_not_connected",
    status: 503,
    category: "google",
    action: (
      <>
        There is no <code className="inline">google_connections</code> row at all — the fix is{" "}
        <code className="inline">/auth/google</code>, not re-consent, which is exactly why §4.4 keeps it
        distinct from <code className="inline">google_reauth_required</code>.
      </>
    ),
  },
  {
    code: "google_sheet_inaccessible",
    status: 503,
    category: "google",
    action: (
      <>
        The same code name, two documented statuses: §4.4 files it under <code className="inline">google</code>,
        which the internal map answers 503, while §1.2 lists it at 422 on the public surface. Read the
        status off the response you actually got.
      </>
    ),
  },
  {
    code: "google_unavailable",
    status: 503,
    category: "google",
    action: (
      <>
        A Google call failed for a non-auth reason (network, 5xx, quota). §4.4 marks it retryable.
      </>
    ),
  },
  {
    code: "playground_unreachable",
    status: 500,
    category: "internal",
    action: (
      <>
        §4.4 is blunt: the engine produced <Em>no</Em> answer for a playground call, and fabricating a{" "}
        <code className="inline">status: 500</code> is forbidden — this code is the only acceptable
        outcome when the handler throws before responding.
      </>
    ),
  },
  {
    code: "internal_error",
    status: 500,
    category: "internal",
    action: (
      <>
        The fixed sentence from <code className="inline">internalError()</code>: “The request could not
        be completed.” No detail field exists by design; the cause stays in the server log.
      </>
    ),
  },
]

export default function DocsErrorsPage() {
  return (
    <DocsPage
      folio="Docs · 06 Error reference"
      title="Error reference"
      lead={
        <>
          Twenty-one codes are documented for <code className="inline">/api/v1</code> in
          docs/backend-api-contract.md §1.2, across ten status classes, and every one of them arrives
          in the same body: <code className="inline">{"{ error: { code, message, category } }"}</code>.
          This page reproduces that table, adds what the caller should actually do, and then shows the
          category-to-status map §4.4 defines — including where the two documents do not line up.
        </>
      }
      facts={[
        { label: "Public codes", value: "21, in §1.2's table" },
        { label: "Body on every refusal", value: "code + message + category" },
        { label: "Categories", value: "auth · rate_limit · validation · google · not_found · internal" },
        { label: "The 429 extra", value: "Retry-After header, in seconds" },
      ]}
    >
      <DocsSection
        id="how-to-branch"
        index="6.1"
        heading="Branch on the code, decide on the category"
        source="docs/backend-api-contract.md §1.2 · §4.4"
      >
        <Para>
          <code className="inline">code</code> is the specific reason and is stable enough to switch on.{" "}
          <code className="inline">category</code> groups failures, but retry decisions also need the
          specific code and the operation: not every Google failure is fixed by waiting.
          <code className="inline">message</code> is for a log line or a
          support ticket: §4.4 requires it never to contain SQL, stack traces, tokens, keys, cell
          contents or another user&#39;s data, so it is safe to display and useless to parse.
        </Para>
        <BulletList
          items={[
            <>
              <Em>Wait or repair, according to the code:</Em> honour <code className="inline">Retry-After</code>{" "}
              for <code className="inline">rate_limited</code> and <code className="inline">google_quota_exceeded</code>.
              Reauth needs the owner&#39;s consent; an inaccessible sheet needs its access repaired.
              A shared <code className="inline">google</code> category does not make these interchangeable.
            </>,
            <>
              <Em>Not retryable as sent:</Em> <code className="inline">validation</code>,{" "}
              <code className="inline">auth</code>, <code className="inline">not_found</code>. A retry
              of the identical request produces the identical refusal.
            </>,
            <>
              <Em>Do not blindly replay writes after a 500.</Em> The contract gives no idempotency-key
              guarantee. Check whether the write took effect before retrying; report persistent failures.
            </>,
            <>
              <Em>The action column below is guidance,</Em> not contract. Statuses, code names and
              categories are §1.2&#39;s and §4.4&#39;s own.
            </>,
          ]}
        />
      </DocsSection>

      <DocsSection
        id="public-codes"
        index="6.2"
        heading="The public codes"
        source="docs/backend-api-contract.md §1.2, every row of the table"
      >
        <Para>
          The status column is §1.2&#39;s. Its grouped 422 row says{" "}
          <code className="inline">google/validation</code> without assigning a category to each code.
          This is source notation, not a valid literal <code className="inline">ErrorCategory</code>
          from §4.4; the per-code assignment remains unspecified in that table.
        </Para>
        <ErrorCodeTable
          label="Public error codes and their documented statuses"
          rows={PUBLIC_CODES}
        />
        <SubHeading>A refusal, end to end</SubHeading>
        <Para>
          The single-record read below is the documented way to reach{" "}
          <code className="inline">operation_not_allowed</code>: §1.3 requires{" "}
          <code className="inline">primary_key_column</code> to be configured for that route, and
          answers 403 when it is not.
        </Para>
        <SnippetTabs request={REFUSAL_REQUEST} />
        <ShapeBlock
          label="403 · §1.3 Single record"
          shape={`{
  "error": {
    "code": "operation_not_allowed",
    "message": "<the message names the fix: set a primary key, or list and filter>",
    "category": "auth"
  }
}`}
          note="Only the code, the category and the status are from the contract; the message text is a paraphrase of §1.3's note, so match on the code."
        />
      </DocsSection>

      <DocsSection
        id="category-status"
        index="6.3"
        heading="How a category becomes a status"
        source="docs/backend-api-contract.md §4.4 · src/lib/action-result.ts (CATEGORY_STATUS, statusFor)"
      >
        <Para>
          §4.4 documents the map the dashboard&#39;s JSON routes use: the wrapper in{" "}
          <code className="inline">src/server/http/internal-route.ts</code> reads a failure through{" "}
          <code className="inline">statusFor</code>, which is a lookup in{" "}
          <code className="inline">CATEGORY_STATUS</code> with 500 as the fallback for a category the
          map does not hold.
        </Para>
        <ParamTable
          label="Category to status map"
          nameLabel="error.category"
          typeLabel="Status"
          meaningLabel="What the class means"
          rows={CATEGORY_ROWS}
        />
        <SubHeading>The two documented exceptions</SubHeading>
        <BulletList
          items={[
            <>
              <Em>
                <code className="inline">forbidden</code> → 403.</Em> §4.4 calls this its one carve-out
                from <code className="inline">auth = 401</code>: a valid cookie with an insufficient role
                must not be reported as a broken cookie.
            </>,
            <>
              <Em>
                <code className="inline">method_not_allowed</code> → 405 with{" "}
                <code className="inline">Allow</code>.</Em> Its category is{" "}
                <code className="inline">validation</code>, which the map alone answers 400, and §4.4
                states 405 for it in the code table. So the exceptions listed by §4.4 are two, even
                though the status-mapping row calls <code className="inline">forbidden</code> the only
                carve-out.
            </>,
          ]}
        />
        <Callout label="Where §1.2 and §4.4 do not line up" tone="outline">
          <p>
            Four of §1.2&#39;s public rows are not producible by{" "}
            <code className="inline">CATEGORY_STATUS</code> on their own: the five 403 codes all carry
            the category <code className="inline">auth</code>, which maps to 401; and 409,{" "}
            <code className="inline">ambiguous_record</code>, 413, <code className="inline">body_too_large</code>{" "}
            and the 422 group have no entry in a map whose highest validation status is 400. That is not
            a contradiction for a caller — §1.2 is the table that documents{" "}
            <code className="inline">/api/v1</code>, and <code className="inline">statusFor</code> is
            documented in §4.4 as the internal JSON-route map — but it does mean the two tables answer
            different questions. Read the status off the response you got, use the category to decide
            whether to retry, and do not compute one from the other.
          </p>
        </Callout>
      </DocsSection>

      <DocsSection
        id="internal-codes"
        index="6.4"
        heading="The dashboard's own code set"
        source="docs/backend-api-contract.md §4.4, internal code table"
      >
        <Para>
          <code className="inline">/api/internal/**</code> is the signed-in dashboard&#39;s surface:
          session cookie, guards re-checked per route, success serialised as{" "}
          <code className="inline">{"{ data: … }"}</code> with no <code className="inline">meta</code>{" "}
. Its codes share the same <code className="inline">category</code> vocabulary as the
          public API, and §4.4&#39;s reuse rule says an internal failure uses an existing code when one
          fits and a new code only when none does. This table is here for completeness and because
          §4.4 is where the status map lives —{" "}
          <Em>an /api/v1 integration will not receive these</Em>. Six code names do appear in both
          tables (<code className="inline">validation_failed</code>, <code className="inline">invalid_key</code>,{" "}
          <code className="inline">rate_limited</code>, <code className="inline">google_sheet_inaccessible</code>,{" "}
          <code className="inline">google_reauth_required</code>, <code className="inline">internal_error</code>);
          the Status column below is §4.4&#39;s map applied to each category, with the two exceptions §4.4
          states by name.
        </Para>
        <ErrorCodeTable label="Internal codes, their category and status" rows={INTERNAL_CODES} />
        <SubHeading>Codes that never cross over</SubHeading>
        <Para>
          §4.4 closes the list by naming the five codes that belong to the public engine and never
          appear on <code className="inline">/api/internal/**</code>:{" "}
          <code className="inline">api_not_found</code>, <code className="inline">invalid_range</code>,{" "}
          <code className="inline">operation_not_allowed</code>, <code className="inline">key_restricted</code>
          , <code className="inline">key_scope_insufficient</code>. If you are handling one of those,
          you are on <code className="inline">/api/v1</code>.
        </Para>
      </DocsSection>

      <DocsSection
        id="carrying-more"
        index="6.5"
        heading="Two refusals that carry something extra"
        source="docs/backend-api-contract.md §1.2 · §1.4 · §1.5 · §4.4"
      >
        <BulletList
          items={[
            <>
              <Em>
                <code className="inline">rate_limited</code>.</Em> On <code className="inline">/api/v1</code>{" "}
                §1.2 and §1.4 both put the wait in the <code className="inline">Retry-After</code>{" "}
                header, in seconds. Internally, §4.4 has the same number as{" "}
                <code className="inline">fields.retry_after</code> so a route and a server action read
                one value from one place. A <code className="inline">/api/v1</code> caller reads the
                header.
            </>,
            <>
              <Em>
                <code className="inline">google_quota_exceeded</code>.</Em> §1.5 says the engine passes
                Google&#39;s own <code className="inline">Retry-After</code> through rather than
                inventing a number — so the header you get is Google&#39;s, not ours.
            </>,
          ]}
        />
        <Callout label="And one that carries nothing">
          <p>
            <code className="inline">pending_expired</code> is documented as carrying no{" "}
            <code className="inline">fields</code> at all, because retrying the invitation code
            cannot help: the fix is a round trip to <code className="inline">/auth/google</code>.
          </p>
        </Callout>
      </DocsSection>

      <DocsSection
        id="the-500"
        index="6.6"
        heading="What a 500 tells you, and what it refuses to tell you"
        source="docs/backend-api-contract.md §1.2 · §4.4 · src/lib/action-result.ts internalError()"
      >
        <Para>
          §1.2&#39;s 500 row says the message never leaks internals, and §4.4 explains the mechanism: a
          handler that throws is answered <code className="inline">500 internal_error</code> by the
          wrapper after the message is logged server-side, the cause is never serialised into the body,
          and <code className="inline">internalError()</code> has no detail field by design. The one
          documented message is the fixed sentence “The request could not be completed.”
        </Para>
        <Para>
          The useful half of that is what §1.5 adds: every request is logged, including 401s and 404s,
          and logs contain no keys, headers or bodies. So a 500 is not a dead end — it is a row with a
          timestamp and a duration on it, which is what{" "}
          <code className="inline">meta.duration_ms</code> matches, and enough for an owner to
          find in the dashboard&#39;s log view.
        </Para>
      </DocsSection>

      <DocsSection
        id="not-documented"
        index="6.7"
        heading="Not documented, so not promised"
        source="docs/backend-api-contract.md §1.2 · §3 · docs/integration-status.md"
      >
        <BulletList
          items={[
            <>
              There is no documented error-code catalogue separate from §1.2&#39;s table, so this page
              lists exactly those twenty-one and no more. A code you see that is not here is not part of
              the contract.
            </>,
            <>
              There is no documented error body for a 2xx, and none for a redirect: §1.2 defines the
              error envelope as <Em>all non-2xx</Em>.
            </>,
            <>
              <code className="inline">fields</code> is documented in §4.4 for the internal envelope. The
              public §1.2 error shape shows three members; this page does not add a fourth to{" "}
              <code className="inline">/api/v1</code>.
            </>,
            <>
              Per docs/integration-status.md, the public engine&#39;s behaviour is recorded on the
              Measured-versus-asserted board as <Em>asserted</Em>, not measured. These codes are the
              contract&#39;s, reproduced faithfully; the board says which of them have been seen on a wire.
            </>,
          ]}
        />
        <div className="flex flex-wrap gap-2.5 pt-2">
          <PillLink href="/docs/rate-limits" variant="line">
            Rate limits
          </PillLink>
          <PillLink href="/docs/envelope" variant="line">
            The envelope these codes travel in
          </PillLink>
          <PillLink href="/docs/authentication" variant="line">
            Why a key refusal is 401 and a permission refusal is 403
          </PillLink>
        </div>
      </DocsSection>
    </DocsPage>
  )
}
