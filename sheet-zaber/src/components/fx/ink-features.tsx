/** Adapted from InkOrbitFeatures (ink-orbit-saas-template), supplied by the project owner on 2026-11-05. Retargeted to Sheet Zaber's documented request lifecycle: the invented team portraits, presence dots and ticking report counter are gone, the wide flow now traces a real /api/v1 verb through the four per-request checks onto a response envelope, the integrations hub became those checks (architecture.md §3), the AI forecast chart became the rate-limit windows (backend-api-contract.md §1.4), every default cites docs/plan.md (D5/D8/D10/D11/D13), docs/architecture.md §3 and §6, docs/security.md §2 and §4 or docs/backend-api-contract.md §1; the theme prop and the template's light/dark palette are dropped for this app's Black Press tokens and its --dur and --ease-press variables, both timers now pause on user intent, and every diagram gained keyboard operation plus a DOM text equivalent. */
"use client"

import "./ink-features.css"

import React from "react"

import { cn } from "@/lib/cn"

/* ------------------------------------------------------------------- copy types */

export type InkFeatureCopy = { title: string; description: string }

/** One of the four per-request checks (docs/architecture.md §3, steps 2-4 and 6). */
export type InkFeatureGate = { name: string; detail: string }

/** The two documented default windows (docs/backend-api-contract.md §1.4). */
export type InkFeatureLimits = InkFeatureCopy & { perHour: number; perDay: number }

/** One operation of the public surface with the envelope it really returns (§1.1-§1.3). */
export type InkFeatureRoute = {
  verb: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  /** Path under `/api/v1`; `{pk}` is the API's designated primary-key value. */
  route: string
  /** The key scope the verb requires. */
  scope: "read" | "write"
  status: number
  /** The shape of `data` on success - field names only, never invented values. */
  outcome: string
  /** What this verb does, in one sentence of documented behaviour. */
  note: string
}

/** A short factual assurance for the ledger under the bento. */
export type InkFeatureGuarantee = { label: string; detail: string }

export type InkFeatures = {
  tag: string
  /** `*word*` sets a run in the muted tone; `\n` breaks the line. */
  title: string
  endpoints: InkFeatureCopy
  records: InkFeatureCopy
  checks: InkFeatureCopy & { gates: InkFeatureGate[] }
  limits: InkFeatureLimits
}

export type InkOrbitFeaturesProps = {
  /** On the hub chip in the flow diagram (first word, uppercased) and in the diagrams' names. */
  brand?: string
  tag?: string
  title?: string
  endpoints?: Partial<InkFeatureCopy>
  records?: Partial<InkFeatureCopy>
  checks?: Partial<InkFeatures["checks"]>
  limits?: Partial<InkFeatureLimits>
  /** Verbs traced in the flow diagram and read out beside it. */
  routes?: InkFeatureRoute[]
  /** The ledger under the bento; pass `[]` to leave it out. */
  guarantees?: InkFeatureGuarantee[]
  className?: string
  style?: React.CSSProperties
}

/* ------------------------------------------------------------------------ logic */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Smooth line + closed area through values, inside a w x h box. */
function chartPaths(
  values: number[],
  w: number,
  h: number,
  pad: number,
): { line: string; area: string; points: Array<[number, number]> } {
  const n = values.length
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const pts: Array<[number, number]> = values.map((v, i) => [
    pad + (n < 2 ? 0 : (i / (n - 1)) * (w - pad * 2)),
    h - pad - ((v - lo) / span) * (h - pad * 2),
  ])
  let line = ""
  pts.forEach(([x, y], i) => {
    if (i === 0) {
      line = "M" + x.toFixed(1) + "," + y.toFixed(1)
      return
    }
    const [px, py] = pts[i - 1]
    const cx = (px + x) / 2
    line +=
      " C" + cx.toFixed(1) + "," + py.toFixed(1) + " " + cx.toFixed(1) + "," + y.toFixed(1) + " " + x.toFixed(1) + "," + y.toFixed(1)
  })
  const area = n
    ? line + " L" + pts[n - 1][0].toFixed(1) + "," + (h - pad) + " L" + pts[0][0].toFixed(1) + "," + (h - pad) + " Z"
    : ""
  return { line, area, points: pts }
}

function nearestIndex(xs: number[], x: number): number {
  let best = 0
  for (let i = 1; i < xs.length; i++) {
    if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i
  }
  return best
}

/** "A sheet tab,\n*published as an API*" -> lines of { text, muted } runs. A literal backslash-n counts too. */
function parseTitle(s: string): Array<Array<{ text: string; muted: boolean }>> {
  return s.split(/\n|\\n/).map((line) => {
    const out: Array<{ text: string; muted: boolean }> = []
    line.split("*").forEach((text, i) => {
      if (text) out.push({ text, muted: i % 2 === 1 })
    })
    return out
  })
}

const numberFormat = new Intl.NumberFormat("en-US")
function formatInt(n: number): string {
  return numberFormat.format(Math.round(n))
}

/** Hue stays semantic: a throttle is warn, a server-side failure is danger, everything else is ink. */
function statusTone(status: number): string | undefined {
  if (status === 429) return "fill-warn"
  if (status >= 500) return "fill-danger"
  return undefined
}

/** Enter/Space activates, arrows and Home/End walk the stops, so both diagrams work without a pointer. */
function stepFromKey(key: string, index: number, count: number, select: (next: number) => void): void {
  switch (key) {
    case "Enter":
    case " ":
    case "Spacebar":
      select(index)
      break
    case "ArrowRight":
    case "ArrowDown":
      select((index + 1) % count)
      break
    case "ArrowLeft":
    case "ArrowUp":
      select((index - 1 + count) % count)
      break
    case "Home":
      select(0)
      break
    case "End":
      select(count - 1)
      break
    default:
      break
  }
}

/* -------------------------------------------------------------------- defaults */

const D_FEATURES: InkFeatures = {
  tag: "Capabilities",
  title: "A sheet tab,\n*published as an API*",
  endpoints: {
    title: "The whole verb set, one envelope",
    description:
      "List, read one, search, take an A1 range, append, merge, replace, delete - all over Authorization: Bearer sz_live_..., a key kept only as its SHA-256 hash and shown once, at creation.",
  },
  records: {
    title: "Rows have keys, not numbers",
    description:
      "PATCH, PUT and DELETE address a row through the primary-key column you designate per API, resolved at request time. A row number is never stored, and an API without a key is read-and-append only.",
  },
  checks: {
    title: "Four checks before Google",
    description:
      "Key-hash lookup, ownership and scope, the hour and day counters, then the primary-key resolution that finds the row. Fail one and your sheet is never read, the refusal comes back in the same error envelope, and the request is still logged.",
    gates: [
      {
        name: "key",
        detail:
          "Bearer sz_live_... is hashed and looked up by hash, because only the hash was ever stored. A missing, revoked or expired key is a 401.",
      },
      {
        name: "access",
        detail:
          "The key must be yours, its scope must cover the verb, any per-key API restriction must allow this endpoint, and the API must be enabled. A foreign key reads exactly like an API that does not exist.",
      },
      {
        name: "limits",
        detail:
          "Hour and day counters per key, overridable per API by the hour. Past the window comes a 429 with Retry-After.",
      },
      {
        name: "row",
        detail:
          "For PATCH, PUT and DELETE the key value is read out of its column and resolved to a row index right now: no match is 404, two matches are 409 ambiguous_record.",
      },
    ],
  },
  limits: {
    title: "Limits you can plan around",
    description:
      "1000 requests an hour and 10000 a day per key by default, with a per-API hourly override on top. A 429 carries Retry-After and the same error envelope as every other refusal.",
    perHour: 1000,
    perDay: 10000,
  },
}

/** Straight out of backend-api-contract.md §1.1-§1.3: verbs, required scope, the `data` each returns. */
const D_ROUTES: InkFeatureRoute[] = [
  {
    verb: "GET",
    route: "/{api}",
    scope: "read",
    status: 200,
    outcome: "[ ]",
    note: "List records: column=value filters, sort, limit/offset paging and a fields subset, applied to the tab server-side.",
  },
  {
    verb: "GET",
    route: "/{api}/{pk}",
    scope: "read",
    status: 200,
    outcome: "{ }",
    note: "One record, addressed by its primary-key value. The row index is found at request time and never travels back to you.",
  },
  {
    verb: "POST",
    route: "/{api}",
    scope: "write",
    status: 201,
    outcome: "{ created, records }",
    note: "Appends one object or up to 500 after the last non-empty row. A key your header row does not know is a 422 header_mismatch.",
  },
  {
    verb: "PATCH",
    route: "/{api}/{pk}",
    scope: "write",
    status: 200,
    outcome: "{ updated: 1 }",
    note: "Merges only the columns you send. Needs a designated primary key, and a unique one: zero rows is 404, more than one is 409.",
  },
  {
    verb: "DELETE",
    route: "/{api}/{pk}",
    scope: "write",
    status: 200,
    outcome: "{ deleted: 1 }",
    note: "Resolves the key, then deletes that single row. A body on a delete is rejected with 400 rather than guessed at.",
  },
]

/** plan.md D5/D8/D10/D11/D13 and security.md §2/§4 - the parts of the platform a diagram cannot draw. */
const D_GUARANTEES: InkFeatureGuarantee[] = [
  {
    label: "Invitation only",
    detail: "ZABER-XXXX-XXXX codes, stored hashed, with a use limit, an expiry and revocation.",
  },
  {
    label: "Sign-in",
    detail: "Google authorization-code + PKCE; identity comes from an ID token verified server-side.",
  },
  {
    label: "Sessions",
    detail: "HMAC-SHA-256 signed httpOnly cookie, re-checked against the user row on every request.",
  },
  {
    label: "Tokens at rest",
    detail: "Google refresh tokens sealed with AES-256-GCM, so a leaked database is not a credential.",
  },
  {
    label: "API keys",
    detail: "sz_live_ + 32 hex, kept only as a SHA-256 hash, shown once when you create them.",
  },
  {
    label: "Log retention",
    detail: "90 days by default, owner-configurable. No headers, no bodies, no keys in any log.",
  },
]

/* --------------------------------------------------------------------- geometry */

/** The wide diagram keeps the source's 640x178 stage and its cluster -> hub -> stack topology. */
const WIDE = {
  cluster: { x: 19, y: 26, w: 172, h: 114, cx: 104, cy: 70 },
  node: { x: 91, y: 57, size: 26 },
  hub: { x: 262, y: 88, w: 116, h: 44 },
  plate: { x: 450, y: 40, w: 138, h: 102, step: 12, lift: 10 },
  /** verb label anchors inside the cluster, in the source's scattered five-seat arrangement */
  slots: [
    { x: 48, y: 44 },
    { x: 160, y: 44 },
    { x: 44, y: 96 },
    { x: 152, y: 100 },
    { x: 100, y: 120 },
  ],
  /** engine -> hub and hub -> plate: the source's own curve pairs, solid line plus dashed partner */
  spine: [
    "M117,67 C196,67 210,100 262,100",
    "M117,73 C186,73 206,120 262,120",
    "M378,100 C412,100 418,86 450,86",
    "M378,120 C412,120 418,134 450,134",
  ],
} as const

/** Where a verb's hairline meets the label block, so the line never crosses the type. */
function slotAnchor(at: { x: number; y: number }): { x: number; y: number } {
  return { x: at.x, y: at.y < WIDE.cluster.cy ? at.y + 14 : at.y - 13 }
}

/** One continuous route, so a single packet can travel the whole request and vanish under the plate. */
function traceFor(at: { x: number; y: number }): string {
  const a = slotAnchor(at)
  return (
    `M${a.x},${a.y} L${WIDE.cluster.cx},${WIDE.cluster.cy} L117,67 ` +
    "C196,67 210,100 262,100 C412,100 418,86 450,86"
  )
}

/* ------------------------------------------------------------------- component */

export default function InkOrbitFeatures({
  brand = "Sheet Zaber",
  tag = D_FEATURES.tag,
  title = D_FEATURES.title,
  endpoints,
  records,
  checks,
  limits,
  routes = D_ROUTES,
  guarantees = D_GUARANTEES,
  className,
  style,
}: InkOrbitFeaturesProps) {
  const uid = "fxi" + React.useId().replace(/[^a-zA-Z0-9]/g, "")
  const F: InkFeatures = {
    tag,
    title,
    endpoints: { ...D_FEATURES.endpoints, ...endpoints },
    records: { ...D_FEATURES.records, ...records },
    checks: { ...D_FEATURES.checks, ...checks },
    limits: { ...D_FEATURES.limits, ...limits },
  }
  F.checks.gates = F.checks.gates?.length ? F.checks.gates : D_FEATURES.checks.gates
  const stops = routes.length > 0 ? routes : D_ROUTES

  const reduced = useReducedMotion()
  const [revealRef, revealed] = useInView<HTMLDivElement>(0.12)

  return (
    <div
      className={cn("fx-ink-hatch w-full bg-ink px-4 py-8 text-paper sm:px-7 md:px-10", className)}
      style={style}
    >
      <div className="mx-auto w-full max-w-[1180px]">
        <section
          aria-labelledby={`${uid}-head`}
          className="min-w-0 border border-rule bg-deep px-4 py-10 sm:px-8 md:px-12 md:py-16"
        >
          <div ref={revealRef} data-in={revealed} className="fx-ink-reveal">
            <header className="mb-10 flex flex-col items-center gap-3.5 text-center md:mb-14">
              {F.tag ? (
                <span className="rounded-field border border-rule bg-lift px-2.5 py-1 font-mono text-[11.5px] tracking-[0.02em] text-mist">
                  {F.tag}
                </span>
              ) : null}
              <Title id={`${uid}-head`} text={F.title} />
            </header>

            <div className="grid min-w-0 grid-cols-1 gap-6 md:grid-cols-2 md:gap-8">
              <FlowCard
                brand={brand}
                copy={F}
                uid={uid}
                reduced={reduced}
                inView={revealed}
                routes={stops}
                className="md:col-span-2"
              />
              <ChecksCard brand={brand} copy={F.checks} reduced={reduced} />
              <LimitsCard copy={F.limits} uid={uid} />
            </div>

            <Assurances items={guarantees} />
          </div>
        </section>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ hooks */

/** true once the element has been on screen */
function useInView<T extends HTMLElement>(
  threshold = 0.2,
): readonly [React.RefCallback<T>, boolean] {
  const [inView, setInView] = React.useState(false)
  // Attach observation to the DOM node's lifetime. Without an observer, reveal on attachment
  // instead of scheduling a state update from an effect; ref cleanup also covers Strict Mode.
  const ref = React.useCallback((el: T | null) => {
    if (!el || inView) return undefined
    if (typeof IntersectionObserver !== "function") {
      setInView(true)
      return undefined
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true)
          io.disconnect()
        }
      },
      { threshold },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [inView, threshold])
  return [ref, inView] as const
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"
/** What a server sees: no media queries to read, so it matches the first client paint's value. */
const noMediaQuery = () => false

/** The source read prefers-reduced-motion in an effect; it is now a subscription, so nothing is written during one. */
function useReducedMotion(): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    const motion = window.matchMedia(REDUCED_MOTION_QUERY)
    motion.addEventListener("change", onChange)
    return () => motion.removeEventListener("change", onChange)
  }, [])
  const getSnapshot = React.useCallback(
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    [],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, noMediaQuery)
}

/* ----------------------------------------------------------------------- pieces */

function Brackets() {
  return (
    <>
      <span aria-hidden="true" className="fx-ink-bracket fx-ink-bracket-tl" />
      <span aria-hidden="true" className="fx-ink-bracket fx-ink-bracket-tr" />
      <span aria-hidden="true" className="fx-ink-bracket fx-ink-bracket-bl" />
      <span aria-hidden="true" className="fx-ink-bracket fx-ink-bracket-br" />
    </>
  )
}

/** Hairline plate: corner brackets, a folio for the diagram, its text equivalent, then one or two copy slots. */
function Surface({
  folio,
  copy,
  className,
  children,
}: {
  folio: string
  copy: InkFeatureCopy[]
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("fx-ink-frame relative flex min-w-0 flex-col", className)}>
      <Brackets />
      <div className="flex min-w-0 flex-1 flex-col gap-3.5 rounded-card border border-rule bg-lift p-4 transition-[border-color,background-color] duration-(--dur-base) ease-(--ease-press) hover:border-edge hover:bg-raise sm:p-5">
        <span className="folio">{folio}</span>
        {children}
        {copy.length > 1 ? (
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            {copy.map((slot, i) => (
              <Copy key={i} slot={slot} />
            ))}
          </div>
        ) : (
          copy.map((slot, i) => <Copy key={i} slot={slot} />)
        )}
      </div>
    </div>
  )
}

function Copy({ slot }: { slot: InkFeatureCopy }) {
  return (
    <div className="min-w-0">
      <h3 className="text-[13.5px] font-semibold tracking-[-0.005em] text-paper">{slot.title}</h3>
      <p className="mt-1 max-w-[48ch] text-[12.5px] leading-[1.55] text-mist">{slot.description}</p>
    </div>
  )
}

function Title({ text, id }: { text: string; id: string }) {
  return (
    <h2
      id={id}
      className="font-sans text-[clamp(28px,4.6vw,46px)] font-medium leading-[1.05] tracking-[-0.03em] text-paper"
    >
      {parseTitle(text).map((line, i) => (
        <span key={i} className="block">
          {line.map((run, j) =>
            run.muted ? (
              <span key={j} className="text-dust">
                {run.text}
              </span>
            ) : (
              <React.Fragment key={j}>{run.text}</React.Fragment>
            ),
          )}
        </span>
      ))}
    </h2>
  )
}

/** The brand glyph. The source drew its own folded N; this is a sheet of rows with a route through it. */
function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="text-paper">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 3.5h16v17H4z" strokeWidth="1.6" />
        <path d="M4 9h16M4 14.5h16" strokeWidth="1.1" />
        <path d="M10.4 11.1l2.6 1.9-2.6 1.9" strokeWidth="1.7" />
      </g>
    </svg>
  )
}

/** The source's four stock tool marks, re-cut for the four checks: key, shield, clock, row cursor. */
function CheckGlyph({ index }: { index: number }) {
  return (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-paper"
      aria-hidden="true"
    >
      {index === 0 && (
        <>
          <circle cx="-2.4" cy="-2.4" r="3.4" />
          <path d="M0.1 0.1 5 5M2.6 2.6 4.4 0.8M4.3 4.3 6.1 2.5" />
        </>
      )}
      {index === 1 && (
        <>
          <path d="M0-6.2 5.4-4v3.4C5.4 1.6 3.2 4.4 0 6.2-3.2 4.4-5.4 1.6-5.4-.6V-4z" />
          <path d="M-2.4-.6-0.4 1.6 2.6-2.4" />
        </>
      )}
      {index === 2 && (
        <>
          <circle cx="0" cy="0" r="5.6" />
          <path d="M0-3.2V0l2.6 1.8" />
        </>
      )}
      {index === 3 && (
        <>
          <path d="M-6.5-2.5h13M-6.5 2.5h13" />
          <path d="M-1.8-6.2V6.2" strokeDasharray="2 2" opacity=".6" />
          <path d="M2.4-4.2 5.4 0 2.4 4.2" />
        </>
      )}
    </g>
  )
}

/* ------------------------------------------------- card 1: verbs -> checks -> envelope */

function FlowCard({
  brand,
  copy,
  uid,
  reduced,
  inView,
  routes,
  className,
}: {
  brand: string
  copy: InkFeatures
  uid: string
  reduced: boolean
  inView: boolean
  routes: InkFeatureRoute[]
  className?: string
}) {
  const count = routes.length
  const [active, setActive] = React.useState(0)
  const [nonce, setNonce] = React.useState(0)
  const [hover, setHover] = React.useState<number | null>(null)

  const index = clamp(active, 0, count - 1)
  const route = routes[index]
  const slot = WIDE.slots[index % WIDE.slots.length]
  const tipRoute = hover === null ? null : routes[clamp(hover, 0, count - 1)]
  const tipWidth = tipRoute ? Math.min(tipRoute.note.length * 4.05 + 16, 630) : 0
  const chip = brand.split(" ")[0].toUpperCase()
  const rays = `${uid}rays`
  const glow = `${uid}glow`
  const plateClip = `${uid}plate`

  const select = (next: number) => {
    setActive(clamp(next, 0, count - 1))
    setNonce((n) => n + 1)
  }

  // The one-shot reveal mounts the initial packet; only user selection changes its key.
  return (
    <Surface folio="the endpoint" className={className} copy={[copy.endpoints, copy.records]}>
      {/* 375px cannot hold a 640-wide stage legibly, so the diagram pans and the readout below repeats it */}
      <div className="-mx-1 overflow-x-auto px-1">
        <svg
          viewBox="0 0 640 178"
          role="group"
          aria-label={`${brand} request flow: pick a verb to trace it through the checks onto a response`}
          className="block h-auto w-full min-w-[560px]"
        >
        <defs>
          <radialGradient id={glow} cx="320" cy="110" r="190" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--raise)" stopOpacity="1" />
            <stop offset="1" stopColor="var(--raise)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={rays} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--edge)" stopOpacity=".55" />
            <stop offset="1" stopColor="var(--edge)" stopOpacity="0" />
          </linearGradient>
          <clipPath id={plateClip}>
            <rect width={WIDE.plate.w} height={WIDE.plate.h} rx="3" />
          </clipPath>
        </defs>

        {/* decorative ink: the hub's light behind the machinery */}
        <g aria-hidden="true">
          <rect x="0" y="0" width="640" height="178" fill={`url(#${glow})`} />
          {[-62, -38, -14, 14, 38, 62].map((a, i) => (
            <path
              key={i}
              d={
                `M320,110 L${(320 + Math.sin((a * Math.PI) / 180) * 260).toFixed(2)},${(110 - Math.cos((a * Math.PI) / 180) * 260).toFixed(2)} ` +
                `L${(320 + Math.sin(((a + 7) * Math.PI) / 180) * 260).toFixed(2)},${(110 - Math.cos(((a + 7) * Math.PI) / 180) * 260).toFixed(2)}Z`
              }
              fill={`url(#${rays})`}
              opacity=".5"
            />
          ))}
        </g>

        {/* the spine is drawn early so the hub and the plate cover it, as in the source */}
        <g aria-hidden="true">
          {WIDE.spine.map((d, i) => (
            <path key={d} d={d} className={cn("fx-ink-flow", i % 2 === 1 ? "fx-ink-hairline" : "fx-ink-flow-on")} />
          ))}
        </g>

        {/* the verb cluster */}
        <rect
          x={WIDE.cluster.x}
          y={WIDE.cluster.y}
          width={WIDE.cluster.w}
          height={WIDE.cluster.h}
          rx="8"
          className="fill-none stroke-rule"
          aria-hidden="true"
        />
        <g aria-hidden="true" className="font-mono">
          <text x={WIDE.cluster.cx} y="20" textAnchor="middle" fontSize="6.5" letterSpacing="1.8" className="fx-ink-label">
            {"YOUR ENDPOINT"}
          </text>
          <text x={WIDE.cluster.cx} y="152" textAnchor="middle" fontSize="6.5" letterSpacing="1.2" className="fx-ink-label">
            {"/api/v1/{api}"}
          </text>
        </g>

        {routes.map((r, i) => {
          const at = WIDE.slots[i % WIDE.slots.length]
          const a = slotAnchor(at)
          const on = i === index
          return (
            <g
              key={`${i}-${r.verb}${r.route}`}
              className="fx-ink-tap"
              tabIndex={0}
              role="button"
              aria-pressed={on}
              aria-label={`${r.verb} ${r.route}, ${r.scope} scope, ${r.status} with data ${r.outcome}. ${r.note}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => select(i)}
              onKeyDown={(e) => {
                stepFromKey(e.key, i, count, select)
              }}
            >
              <rect x={at.x - 30} y={at.y - 13} width="60" height="30" fill="transparent" />
              <line
                x1={a.x}
                y1={a.y}
                x2={WIDE.cluster.cx}
                y2={WIDE.cluster.cy}
                className={cn("fx-ink-hairline", on && "fx-ink-hairline-on")}
              />
              {on && (
                <rect
                  x={at.x - 30}
                  y={at.y - 11}
                  width="60"
                  height="26"
                  rx="4"
                  className="fx-ink-selected"
                  aria-hidden="true"
                />
              )}
              <text
                x={at.x}
                y={at.y}
                textAnchor="middle"
                fontSize="8.5"
                letterSpacing="1.1"
                className={cn("font-mono", on ? "fill-paper" : "fill-mist")}
              >
                {r.verb}
              </text>
              <text x={at.x} y={at.y + 10} textAnchor="middle" fontSize="6.2" className="fx-ink-label font-mono">
                {r.route.slice(1)}
              </text>
              <circle
                cx={at.x + 22}
                cy={at.y - 6}
                r="2.6"
                className={cn("fx-ink-scope", r.scope === "read" && "fx-ink-scope-read")}
                aria-hidden="true"
              />
            </g>
          )
        })}

        {/* the engine at the centre of the cluster */}
        <g transform={`translate(${WIDE.node.x},${WIDE.node.y})`} aria-hidden="true">
          <rect width={WIDE.node.size} height={WIDE.node.size} rx="5" className="fx-ink-node" />
          <g transform="translate(5,5)">
            <Mark size={16} />
          </g>
        </g>

        {/* the traced pass: one packet, once, per intent - never on a loop */}
        {inView && !reduced && (
          <circle key={`pkt-${nonce}`} r="2.4" className="fx-ink-packet" aria-hidden="true">
            <animateMotion dur="1.1s" begin="0s" fill="freeze" path={traceFor(slot)} />
            <animate attributeName="opacity" from="1" to="0" begin="0.9s" dur="200ms" fill="freeze" />
          </circle>
        )}

        {/* the hub chip */}
        <g transform={`translate(${WIDE.hub.x},${WIDE.hub.y})`} aria-hidden="true">
          <rect x="-4" y="-4" width={WIDE.hub.w + 8} height={WIDE.hub.h + 8} rx="8" className="fill-none stroke-rule" />
          <rect width={WIDE.hub.w} height={WIDE.hub.h} rx="6" className="fx-ink-node" />
          <g transform="translate(13,14)">
            <Mark size={16} />
          </g>
          <text x="36" y="26" fontSize="8.5" letterSpacing="1.4" fontWeight="600" className="fill-mist font-mono">
            {chip}
          </text>
          <path d="M100 18l4 4-4 4" fill="none" stroke="var(--dust)" strokeWidth="1.3" />
        </g>

        {/* the response envelope: a stack that prints one plate per selected verb */}
        {[2, 1, 0].map((k) => (
          <g
            key={k === 0 ? `plate-${nonce}` : k}
            transform={`translate(${WIDE.plate.x + k * WIDE.plate.step},${WIDE.plate.y - k * WIDE.plate.lift})`}
            opacity={1 - k * 0.25}
            aria-hidden="true"
          >
            <g className={cn("fx-ink-sheet", k === 0 && inView && "fx-ink-sheet-in")}>
              <rect width={WIDE.plate.w} height={WIDE.plate.h} rx="3" className="fx-ink-node" />
              {k === 0 && (
                <g clipPath={`url(#${plateClip})`}>
                  <g transform="translate(10,20)">
                    <text x="0" y="0" fontSize="7.5" className="fill-mist font-mono">
                      {`${route.verb} ${route.route}`}
                    </text>
                    <text
                      x={WIDE.plate.w - 20}
                      y="0"
                      textAnchor="end"
                      fontSize="7.5"
                      className={cn("font-mono", statusTone(route.status) ?? "fill-paper")}
                    >
                      {route.status}
                    </text>
                    <rect x="0" y="6" width={WIDE.plate.w - 20} height="1.2" className="fill-edge" />
                    <text x="0" y="18" fontSize="7.5" className="fill-paper font-mono">
                      {"data"}
                    </text>
                    <text x="14" y="18" fontSize="7" className="fill-paper font-mono">
                      {route.outcome}
                    </text>
                    <text x="0" y="30" fontSize="6.4" className="fx-ink-value font-mono">
                      {"{ data, meta }"}
                    </text>
                    <rect x="0" y="38" width={WIDE.plate.w - 20} height="1.2" className="fill-rule" />
                    <text x="0" y="50" fontSize="6.4" className="fx-ink-label font-mono">
                      {"meta"}
                    </text>
                    <text x="0" y="60" fontSize="6.4" className="fx-ink-value font-mono">
                      {"api_id count limit"}
                    </text>
                    <text x="0" y="70" fontSize="6.4" className="fx-ink-value font-mono">
                      {"offset duration_ms"}
                    </text>
                  </g>
                </g>
              )}
            </g>
          </g>
        ))}

        {/* hover/focus preview of the verb's note, ink-on-paper; the readout below is the text equivalent */}
        {tipRoute && (
          <g transform="translate(320,158)" aria-hidden="true" className="pointer-events-none">
            <rect x={-tipWidth / 2} y="0" width={tipWidth} height="15" rx="2" className="fx-ink-tip" />
            <text x="0" y="10" textAnchor="middle" fontSize="6.6" className="fx-ink-tip-text font-mono">
              {tipRoute.note}
            </text>
          </g>
        )}
        </svg>
      </div>

      <div className="min-w-0 rounded-field border border-rule bg-ink px-3 py-2.5">
        <p className="font-mono text-[11.5px] leading-[1.5] text-paper num">
          {`${route.verb} ${route.route} · ${route.scope} scope · ${route.status} · data ${route.outcome}`}
        </p>
        <p className="mt-1 text-[12px] leading-[1.55] text-mist">{route.note}</p>
        <p className="folio mt-2">{"filled dot = write scope · click, Enter or arrow-key a verb"}</p>
      </div>
    </Surface>
  )
}

/* --------------------------------------------- card 2: the four per-request checks */

function ChecksCard({ copy, brand, reduced }: { copy: InkFeatures["checks"]; brand: string; reduced: boolean }) {
  const [hover, setHover] = React.useState(-1)
  const [auto, setAuto] = React.useState(0)
  const gates = copy.gates
  const count = gates.length

  // the source cycled with no user intent; this one steps the documented order, pauses on hover/focus and
  // rests on the completed state under reduced motion
  React.useEffect(() => {
    if (reduced || hover >= 0 || count < 2) return undefined
    const t = window.setInterval(() => setAuto((a) => (a + 1) % count), 3600)
    return () => window.clearInterval(t)
  }, [reduced, hover, count])

  const on = reduced ? -1 : hover >= 0 ? hover : auto
  const shown = on >= 0 ? on : count - 1
  const tiles = [
    { x: 66, y: 34 },
    { x: 234, y: 34 },
    { x: 66, y: 116 },
    { x: 234, y: 116 },
  ]
  const path = (i: number): string => {
    const t = tiles[i % tiles.length]
    const dir = t.x < 150 ? -1 : 1
    return `M${150 + dir * 17},75 H${150 + dir * 42} V${t.y} H${t.x - dir * 15}`
  }

  return (
    <Surface folio="every request" copy={[copy]}>
      <svg
        viewBox="0 0 300 150"
        role="group"
        aria-label={`${brand} runs four checks on every request, in order`}
        className="block h-auto w-full"
      >
        {tiles.map((_, i) => (
          <path
            key={i}
            d={path(i)}
            aria-hidden="true"
            className={cn("fx-ink-flow", on === i && "fx-ink-flow-on fx-ink-flow-live", reduced && "fx-ink-flow-on")}
          />
        ))}
        {!reduced && on >= 0 && on < count && (
          <circle key={on} r="2.2" className="fx-ink-packet" aria-hidden="true">
            <animateMotion dur="1.2s" repeatCount="indefinite" path={path(on)} />
          </circle>
        )}

        <g transform="translate(133,58)" aria-hidden="true">
          <rect width="34" height="34" rx="7" className="fx-ink-node" />
          <g transform="translate(8,8)">
            <Mark size={18} />
          </g>
        </g>

        {tiles.map((t, i) => {
          const gate = gates[i % gates.length]
          const lit = on === i || reduced
          return (
            <g
              key={gate.name}
              className="fx-ink-tap"
              tabIndex={0}
              role="button"
              aria-pressed={on === i}
              aria-label={`Check ${i + 1} of ${count}: ${gate.name}. ${gate.detail}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(-1)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(-1)}
              onClick={() => setHover(i)}
              onKeyDown={(e) => {
                stepFromKey(e.key, i, count, setHover)
              }}
            >
              <rect
                x={t.x - 15}
                y={t.y - 15}
                width="30"
                height="30"
                rx="6"
                className={cn("fx-ink-node", lit && "fx-ink-node-on")}
              />
              <g transform={`translate(${t.x},${t.y})`}>
                <CheckGlyph index={i % 4} />
              </g>
              <text
                x={t.x}
                y={t.y + (t.y < 75 ? -21 : 28)}
                textAnchor="middle"
                fontSize="8"
                letterSpacing="0.6"
                className={cn("font-mono", lit ? "fill-paper" : "fill-dust")}
              >
                {gate.name}
              </text>
              <text x={t.x - 15} y={t.y - 17} fontSize="6.5" className="fx-ink-label font-mono" aria-hidden="true">
                {`${i + 1}`}
              </text>
            </g>
          )
        })}

        <text x="150" y="112" textAnchor="middle" fontSize="7" className="fx-ink-label font-mono">
          {on >= 0 ? `checking · ${gates[on % gates.length].name}` : "all four · in order"}
        </text>
      </svg>

      <div className="mt-auto min-w-0">
        <p className="font-mono text-[11.5px] leading-[1.5] text-paper num" aria-hidden="true">
          {`check ${shown + 1} of ${count} · ${gates[shown % count].name}`}
        </p>
        <p className="mt-1 text-[12px] leading-[1.55] text-mist" aria-hidden="true">
          {gates[shown % count].detail}
        </p>
      </div>
    </Surface>
  )
}

/* ------------------------------------------------- card 3: the two default windows */

function LimitsCard({ copy, uid }: { copy: InkFeatureLimits; uid: string }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.3)
  const [scrub, setScrub] = React.useState(-1)
  const W = 300
  const H = 130
  const pad = 14
  const STEPS = 12
  // a steady-rate model of the two documented windows (§1.4) - never a claim about anyone's traffic
  const values = React.useMemo(
    () => Array.from({ length: STEPS + 1 }, (_, i) => (copy.perHour / STEPS) * i),
    [copy.perHour, STEPS],
  )
  const { line, area, points } = chartPaths(values, W, H, pad)
  const xs = points.map((p) => p[0])
  const last = values.length - 1
  const index = clamp(scrub >= 0 ? scrub : last, 0, last)
  const p = points[index]
  const minutes = Math.round((index / last) * 60)
  const counted = (copy.perHour / 60) * minutes
  const atCap = counted >= copy.perHour
  const fill = `${uid}area`
  const hoursToDayCap = copy.perHour > 0 ? copy.perDay / copy.perHour : 0
  const dayShare = clamp((hoursToDayCap / 24) * 100, 0, 100)

  const select = (next: number) => setScrub(clamp(next, 0, last))
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType !== "mouse" && e.buttons === 0) return
    const box = e.currentTarget.getBoundingClientRect()
    setScrub(nearestIndex(xs, ((e.clientX - box.left) / box.width) * W))
  }

  return (
    <Surface folio="rate limits" copy={[copy]}>
      <div ref={ref} data-in={inView} className="min-w-0">
        <svg
          viewBox={`0 0 ${W} ${H + 6}`}
          role="slider"
          tabIndex={0}
          aria-label={`${copy.title}: a steady rate against the ${formatInt(copy.perHour)}-per-hour window. Scrub with the arrow keys.`}
          aria-valuemin={0}
          aria-valuemax={60}
          aria-valuenow={minutes}
          aria-valuetext={`${minutes} minutes into the hour window: about ${formatInt(counted)} of ${formatInt(copy.perHour)} counted${atCap ? "; the next request is a 429 with Retry-After" : ""}`}
          onPointerDown={onMove}
          onPointerMove={onMove}
          onPointerLeave={() => setScrub(-1)}
          onKeyDown={(e) => {
            switch (e.key) {
              case "ArrowRight":
              case "ArrowUp":
                e.preventDefault()
                select(index + 1)
                break
              case "ArrowLeft":
              case "ArrowDown":
                e.preventDefault()
                select(index - 1)
                break
              case "PageUp":
                e.preventDefault()
                select(index + 3)
                break
              case "PageDown":
                e.preventDefault()
                select(index - 3)
                break
              case "Home":
                e.preventDefault()
                select(0)
                break
              case "End":
                e.preventDefault()
                select(last)
                break
              default:
                break
            }
          }}
          className="block h-auto w-full cursor-crosshair touch-pan-y"
        >
          <defs>
            <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--paper)" stopOpacity=".12" />
              <stop offset="1" stopColor="var(--paper)" stopOpacity="0" />
            </linearGradient>
          </defs>

          <g aria-hidden="true" className="font-mono">
            {[0.25, 0.5, 0.75].map((g) => (
              <line key={g} x1={pad} x2={W - pad} y1={H * g} y2={H * g} className="stroke-rule" />
            ))}
            {/* the cap is the top of the box: one hairline, with the 429 on it */}
            <line x1={pad} x2={W - pad} y1={pad} y2={pad} className="fx-ink-hairline-warn" />
            <text x={pad} y={pad - 4} fontSize="6.5" className="fill-warn">
              {`${formatInt(copy.perHour)} · past this, 429 + Retry-After`}
            </text>
            <text x={pad} y={H - 1} fontSize="6.5" className="fx-ink-label">
              {"0 min"}
            </text>
            <text x={W / 2} y={H - 1} textAnchor="middle" fontSize="6.5" className="fx-ink-label">
              {"30"}
            </text>
            <text x={W - pad} y={H - 1} textAnchor="end" fontSize="6.5" className="fx-ink-label">
              {"60 min"}
            </text>
          </g>

          <g aria-hidden="true" className="font-mono">
            <path d={area} fill={`url(#${fill})`} />
            <path d={line} pathLength={1} className="fx-ink-line fx-ink-draw" />
            {/* the source's dashed FORECAST split is now the far end of the window */}
            <line x1={points[last][0]} x2={points[last][0]} y1="10" y2={H - pad} className="fx-ink-hairline" />
            <text x={points[last][0] - 4} y={H - 20} textAnchor="end" fontSize="6.5" className="fx-ink-label">
              {"WINDOW ENDS"}
            </text>
          </g>

          <circle cx={p[0]} cy={p[1]} r="3.2" className="fx-ink-marker" aria-hidden="true" />
          {scrub >= 0 && (
            <g aria-hidden="true">
              <line x1={p[0]} x2={p[0]} y1="8" y2={H - pad} className="fx-ink-cursor" />
              <g transform={`translate(${clamp(p[0], 48, W - 48)},${p[1] < 34 ? p[1] + 24 : p[1] - 12})`}>
                <rect x="-44" y="-11" width="88" height="15" rx="2" className="fx-ink-tip" />
                <text x="0" y="-1" textAnchor="middle" fontSize="7" className="fx-ink-tip-text font-mono num">
                  {`min ${minutes} · ${formatInt(counted)}/${formatInt(copy.perHour)}`}
                </text>
              </g>
            </g>
          )}
        </svg>
      </div>

      {/* the second window, same model: the hourly cap alone fills the daily one in N hours */}
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <span className="folio">{`day window ${formatInt(copy.perDay)}`}</span>
          <span className={cn("font-mono text-[11.5px] num", atCap ? "text-warn" : "text-mist")}>
            {`min ${minutes} · ${formatInt(counted)} counted`}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-field border border-rule bg-ink" aria-hidden="true">
          <div className="h-full bg-paper" style={{ width: `${dayShare}%` }} />
        </div>
        <p className="mt-1.5 font-mono text-[10.5px] leading-[1.5] text-dust">
          {`A steady ${formatInt(copy.perHour)} an hour reaches the ${formatInt(copy.perDay)}-a-day window in ${formatInt(hoursToDayCap)} of 24 hours. That is the documented default, not a customer's traffic.`}
        </p>
      </div>
    </Surface>
  )
}

/* --------------------------------------------------------------------- the ledger */

function Assurances({ items }: { items: InkFeatureGuarantee[] }) {
  if (items.length === 0) return null
  return (
    <ul className="mt-8 grid min-w-0 grid-cols-1 gap-px overflow-hidden rounded-panel border border-rule bg-rule sm:grid-cols-2 md:mt-12 lg:grid-cols-3">
      {items.map((g) => (
        <li key={g.label} className="min-w-0 bg-deep px-4 py-3.5">
          <span className="folio">{g.label}</span>
          <p className="mt-1.5 text-[12.5px] leading-[1.55] text-mist">{g.detail}</p>
        </li>
      ))}
    </ul>
  )
}

export { InkOrbitFeatures }
