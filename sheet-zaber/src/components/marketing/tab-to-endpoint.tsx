import { TitleAside } from "@/components/ui/chapter"

/*
 * The product in one picture: a row lights up in the tab, then comes back as JSON. Angle brackets
 * mark placeholders, per the landing page's policy: this is a shape, not a captured response.
 */
const ROWS = [0, 1, 2, 3]

export function TabToEndpoint() {
  return (
    <figure className="scroll-rise mt-10 grid min-w-0 gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch">
      <div className="panel min-w-0 overflow-hidden" aria-hidden="true">
        <p className="folio border-b border-rule px-4 py-3">Your tab</p>
        <div className="grid grid-cols-3 border-b border-rule font-mono text-[12px] text-paper">
          {["<key>", "<column>", "<column>"].map((cell, index) => (
            <span key={index} className="truncate border-r border-rule px-3 py-2.5 last:border-r-0">{cell}</span>
          ))}
        </div>
        {ROWS.map((row) => (
          <div key={row} className={`grid grid-cols-3 border-b border-rule font-mono text-[12px] text-dust last:border-b-0 ${row === 1 ? "plate-row" : ""}`}>
            {[0, 1, 2].map((cell) => (
              <span key={cell} className="truncate border-r border-rule px-3 py-2.5 last:border-r-0">&lt;cell&gt;</span>
            ))}
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="plate-arrow flex items-center justify-center text-[28px] text-paper">
        <span className="rotate-90 lg:rotate-0">→</span>
      </div>

      <div className="panel min-w-0 overflow-hidden" aria-hidden="true">
        <p className="folio border-b border-rule px-4 py-3">Your endpoint</p>
        <pre className="plate-json overflow-x-auto px-4 py-4 font-mono text-[13px] leading-[1.7] text-mist">{`GET /api/v1/{api}/{key}

{
  "data": { "<column>": "<cell>" },
  "meta": { "api_id": "<api-id>" }
}`}</pre>
      </div>

      <figcaption className="text-[clamp(20px,2.4vw,30px)] leading-[1.2] tracking-[-0.02em] lg:col-span-3">
        One tab becomes one endpoint, <TitleAside>and rows are addressed by key, never by number.</TitleAside>
      </figcaption>
    </figure>
  )
}
