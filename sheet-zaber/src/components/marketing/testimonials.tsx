/*
 * Real businesses, as named by the owner. Keep this to facts about them. A quote goes here only when
 * that business has actually given it, with permission to print it.
 */
const STORES = [
  { name: "Corso Velle", kind: "Clothing store" },
  { name: "ARZ", kind: "Panjabi and traditional wear" },
]

export function Testimonials() {
  return (
    <ul className="scroll-rise mt-10 grid gap-px border-y border-rule bg-rule md:grid-cols-2">
      {STORES.map((store) => (
        <li key={store.name} className="flex flex-col gap-3 bg-ink px-1 py-8 md:px-6">
          <p className="text-[clamp(36px,5vw,72px)] leading-none font-extrabold tracking-[-0.04em] text-paper">{store.name}</p>
          <p className="aside text-[clamp(18px,1.8vw,24px)] text-mist">{store.kind}</p>
        </li>
      ))}
    </ul>
  )
}
