import { Folio } from "@/components/ui/chapter"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Panel, Row, RowTitle } from "@/components/ui/panel"
import { InlineCode } from "@/components/ui/code"

/*
 * Scaffolding for the two legal documents (/privacy and /terms). The structure is the same on
 * purpose: a numbered contents list, then one `section` per clause so each heading is a real
 * in-page anchor and each document keeps exactly one h1.
 *
 * Content rule obeyed here: every statement in these documents describes behaviour that is
 * written down in docs/ or implemented in src/. Nothing is asserted because it is usual.
 */

export type LegalSection = {
  /** Anchor id, also used by the contents list. */
  id: string
  /** Display clause number, e.g. "04". */
  index: string
  heading: string
  body: ReactNode
}

export function LegalDocument({
  folio,
  title,
  description,
  facts,
  sections,
}: {
  folio: string
  title: string
  description: string
  facts: Array<{ label: string; value: string }>
  sections: LegalSection[]
}) {
  return (
    <article className="pad-page mx-auto w-full max-w-[820px] py-[clamp(48px,7vw,88px)]">
      <header>
        <Folio>{folio}</Folio>
        <h1 className="display mt-5 text-[clamp(38px,7vw,84px)] text-paper">{title}</h1>
        <p className="mt-5 max-w-[64ch] text-[15px] leading-[1.7] text-mist">{description}</p>

        <dl className="hairline-top mt-7 grid gap-x-8 gap-y-3 pt-5 sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <dt className="folio">{fact.label}</dt>
              <dd className="text-[13px] text-mist">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <nav aria-label="Contents" className="mt-10">
        <p className="folio">Contents</p>
        <ol className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="group flex items-baseline gap-3 text-[14px] text-mist transition-colors duration-(--dur-fast) hover:text-paper"
              >
                <span className="font-mono text-[11px] tracking-[0.1em] text-dust num group-hover:text-paper">
                  {section.index}
                </span>
                {section.heading}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((section) => (
        <section key={section.id} id={section.id} className="mt-12 scroll-mt-6">
          <h2 className="text-[clamp(21px,3.4vw,27px)] font-bold leading-[1.15] tracking-[-0.03em] text-paper">
            <span className="folio mr-3 align-middle">{section.index}</span>
            {section.heading}
          </h2>
          <div className="mt-4 flex flex-col gap-4">{section.body}</div>
        </section>
      ))}
    </article>
  )
}

export function Para({ children }: { children: ReactNode }) {
  return <p className="max-w-[70ch] text-[15px] leading-[1.75] text-mist">{children}</p>
}

export function Em({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-paper">{children}</strong>
}

export function BulletList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex max-w-[70ch] flex-col gap-2.5 border-l-2 border-rule pl-4">
      {items.map((item, index) => (
        <li key={index} className="text-[15px] leading-[1.7] text-mist">
          {item}
        </li>
      ))}
    </ul>
  )
}

/**
 * A stored-field plate: table/column in mono, plain-language note beside it, and the shape of
 * the value (hashed / ciphertext / metadata) as a badge — so the document never has to say
 * "we may store" something it can name.
 */
export function FieldPanel({
  title,
  note,
  rows,
  tone = "neutral",
}: {
  title: string
  note: string
  rows: Array<{ name: string; detail: string; tag?: string }>
  tone?: "neutral" | "outline"
}) {
  return (
    <Panel as="div" className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule px-5 py-4">
        <h3 className="text-[15px] font-semibold tracking-[-0.02em] text-paper">{title}</h3>
        <p className="max-w-[46ch] text-[13px] leading-[1.6] text-dust">{note}</p>
      </div>
      <ul>
        {rows.map((row) => (
          <Row key={row.name} as="li">
            <RowTitle title={row.name} meta={row.detail} />
            {row.tag ? <Badge variant={tone === "outline" ? "outline" : "neutral"}>{row.tag}</Badge> : null}
          </Row>
        ))}
      </ul>
    </Panel>
  )
}

export function CodeLine({ children }: { children: string }) {
  return (
    <p className="font-mono text-[13px] leading-[1.7] text-mist">
      <InlineCode>{children}</InlineCode>
    </p>
  )
}
