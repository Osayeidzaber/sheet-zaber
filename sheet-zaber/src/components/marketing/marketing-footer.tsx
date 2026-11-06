import Link from "next/link"

import { Rings, TitleAside } from "@/components/ui/chapter"

const SUPPORT_EMAIL = "support@zaber.tech"

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/", label: "Home" },
      { href: "/docs", label: "Documentation" },
      { href: "/login", label: "Sign in" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/privacy", label: "Privacy policy" },
      { href: "/terms", label: "Terms of service" },
    ],
  },
]

const LINK = "inline-flex min-h-11 items-center text-[14px] text-mist transition-colors duration-(--dur-fast) hover:text-paper"

/* The last scene, after the portfolio's: an invitation, an index and the name at full bleed. */
export function MarketingFooter() {
  return (
    <footer className="gutter relative isolate mt-auto flex flex-col gap-12 overflow-hidden border-t border-rule pt-16 pb-6">
      <Rings at={["100%", "30%"]} sizes={[640, 450, 260]} className="-z-10" />

      <div className="grid gap-8 border-b border-rule pb-12 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <p className="folio mb-6">End of the page. Start of the API.</p>
          <Link
            href="/login"
            className="group block w-fit text-[clamp(44px,8vw,132px)] leading-[0.95] font-bold tracking-[-0.055em]"
          >
            Have a code?
            <br />
            <TitleAside>Come in.</TitleAside>
            <span
              aria-hidden="true"
              className="ml-4 inline-block transition-transform duration-500 group-hover:translate-x-2 group-hover:-translate-y-2"
            >
              ↗
            </span>
          </Link>
        </div>
        <p className="max-w-[30ch] text-[17px] leading-relaxed text-mist">
          Turn a tab of your Google Sheet into a private REST API. Access is by invitation.
        </p>
      </div>

      <div className="flex flex-wrap justify-between gap-10">
        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <p className="folio folio-strong">{column.title}</p>
            <ul className="mt-2 grid">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={LINK}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
        <div>
          <p className="folio folio-strong">Contact</p>
          <a href={`mailto:${SUPPORT_EMAIL}`} className={`${LINK} mt-2`}>
            {SUPPORT_EMAIL}
          </a>
        </div>
        <a
          href="#main"
          aria-label="Back to top"
          className="group flex size-16 items-center justify-center self-start rounded-full border border-edge text-[22px] text-paper transition-colors duration-(--dur-fast) hover:bg-paper hover:text-ink"
        >
          <span aria-hidden="true" className="transition-transform duration-500 group-hover:-translate-y-1">
            ↑
          </span>
        </a>
      </div>

      <div aria-hidden="true" className="display text-[clamp(52px,14.6vw,300px)] leading-[0.82]! tracking-[-0.065em] whitespace-nowrap text-paper select-none">
        Sheet Zaber.
      </div>

      <div className="folio flex flex-wrap justify-between gap-3 text-[11px]!">
        <span>© {new Date().getFullYear()} Osayeed Zaber</span>
        <span>Private · Invitation only</span>
      </div>
    </footer>
  )
}
