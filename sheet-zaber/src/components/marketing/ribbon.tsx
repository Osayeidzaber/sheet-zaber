import { Marquee } from "@/components/fx/marquee"

/** A full-bleed inverted strip between chapters, after the portfolio's ribbon. Decorative only. */
export function Ribbon({ words }: { words: string[] }) {
  return (
    <div aria-hidden="true" className="overflow-hidden border-y border-rule bg-paper py-3 select-none">
      <Marquee repeat={6} className="[--duration:48s]">
        {words.map((word) => (
          <span key={word} className="flex items-center gap-6 pr-6 text-[clamp(18px,2.2vw,28px)] font-extrabold tracking-[-0.02em] whitespace-nowrap text-ink">
            {word}
            <span className="text-[0.7em]">✦</span>
          </span>
        ))}
      </Marquee>
    </div>
  )
}
