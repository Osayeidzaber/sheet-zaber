import type { Metadata } from "next"

import { BulletList, Em } from "@/components/marketing/legal-doc"
import { Callout, DocsPage, DocsSection } from "@/components/docs/docs-page"
import { NotInV1, OperationBlock, OPERATIONS } from "@/components/docs/operations"

/*
 * /docs/operations — one plate per operation in docs/backend-api-contract.md §1.3, generated from
 * the OPERATIONS table in src/components/docs/operations.tsx. Each plate carries the verb, the path,
 * the parameters, the success shape, an example built by the shared snippet builders (the §3 docs
 * contract) and the statuses §1.1/§1.2 say are realistic for it.
 */

export const metadata: Metadata = {
  title: "Operations",
  description:
    "The eight /api/v1 operations: list, single record, search, range, create, update, replace and delete — parameters, response shapes, examples and failure statuses for each.",
}

export default function DocsOperationsPage() {
  return (
    <DocsPage
      folio="Docs · 05 Operations"
      title="Operations"
      lead={
        <>
          Eight operations against one path prefix. §1.3 fixes the notation used below:{" "}
          <code className="inline">{"{api}"}</code> is <code className="inline">api_configurations.id</code>,
          the header row is <code className="inline">H</code>, and data rows begin at{" "}
          <code className="inline">H+1</code> — so the header row you designate is the row that names your
          columns, and everything under it is records.
        </>
      }
      facts={[
        { label: "Path prefix", value: <code className="inline">https://sheet.zaber.tech/api/v1</code> },
        { label: "Read verbs", value: "GET list · GET one · GET search · GET range" },
        { label: "Write verbs", value: "POST · PATCH · PUT · DELETE" },
        { label: "Write needs", value: "write scope + allowed_operations + read_write" },
        { label: "Bulk update/delete", value: "not in v1; batch create is disputed (see 5.5)" },
      ]}
    >
      <DocsSection
        id="reading-the-plates"
        index="5.0"
        heading="How to read these plates"
        source="docs/backend-api-contract.md §1.2, §1.3"
      >
        <BulletList
          items={[
            <>
              <Em>Statuses.</Em> §1.3 names <code className="inline">201</code> for Create; it does not
              print a response shape for Replace. The other success plates use illustrative 200 statuses —
              §1.2 defines all non-2xx as the error case, so a body with{" "}
              <code className="inline">data</code> and <code className="inline">meta</code> is a success
              whatever the 2xx number is.
            </>,
            <>
              <Em>Failure lists.</Em> Each plate starts with the refusals that are specific to it, then the
              ones every call can meet (§1.1 authentication, §1.2 statuses). Nothing is listed that the
              contract does not define.
            </>,
            <>
              <Em>Column names.</Em> These illustrative requests assume headers{" "}
              <code className="inline">id,email,status,created_at,note</code>, with{" "}
              <code className="inline">id</code> as the primary key for record paths. Replace these with
              your headers. An unknown filter or sort column is 400; an unknown write-body key is{" "}
              <code className="inline">422 header_mismatch</code>.
            </>,
            <>
              <Em>Query encoding.</Em> The examples are serialized by{" "}
              <code className="inline">src/lib/snippets.ts</code> with{" "}
              <code className="inline">application/x-www-form-urlencoded</code>, which is why a repeated{" "}
              <code className="inline">sort</code> repeats its key and a comma inside{" "}
              <code className="inline">fields</code> appears as <code className="inline">%2C</code>.
            </>,
          ]}
        />
        <Callout label="An API without a primary key is read-and-append only" tone="outline">
          <p>
            <code className="inline">primary_key_column</code> is nullable, and null means PATCH, PUT and
            DELETE are refused. Single-record GET is refused the same way, with the
            message telling you to set a primary key or use the list call with a filter.
          </p>
        </Callout>
      </DocsSection>

      {OPERATIONS.map((op) => (
        <OperationBlock key={op.id} op={op} />
      ))}

      <NotInV1 />
    </DocsPage>
  )
}
