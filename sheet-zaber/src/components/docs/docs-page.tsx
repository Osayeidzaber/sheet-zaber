import type { ReactNode } from "react"

import { MethodTag, StatusCode, Badge } from "@/components/ui/badge"
import type { HttpMethod } from "@/components/ui/badge"
import { Folio } from "@/components/ui/chapter"
import { CodeBlock } from "@/components/ui/code"
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table"
import { cn } from "@/lib/cn"

/*
 * The typographic vocabulary of /docs. It deliberately reuses the legal pages' rhythm — a mono
 * folio, a heavy display h1, numbered clauses as real in-page anchors, `Para`/`Em`/`BulletList`
 * from `@/components/marketing/legal-doc` — instead of inventing a second system. One h1 per
 * page is enforced here: `DocsPage` renders the only h1, `DocsSection` renders h2, and
 * `SubHeading` renders h3.
 */

export function DocsPage({
  folio,
  title,
  lead,
  facts,
  children,
}: {
  folio: string
  title: string
  lead: ReactNode
  facts?: Array<{ label: string; value: ReactNode }>
  children: ReactNode
}) {
  return (
    <article className="flex flex-col">
      <header>
        <Folio>{folio}</Folio>
        <h1 className="display mt-5 text-[clamp(38px,6.5vw,84px)] text-paper">{title}</h1>
        <div className="mt-5 max-w-[70ch] text-[15px] leading-[1.75] text-mist">{lead}</div>
        {facts ? <FactList facts={facts} /> : null}
      </header>
      <div className="flex flex-col gap-14">{children}</div>
    </article>
  )
}

/** Two-column plate of named constants: the at-a-glance block on /docs and /docs/quickstart. */
export function FactList({ facts }: { facts: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="hairline-top mt-7 grid gap-x-8 gap-y-3 pt-5 sm:grid-cols-2">
      {facts.map((fact) => (
        <div key={fact.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <dt className="folio">{fact.label}</dt>
          <dd className="max-w-[42ch] text-right text-[13px] leading-[1.6] text-mist">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function DocsSection({
  id,
  index,
  heading,
  source,
  children,
}: {
  id: string
  index: string
  heading: string
  /** Where the clause comes from, printed in mono under the heading. */
  source?: string
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6">
      <h2
        id={`${id}-title`}
        className="text-[clamp(21px,3.4vw,27px)] font-bold leading-[1.15] tracking-[-0.03em] text-paper"
      >
        <span className="folio mr-3 align-middle num">{index}</span>
        {heading}
      </h2>
      {source ? <p className="folio mt-2">{source}</p> : null}
      <div className="mt-5 flex flex-col gap-4">{children}</div>
    </section>
  )
}

export function SubHeading({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3
      id={id}
      className="mt-4 scroll-mt-6 text-[15px] font-semibold tracking-[-0.02em] text-paper"
    >
      {children}
    </h3>
  )
}

/**
 * A limitation or an open decision, said in a plate instead of in a footnote. `outline` is the
 * "v1 does not do this" tone (dashed hairline, no hue); `failed` is reserved for a refusal that
 * really is an error class, which is what `danger` means in this system.
 */
export function Callout({
  label,
  tone = "neutral",
  children,
}: {
  label: string
  tone?: "neutral" | "outline" | "failed"
  children: ReactNode
}) {
  return (
    <aside
      className={cn(
        "border-l-2 bg-deep px-4 py-3",
        tone === "neutral" && "border-l-paper",
        tone === "outline" && "border-l-edge border-dashed",
        tone === "failed" && "border-l-danger"
      )}
    >
      <p className="folio">{label}</p>
      <div className="mt-1.5 flex flex-col gap-2 text-[13px] leading-[1.65] text-mist">{children}</div>
    </aside>
  )
}

/** Verb, path, scope and the status a success answers with — the header of one operation. */
export function EndpointHeader({
  method,
  path,
  scope,
  successCode,
  successLabel,
  note,
}: {
  method: HttpMethod
  path: string
  scope: "read" | "write"
  successCode: number
  successLabel: string
  note?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2.5">
        <MethodTag method={method} />
        <span className="font-mono text-[14px] break-all text-paper">{path}</span>
        <Badge variant={scope === "write" ? "inverted" : "neutral"}>{scope} scope</Badge>
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="folio">Success</span>
        <StatusCode code={successCode} className="text-mist" />
        <span className="text-[13px] text-dust">{successLabel}</span>
      </div>
      {note ? <div className="text-[13px] leading-[1.6] text-dust">{note}</div> : null}
    </div>
  )
}

export type ParamRow = { name: string; type: string; meaning: ReactNode }

export function ParamTable({
  rows,
  nameLabel = "Parameter",
  typeLabel = "Shape",
  meaningLabel = "Meaning",
  label,
}: {
  rows: ParamRow[]
  nameLabel?: string
  typeLabel?: string
  meaningLabel?: string
  label: string
}) {
  return (
    <TableScroll label={label} className="rounded-panel border border-rule">
      <Table>
        <thead>
          <Tr className="border-rule">
            <Th>{nameLabel}</Th>
            <Th>{typeLabel}</Th>
            <Th>{meaningLabel}</Th>
          </Tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.name}>
              <Td className="align-top whitespace-nowrap">
                <code className="inline">{row.name}</code>
              </Td>
              <Td className="align-top font-mono text-[12px] text-dust">{row.type}</Td>
              <Td className="align-top text-[13px] leading-[1.6]">{row.meaning}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  )
}

/**
 * The error reference: one documented code per row. The status is printed as a `StatusCode` badge
 * *and* in the same row as the code name and its category, so a caller reading the table aloud
 * still gets the number, and nothing about severity rests on the badge colour alone.
 */
export function ErrorCodeTable({ label, rows }: { label: string; rows: ErrorCodeRow[] }) {
  return (
    <TableScroll label={label} className="rounded-panel border border-rule">
      <Table>
        <thead>
          <Tr className="border-rule">
            <Th>Status</Th>
            <Th>error.code</Th>
            <Th>Category</Th>
            <Th>What the caller does</Th>
          </Tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Tr key={`${row.status}-${row.code}`}>
              <Td className="align-top whitespace-nowrap">
                <StatusCode code={row.status} />
              </Td>
              <Td className="align-top whitespace-nowrap">
                <code className="inline">{row.code}</code>
              </Td>
              <Td className="align-top font-mono text-[12px] whitespace-nowrap text-dust">{row.category}</Td>
              <Td className="align-top text-[13px] leading-[1.6]">{row.action}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  )
}

export type FailureRow = { code: number; codes: string[]; detail: ReactNode }

export type ErrorCodeRow = { code: string; status: number; category: string; action: ReactNode }

/**
 * The refusal list for one operation. Every row prints the number *and* the code names *and* the
 * reason, so nothing about a status class is carried by the red of a 5xx alone.
 */
export function FailureList({ rows }: { rows: FailureRow[] }) {
  return (
    <ul className="overflow-hidden rounded-panel border border-rule">
      {rows.map((row) => (
        <li
          key={`${row.code}-${row.codes.join("-")}`}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule px-4 py-3 last:border-b-0"
        >
          <StatusCode code={row.code} className="w-12 shrink-0" />
          <span className="font-mono text-[11px] tracking-[0.06em] text-paper uppercase">
            {row.codes.join(" · ")}
          </span>
          <span className="min-w-0 flex-1 text-[13px] leading-[1.6] text-mist">{row.detail}</span>
        </li>
      ))}
    </ul>
  )
}

/** A response shape from the contract, with the placeholders kept as angle brackets. */
export function ShapeBlock({ label, shape, note }: { label: string; shape: string; note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <CodeBlock label={label} code={shape} copyable={false} />
      {note ? <p className="text-[12px] leading-[1.6] text-dust">{note}</p> : null}
    </div>
  )
}
