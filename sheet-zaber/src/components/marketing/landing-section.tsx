import type { ReactNode } from "react"

import { Folio, TitleAside } from "@/components/ui/chapter"
import { Row } from "@/components/ui/panel"

/* Shared plate for the landing page: a mono folio, a display heading, one lead paragraph. */
export function SectionIntro({
  folio,
  title,
  titleAside,
  lead,
  action,
  titleId,
}: {
  folio: string
  title: string
  titleAside?: string
  lead?: ReactNode
  action?: ReactNode
  /** Set this and point the wrapping section's aria-labelledby at it. */
  titleId?: string
}) {
  return (
    <header className="scroll-rise flex flex-col gap-8">
      <Folio>{folio}</Folio>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="min-w-0">
          <h2 id={titleId} className="display max-w-[16ch] text-[clamp(38px,7vw,104px)] text-paper">
            {title}
            {titleAside ? (
              <>
                {" "}
                <TitleAside>{titleAside}</TitleAside>
              </>
            ) : null}
          </h2>
          {lead ? <p className="mt-6 max-w-[62ch] text-[15px] leading-[1.7] text-mist">{lead}</p> : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-3">{action}</div> : null}
      </div>
    </header>
  )
}

/** Ordered access steps: hairline rows, mono index, no invented screenshots. */
export function NumberedSteps({ items }: { items: Array<{ title: string; body: ReactNode }> }) {
  return (
    <ol className="overflow-hidden rounded-panel border border-rule bg-deep">
      {items.map((item, index) => (
        <Row key={item.title} as="li" className="items-start gap-x-5">
          <span className="folio mt-1 shrink-0 num">{String(index + 1).padStart(2, "0")}</span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold tracking-[-0.02em] text-paper">{item.title}</p>
            <div className="mt-1.5 flex flex-col gap-2 text-[14px] leading-[1.65] text-mist">
              {item.body}
            </div>
          </div>
        </Row>
      ))}
    </ol>
  )
}
