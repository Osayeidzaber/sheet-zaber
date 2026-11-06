export type FaqItem = { question: string; answer: string }

/** Plain native disclosure rows; the same text feeds the page's FAQPage structured data. */
export function Faq({ items }: { items: FaqItem[] }) {
  return (
    <div className="scroll-rise mt-10 border-t border-rule">
      {items.map((item) => (
        <details key={item.question} className="group border-b border-rule">
          <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-6 py-4 text-[clamp(18px,2vw,24px)] font-semibold tracking-[-0.02em] transition-colors duration-(--dur-fast) hover:text-press [&::-webkit-details-marker]:hidden">
            <h3 className="font-[inherit]">{item.question}</h3>
            <span aria-hidden="true" className="font-mono text-[20px] text-dust transition-transform duration-(--dur-base) ease-(--ease-press) group-open:rotate-45">
              +
            </span>
          </summary>
          <p className="max-w-[72ch] pb-6 text-[15px] leading-[1.7] text-mist">{item.answer}</p>
        </details>
      ))}
    </div>
  )
}
