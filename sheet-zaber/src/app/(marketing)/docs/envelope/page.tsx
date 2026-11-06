import type { Metadata } from "next"

import { BulletList, Em, Para } from "@/components/marketing/legal-doc"
import { Callout, DocsPage, DocsSection, ParamTable, ShapeBlock, SubHeading } from "@/components/docs/docs-page"
import { CodeBlock } from "@/components/ui/code"
import { SnippetTabs } from "@/components/ui/snippet-tabs"
import type { SnippetRequest } from "@/lib/snippets"

/*
 * /docs/envelope — docs/backend-api-contract.md §1.2 reproduced verbatim, with the field meanings
 * §1.3 and §4.4 give them, plus the boundary §4.4 draws between this envelope and the dashboard's.
 */

export const metadata: Metadata = {
  title: "Response envelope",
  description:
    "The two shapes every /api/v1 call answers with: { data, meta } on success and { error: { code, message, category } } on every non-2xx.",
}

const SUCCESS_PLATE = `{
  "data": <result>,
  "meta": {
    "api_id": "…",
    "count": 12,
    "limit": null,
    "offset": 0,
    "duration_ms": 143
  }
}`

const ERROR_PLATE = `{
  "error": {
    "code": "record_not_found",
    "message": "No record with id=42",
    "category": "not_found"
  }
}`

const REQUEST: SnippetRequest = {
  baseUrl: "https://sheet.zaber.tech/api/v1",
  method: "GET",
  apiId: "<api-id>",
  recordId: "<record>",
  apiKey: "sz_live_…",
}

export default function DocsEnvelopePage() {
  return (
    <DocsPage
      folio="Docs · 04 Response envelope"
      title="Response envelope"
      lead={
        <>
          There are exactly two response shapes on{" "}
          <code className="inline">/api/v1</code>, and the boundary between them is the status code: 2xx
          carries <code className="inline">{"{ data, meta }"}</code>, every non-2xx carries{" "}
          <code className="inline">{"{ error }"}</code>. Nothing else is ever returned, so a client
          needs one parser and one switch on <code className="inline">error.code</code>.
        </>
      }
      facts={[
        { label: "Success", value: "data + meta" },
        { label: "Every refusal", value: "error: code, message, category" },
        { label: "Categories", value: "auth · rate_limit · validation · google · not_found · internal" },
        { label: "Content type", value: "application/json" },
        { label: "Body ceiling", value: "1 MB in; larger is 413" },
      ]}
    >
      <DocsSection
        id="success"
        index="4.1"
        heading="Success"
        source="docs/backend-api-contract.md §1.2, quoted as written"
      >
        <CodeBlock label="2xx · illustrative contract example, not live data" code={SUCCESS_PLATE} copyable={false} />
        <SubHeading>The two members</SubHeading>
        <ParamTable
          label="Success envelope members"
          nameLabel="Member"
          typeLabel="Shape"
          rows={[
            {
              name: "data",
              type: "<result>",
              meaning: (
                <>
                  What the operation returns, and nothing around it: an array of record objects for a list
                  or search, one object for a single record,{" "}
                  <code className="inline">{"{ rows, headers }"}</code> for a range, a write counter for
                  POST/PATCH/DELETE.
                </>
              ),
            },
            {
              name: "meta",
              type: "object",
              meaning: (
                <>
                  The five fields §1.2 lists: <code className="inline">api_id</code>,{" "}
                  <code className="inline">count</code>, <code className="inline">limit</code>,{" "}
                  <code className="inline">offset</code>, <code className="inline">duration_ms</code>.
                </>
              ),
            },
          ]}
        />
        <SubHeading>What each meta field is stated to mean</SubHeading>
        <ParamTable
          label="meta members"
          nameLabel="Field"
          typeLabel="Example in §1.2"
          meaningLabel="Documented meaning"
          rows={[
            {
              name: "api_id",
              type: '"…"',
              meaning: (
                <>
                  The API that answered — <code className="inline">api_configurations.id</code>, which is
                  also the path segment you used.
                </>
              ),
            },
            {
              name: "count",
              type: "12",
              meaning: (
                <>
                  §1.3 defines it for the list operation: the rows returned. It is not documented as the
                  total size of the tab, so do not use it as one.
                </>
              ),
            },
            {
              name: "limit",
              type: "null",
              meaning: (
                <>
                  A number or null, and §1.2&#39;s own example shows <code className="inline">null</code>{" "}
                  alongside a non-zero count. §1.3 gives <code className="inline">limit</code> a documented
                  default of all rows. The contract does not state more about what is echoed, so this page
                  does not either.
                </>
              ),
            },
            {
              name: "offset",
              type: "0",
              meaning: (
                <>
                  The skip position of this page; 0 is the start, and{" "}
                  <code className="inline">page</code>/<code className="inline">per_page</code> are the
                  alternative way to arrive at the same offset.
                </>
              ),
            },
            {
              name: "duration_ms",
              type: "143",
              meaning: (
                <>
                  The engine&#39;s own measured duration — §4.8 makes it the same number the request-log row
                  carries and the number the playground reports, so a slow call is slow in every view of it.
                </>
              ),
            },
          ]}
        />
      </DocsSection>

      <DocsSection
        id="error"
        index="4.2"
        heading="Error"
        source="docs/backend-api-contract.md §1.2, quoted as written"
      >
        <CodeBlock label="Non-2xx · illustrative contract example, not live data" code={ERROR_PLATE} copyable={false} />
        <ParamTable
          label="Error envelope members"
          nameLabel="Member"
          typeLabel="Type"
          meaningLabel="What it carries"
          rows={[
            {
              name: "code",
              type: "string",
              meaning: (
                <>
                  The machine-readable reason, from the documented set on the Error reference page. Branch
                  on this, not on the message.
                </>
              ),
            },
            {
              name: "message",
              type: "string",
              meaning: (
                <>
                  Human text for a log line or a support ticket. It is safe to show to your own users: §4.4
                  requires messages to never contain SQL, stack traces, tokens, keys, cell contents or
                  another user&#39;s data — and the 500 row of §1.2 states the same for{" "}
                  <code className="inline">internal_error</code>.
                </>
              ),
            },
            {
              name: "category",
              type: "enum",
              meaning: (
                <>
                  One of <code className="inline">auth</code>, <code className="inline">rate_limit</code>,{" "}
                  <code className="inline">validation</code>, <code className="inline">google</code>,{" "}
                  <code className="inline">not_found</code>, <code className="inline">internal</code> (§4.4
                  &#39;s <code className="inline">ErrorCategory</code>). It is the class of the failure, which
                  helps group failures; use the specific code and operation to decide whether to retry.
                </>
              ),
            },
          ]}
        />
        <Callout label="One documented extra, and where it lives">
          <p>
            §4.4 allows a fourth member, <code className="inline">fields</code>, on the internal result
            envelope — <code className="inline">rate_limited</code> uses it to carry{" "}
            <code className="inline">retry_after</code> so a route and a server action read one number. For a{" "}
            <code className="inline">/api/v1</code> caller the documented carrier of the same fact is the{" "}
            <code className="inline">Retry-After</code> response header, so read the header.
          </p>
        </Callout>
      </DocsSection>

      <DocsSection
        id="reading-a-response"
        index="4.3"
        heading="Reading a response"
        source="docs/backend-api-contract.md §1.2 · §1.3 · §4.4"
      >
        <Para>
          The worked pair below is a single-record read: the request plate is a real{" "}
          <code className="inline">SnippetRequest</code>, and the two bodies are the shapes above with{" "}
          <code className="inline">data</code> filled in the way §1.3 specifies for that operation.
        </Para>
        <SubHeading>The call</SubHeading>
        <SnippetTabs request={REQUEST} />
        <SubHeading>If it succeeds</SubHeading>
        <ShapeBlock
          label="200 · §1.3 says data is one object"
          shape={`{
  "data": { "<header cell>": "<cell value>" },
  "meta": {
    "api_id": "<api-id>",
    "count": <rows returned>,
    "limit": <the page size you asked for, or null>,
    "offset": <rows skipped, or 0>,
    "duration_ms": <server milliseconds>
  }
}`}
        />
        <SubHeading>If the value matches no row</SubHeading>
        <ShapeBlock
          label="404 · §1.3 Single record"
          shape={`{
  "error": {
    "code": "record_not_found",
    "message": "No record with id=42",
    "category": "not_found"
  }
}`}
          note="The message is §1.2's own example. The row is not found and the response says so in the one shape every refusal uses."
        />
        <BulletList
          items={[
            <>
              <Em>The contract uses two success boundaries.</Em> §1.2 defines the public error envelope
              as <Em>all non-2xx</Em>, while §4.6 defines a successful log row as status below 400.
              Those definitions differ for redirects; use the 2xx boundary for response handling and
              leave the log-filter discrepancy for the contract maintainers.
            </>,
            <>
              <Em>Retry by code and operation, not category alone.</Em> Rate limits require waiting for{" "}
              <code className="inline">Retry-After</code>; reauth requires consent, and inaccessible sheets
              require an access fix. Check the outcome of a failed write before repeating it — the
              contract does not promise idempotent retries.
            </>,
            <>
              <Em>There is no partial envelope.</Em> A response is either <code className="inline">data</code>+
              <code className="inline">meta</code> or <code className="inline">error</code>; the contract does
              not define a body that carries both.
            </>,
          ]}
        />
      </DocsSection>

      <DocsSection
        id="not-this-envelope"
        index="4.4"
        heading="The dashboard API is a different envelope"
        source="docs/backend-api-contract.md §4.4, §2"
      >
        <Para>
          Sheet Zaber has a second surface, <code className="inline">/api/internal</code>, used by the
          signed-in dashboard with a session cookie. Its success body is{" "}
          <code className="inline">{"{ data: … }"}</code> — <Em>no</Em> <code className="inline">meta</code>{" "}
          — and §4.4 states plainly that the two are not interchangeable. These pages document{" "}
          <code className="inline">/api/v1</code>. The internal surface appears here in one place only: the
          Error reference page, because §4.4 is what fixes the category-to-status mapping.
        </Para>
      </DocsSection>
    </DocsPage>
  )
}
