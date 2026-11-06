# Sheet Zaber — Design system: **Black Press**

> Contract, not commentary. If you are about to style a page, a component or a chart in
> `src/`, this file decides the design rules. Implementation citations are `path:line`;
> line numbers are navigation hints and may shift in this shared tree. Verify the named symbol.
> **DECISION** marks intentional policy; provenance claims from source headers are not an
> independent upstream comparison. Known gaps and unverified runtime claims are in §9–10.
>
> Stack this system sits on: Next.js 16.4.3 App Router, React 19, TypeScript strict,
> Tailwind v4 CSS-first via `@tailwindcss/turbopack` (`@tailwindcss/turbopack` in
> `package.json`), pnpm. Product: private, invitation-only Google Sheets REST API platform at
> `https://sheet.zaber.tech`.

---

## 0. Source of truth

| Concern | File |
|---|---|
| Every token, every base rule, every component utility class | `src/app/globals.css` |
| Font loading and the `--font-*` variables the tokens bind to | `src/app/layout.tsx:1-26` |
| Class-name joining (the only styling utility) | `src/lib/cn.ts` |
| Primitive UI kit | `src/components/ui/*` |
| Chart kit | `src/components/charts/*` |
| Vendored animation catalogue | `src/components/fx/*` |
| Display formatters the type system depends on | `src/lib/format.ts` |

There is no `tailwind.config.*`. In Tailwind v4 the `@theme inline` block at
`src/app/globals.css:54-82` registers the custom theme utilities, including `shadow-raised`.
A custom property declared solely in `:root` creates no named utility by itself; explicit
classes such as `.pad-page` in `@layer utilities` and arbitrary-value utilities can also read it.

---

## 1. The one rule that outranks all others

**DECISION (monochrome override).** The system is full monochrome. Hue is reserved
exclusively for semantic failure states and for nothing else:

- `warn` (`#fbbf24`) = an elevated error rate / a degraded-but-not-broken condition.
- `danger` (`#f87171`) = failed, disabled, revoked, or 5xx.

Inversion — press white on ink black — **is** the accent. There is no brand colour. `globals.css:6-11`
states the rule at the token block; the component kit implements it literally: status is carried
by *wording plus shape* (`badge.tsx:3-6`), method badges stay monochrome because "the verb is
carried by the word" (`badge.tsx:81-84`), the spinner is a hairline ring rather than a coloured
arc (`button.tsx:87`), and charts differentiate series by stroke weight, dash and texture
(`charts.css:94`, `series.ts:18-22`).

This override **supersedes decision D14** in `docs/plan.md:81`, which recorded an earlier
identity (Space Grotesk + `motion` + functional green/red/amber). The owner explicitly demanded
full monochrome after D14 was written. `docs/plan.md` still shows the old text — that is
documentation drift, listed in §9; this file wins.

Practical consequences:

1. Never introduce a third chromatic token. "It reads better in blue" is not a use case.
2. Never use `warn`/`danger` for decoration, ranking, category, or "success". Success is
   `paper`/`press` inversion (`badge.tsx:41-42`).
3. If a state can only be seen by colour, it is broken. Pair colour with a word (§7.1).

---

## 2. Typography

### 2.1 Loaded faces

`src/app/layout.tsx` binds three Google fonts to CSS variables on `<html>`:

| Font | Variable | Loaded axes/weights | Bound to |
|---|---|---|---|
| Bricolage Grotesque | `--font-bricolage` | `axes: ["wdth"]` (`layout.tsx:6-11`) | `--font-sans`, `--font-heading` (`globals.css:68,71`) |
| Instrument Serif | `--font-instrument` | weight 400, **italic only** (`layout.tsx:13-19`) | `--font-serif` (`globals.css:69`) |
| JetBrains Mono | `--font-jetbrains` | 400, 500 only (`layout.tsx:21-26`) | `--font-mono` (`globals.css:70`) |

### 2.2 Voice rules

- **Bricolage (`font-sans`, the default)** — all UI text, all display headings. `<html>` applies
  `font-sans` (`globals.css:82`), so anything that says nothing says Bricolage.
- **Instrument Serif** — prose and editorial asides only, and **only via `.aside`**. The face is
  loaded italic-only. `font-serif` sets the family, not the style; font matching may select the
  loaded italic face even for an upright request. Use `.aside` (`globals.css:156-161`) to make
  the intended italic style explicit; bare `font-serif` has no consumers at this audit.
- **JetBrains Mono** — identifiers, codes, counts, tabular readouts, labels. Nothing narrative.
- `body` sets `font-feature-settings: "ss01", "ss02"` (`globals.css:93`); do not re-set features
  per component.
- Headings get `text-wrap: balance`, paragraphs `text-wrap: pretty` globally
  (`globals.css:106-115`). Do not add these again.

### 2.3 Figures are a rule, not an accident

`.num` (`globals.css:160-162`) applies `font-variant-numeric: tabular-nums`. Any number that can
change width — counts, latency, ids, page numbers — takes `.num`. The chart kit hard-codes the
same property into every numeric class (`charts.css:59, 71, 326, 368, 425, 474, 594, 677, 781, 853, 889, 945`)
so a chart cannot render a non-tabular figure even if the caller forgets.

Formatting is centralised in `src/lib/format.ts` — one number style, one date style
(`en-GB`, padded days, `05 Nov, 14:32` at `format.ts:31-50`), one unit style (`143 ms` / `1.2 s`
at `format.ts:18-22`). Nullable formatters return `—`; `formatNumber` requires a number, so
callers must guard missing values. Charts accept numeric readings and formatter callbacks:
they compute geometry, totals, shares and headroom from those readings. `KpiTile` display
strings are pre-formatted (`series.ts:66-88`); no chart invents measured data.

---

## 3. Tokens

### 3.1 The ink→press scale

Declared `globals.css:14-23`, mapped to utilities `globals.css:55-66`.

| Token | Value | Tailwind classes (`bg-`/`text-`/`border-`/`fill-`/`stroke-`) | Permitted use | Never |
|---|---|---|---|---|
| `--ink` | `#000000` | `ink` | Page ground (`globals.css:85,90`), the type colour on an inverted field, disabled field background (`globals.css:228`), plot ground (`charts.css:126`) | Body text on dark surfaces |
| `--deep` | `#050505` | `deep` | `.panel` fill (`globals.css:234`), dialog surface (`dialog.tsx:50`), chart figure fill (`charts.css:26`) | — |
| `--lift` | `#0a0a0a` | `lift` | Input/field fill (`globals.css:209`), code plates (`globals.css:293, 307`), tile fill (`charts.css:812`), hover row wash (`panel.tsx:127`, `table.tsx:76`) | Page background |
| `--raise` | `#101010` | `raise` | The second hover step, for surfaces already on `lift` (`account-menu.tsx:64`, `ink-features.tsx:468`), diagram node fill (`ink-features.css:106`) | — |
| `--rule` | `#1f1f1f` | `rule` | **The hairline.** Every structural border: `.panel`, `Row`, `Th`, `Tr`, chart figure, code plate (`globals.css:232, 238`; `panel.tsx:126`; `table.tsx:53, 74`; `charts.css:24`) | Anything that must be seen as a control edge — that is `edge` |
| `--edge` | `#3a3a3a` | `edge` | Control-grade borders (fields, pills, chips), scrollbars (`globals.css:125`), gauge/axis strokes (`charts.css:159, 179`) | Long structural rules — that is `rule` |
| `--dust` | `#8a8a8a` | `dust` | `.folio` label colour (`globals.css:139`), secondary meta, captions, hints, ghost buttons (`globals.css:139`; `panel.tsx:159`; `field.tsx:43`; `button.tsx:16`) | Body copy — contrast target is `mist` |
| `--mist` | `#bdbdbd` | `mist` | Body copy on dark (`table.tsx:99`, `state.tsx:75`), `StatusDot` label (`badge.tsx:32`), legend text (`charts.css:101`) | Primary emphasis |
| `--paper` | `#f2f2f2` | `paper` | The inversion colour: solid pills, selected states, focus ring, selection, primary type on ink (`globals.css:97, 102, 181, 193, 220`; `badge.tsx:11, 42`; `nav.tsx:70`) | Large fills of reading areas |
| `--press` | `#ffffff` | `press` | The single step above `paper`: solid-pill hover (`globals.css:185`), active nav hover (`nav.tsx:70`), scrub line (`charts.css:294`), latest-column ring (`charts.css:573`), the vendored shine colour (`shiny-text.tsx:130`) | Default text colour — `paper` is text |
| `--warn` | `#fbbf24` | `warn` | **Semantic.** Elevated error rate: `attention` dot (`badge.tsx:15`), `Banner tone="attention"` (`state.tsx:99`), `elevated` chart tone (`charts.css:263-274`), throttle (`ink-features.css:141-143`) | Decoration, success, "warning about the user's input" |
| `--danger` | `#f87171` | `danger` | **Semantic.** Failed / disabled / 5xx: `failed` dot (`badge.tsx:17`), `DELETE` + 5xx (`badge.tsx:91, 108`), `.pill-danger` (`globals.css:197-203`), invalid field (`globals.css:223`), `failed` chart tone (`charts.css:276-286`) | Any state that is merely "not yet" |

Ladder discipline: surfaces step `ink → deep → lift → raise`; lines step `rule → edge`; text
steps `dust → mist → paper → press`. Two adjacent surfaces never use the same step — that is
how hierarchy is read without colour.

### 3.2 Spacing / rhythm (`globals.css:27-29`, utilities `globals.css:315-325`)

| Token | Value | Utility | Use |
|---|---|---|---|
| `--gutter` | `clamp(16px, 5vw, 64px)` | `.gutter` | Declared. **No consumer** — §3.12 |
| `--pad-page` | `clamp(16px, 4vw, 40px)` | `.pad-page` | The horizontal inset of every page container; used throughout marketing, `legal-doc.tsx:39`, `not-found.tsx:58` |
| `--section-y` | `clamp(96px, 10vw, 160px)` | `.section-y` | Declared. **No consumer**; landing sections hand-roll `py-[clamp(...)]` instead — §9 |

Component padding is fixed, not tokenised: `px-5 py-4` for headers/rows, `px-5 py-5` for panel
bodies (`panel.tsx:29, 43, 92, 126`; `dialog.tsx:54, 66`). Use these numbers or the kit.

### 3.3 Motion (`globals.css:31-34`, mapped `globals.css:77`)

| Token | Value | Notes |
|---|---|---|
| `--dur-fast` | `180ms` | Colour/hover transitions. House spelling is `duration-(--dur-fast)` (`button.tsx:16`, `table.tsx:76`, `nav.tsx:69`) — the parens form reads the variable, because no `--animate-*` slot is registered |
| `--dur-base` | `420ms` | Entrances and the `.reveal` animation (`globals.css:281`), sparkline draw (`charts.css:917`), progress-ring thumb transition (`progress-ring.css:21`) |
| `--dur-slow` | `900ms` | Chart band draw-in (`charts.css:242`), column rise (`charts.css:568`), dot-pulse cycle (`pattern.css:19`), and the ShinyText sweep, which reads the token at runtime (`shiny-text.tsx:205-211`) |
| `--ease-press` | `cubic-bezier(0.16, 1, 0.3, 1)` | The only easing. Available as `ease-press` via `@theme` and as `ease-(--ease-press)` (`ink-features.tsx:468`). ShinyText samples the same curve in JS (`shiny-text.tsx:81`) |

Motion budget: one-shot, opacity/transform/stroke-dashoffset only, `backwards` fill so the rest
state is what the data declares (`charts.css:1010-1015`). Nothing loops except the marquee, the
marching dash on the one active route (`ink-features.css:127-130`) and opt-in grain. Never
animate `width`, `background-position` or `filter` in a new component.

### 3.4 Radii (`globals.css:36-38`, mapped `globals.css:73-75`)

| Token | Value | Class | Use |
|---|---|---|---|
| `--r-field` | `10px` | `rounded-field` | Inputs and selects (`.field`, `globals.css:207`), tab chips (`snippet-tabs.tsx:58`), small plates (`ink-features.tsx:365, 841`) |
| `--r-panel` | `12px` | `rounded-panel` | `.panel` (`globals.css:233`), empty/error states (`state.tsx:38, 70`), plot frame (`charts.css:124`), list plates (`landing-section.tsx:42`) |
| `--r-card` | `14px` | `rounded-card` | Dialog (`dialog.tsx:50`), tiles (`charts.css:810`), nested feature card (`ink-features.tsx:468`) |
| `999px` | — | `rounded-full` | Pills, dots, chips, capsules. This is the only other radius in the system |

`4px` appears literally for `.kbd` and `code.inline` (`globals.css:266, 306`) and `.skeleton`
(`globals.css:277`) — small inline elements; not a general allowance.

### 3.5 Elevation

`--shadow-raised: 0 12px 32px rgb(0 0 0 / 0.6), 0 0 0 1px var(--edge)` (`globals.css:40`) is the
only elevation in the system: one floating layer (menus/dialogs) whose 1px ring guarantees an
edge on a pure-black ground. **It is not mapped into `@theme`, so no `shadow-raised` utility
exists — see §9, item 1.** Everything else is flat and separated by hairlines.

### 3.6 shadcn interop layer (`globals.css:42-51`)

`--background: --ink`, `--foreground: --paper`, `--card: --lift`, `--muted: --dust`,
`--border: --rule`, `--destructive: --paper`, `--primary: --paper`,
`--primary-foreground: --ink`, `--radius: 0.75rem`.

Purpose, per the comment: "Neutral registry slots so any shadcn-flavoured block stays on
palette." Note the deliberately surprising mappings: `--destructive` is **paper, not red** (a
destructive *surface* is an inverted surface; red is reserved for the failed state), and
`--muted` is a text colour, not a background.

These are declared in `:root` only, never in `@theme`, so `bg-background` / `text-foreground` /
`bg-card` etc. do **not** exist as classes, and the whole block currently has **zero consumers**
(§3.12). It is a safety net for pasted shadcn markup, not a vocabulary to write new code in.
Write the real token (`bg-lift`, `text-dust`) instead.

### 3.7 `@theme inline` — how classes come to exist

`globals.css:54-78` maps, with `inline` so the utilities resolve the live `:root` value and
therefore track `.dark`: `--color-*` for all twelve colours → `bg-*`/`text-*`/`border-*`/
`fill-*`/`stroke-*`; `--font-sans|serif|mono|heading` → `font-*`; `--radius-field|panel|card` →
`rounded-*`; `--ease-press` → `ease-press`.

Anything you need as a utility must be added here. The `cn` helper is a plain joiner
(`cn.ts:2-4`, no `tailwind-merge`) — its doc comment carries the override rule: *"Utilities win
over component classes, so overrides need no `!`"*, which holds because Tailwind emits
`@layer components` before `@layer utilities`. Corollary: `cn()` does **not** de-duplicate two
conflicting utilities; the stylesheet order decides, not argument order. Never write
`cn("text-mist", "text-paper")` and expect the last one to win — pick one.

### 3.8 Base element treatments (`globals.css:80-129`)

| Rule | Value | Why it matters |
|---|---|---|
| `color-scheme: dark`, `background: var(--ink)` on `html` and `body` | `globals.css:84-92` | The app is dark-only; `@custom-variant dark (&:is(.dark *))` (`globals.css:4`) keys `dark:` off `.dark` on `<html>`, which the root layout always sets (`layout.tsx:48`). Do not build a light mode |
| `overflow-x: clip` on `html` and `body` | `globals.css:83, 90` | Lets full-bleed FX (patterns, marquee, stream overhang) bleed without creating a horizontal scrollbar. Prefer `clip` over `hidden` — `hidden` makes the page a scroll container and breaks `position: sticky` |
| `::selection` = paper on ink | `globals.css:96-99` | Inversion is the accent, even for selection |
| `:focus-visible` = 2px `paper` outline, offset 3px | `globals.css:101-104` | The single focus treatment. Never `outline-none` without replacing it (`.field:focus-visible` does swap to a border colour, `globals.css:219-222`, and is paired with the label) |
| Scrollbar | `globals.css:117-128` | Track `ink`, thumb `edge` as a 999px pill with a 3px ink border — the scroll UI obeys the same ladder |
| `dialog::backdrop` = `rgb(0 0 0 / 0.8)` | `globals.css:285-287` | Kept in CSS because `::backdrop` is not a Tailwind target — the reason the dialog is a native `<dialog>` (§4.5) |

### 3.9 Component utility classes

All in `@layer components` (`globals.css:131-313`). These are vocabulary; using them is the
default, re-implementing them is drift.

| Class | Definition | Use it for | Do not use it for |
|---|---|---|---|
| `.folio` | mono, 12px, 0.14em tracking, uppercase, `dust` (`globals.css:133-140`) | "The loudest rule in the system" — the label *above* data: page index, metric caption, table header, chip label | Inline prose, or anything that is not a label |
| `.folio-strong` | same, `paper` (`globals.css:142-144`) | A folio that is the thing itself, e.g. `Sheet Zaber` in the mobile drawer (`mobile-nav.tsx:37`), an inline emphasised label in a note (`analytics/page.tsx:316`) | Bulk text |
| `.display` | weight 800, −0.05em, line-height 0.86 (`globals.css:146-150`) | Big type. Always combined with an explicit `text-[clamp(...)]` size (`login/page.tsx:76`, `landing-section.tsx:26`, `(marketing)/page.tsx:220`) | Body headings under ~28px — use `font-semibold tracking-[-0.02em]` (`panel.tsx:34`) |
| `.aside` | Instrument Serif italic 400, tracking reset (`globals.css:152-157`) | Editorial voice, one per page max (`(marketing)/page.tsx:236`) | Data, UI labels, or upright serif (face is italic-only) |
| `.num` | tabular figures (`globals.css:160-162`) | Every changeable-width number | Nothing is exempt |
| `.pill` | inline-flex, centred, gap 0.5rem, **min-height 44px**, 0/1.25rem pad, 999px, weight 600, nowrap, fast `--ease-press` colour transitions (`globals.css:164-178`) | The base of every button and pill link. Reach for `Button`/`PillLink` instead of the class | Layout containers, tags (tags use `Badge`) |
| `.pill-solid` | paper field, ink type; hover `press` (`globals.css:180-186`) | `Button variant="solid"` — one per view | Multiple competing solids |
| `.pill-line` | `edge` border, `paper` text; hover border → `paper` (`globals.css:188-194`) | The default control (`variant="line"`) | Destructive actions |
| `.pill-danger` | `edge` border, `danger` text; hover border → `danger` (`globals.css:197-203`) | "The control for something that destroys data: hairline, honest wording." `variant="danger"` | Anything recoverable |
| `.field` | 100% width, `r-field`, `edge` border, `lift` fill, 0.75/0.875rem pad, **16px text**, `paper`, border-only focus, `[aria-invalid]` → `danger`, `:disabled` → `dust` on `ink` (`globals.css:205-229`) | Every text input, textarea and select, via `TextField`/`TextArea`/`SelectField`/`CopyField` | Raw `<input>` you style yourself |
| `.panel` | `rule` border, `r-panel`, `deep` fill (`globals.css:231-235`) | The container. Compose `Panel`/`PanelHeader`/`PanelBody` | A card with its own shadow — there are no shadows here |
| `.hairline-top` | 1px `rule` above (`globals.css:237-239`) | The separator under a footer or above a list of links (`marketing-footer.tsx:76`, `legal-doc.tsx:45`, `not-found.tsx:89`) | `border-t border-rule` written longhand |
| `.skip-link` | fixed, translated off-screen, revealed on `:focus-visible` (`globals.css:241-256`) | `#main` jump link, present in all three layouts and `not-found` (`(app)/layout.tsx:26`, `(marketing)/layout.tsx:15`, `not-found.tsx:51`) | Optional — every new route group needs one |
| `.kbd` | 22px mono chip, `rule` border, `lift` fill, `mist` (`globals.css:258-271`) | Keys and literal header fragments (`key-reveal.tsx:63`) | Values that change |
| `.skeleton` | `lift→#141414→lift` sweep, 1.4s, 4px (`globals.css:273-278`) | Loading shapes, via `Skeleton`/`SkeletonRows`/`Metric loading` | A spinner in place of a layout |
| `.reveal` | `reveal-up` at `--dur-base` (`globals.css:280-282`, keyframe 336-345) | One-shot entrance of hero content (`not-found.tsx:62`) | Anything that re-plays on scroll |
| `pre.codeblock` | `rule` border, `r-panel`, `lift`, 16px pad, mono 13px/1.6, `mist`, `overflow-x: auto`, `tab-size: 2` (`globals.css:290-302`) | Every code plate — via `CodeBlock`, `SnippetTabs`, `CodeTabs` | `<pre>` typed by hand |
| `code.inline` | `rule` border, 4px, `lift`, mono 0.85em, `paper` (`globals.css:304-312`) | Identifiers inside prose — via `InlineCode` (`privacy/page.tsx:212`) | Multi-line code |
| `dialog::backdrop` | 80% ink (`globals.css:285-287`) | The native veil | — |

Keyframes owned by globals: `skeleton-sweep` (327), `reveal-up` (336), `spin-slow` (347).
`spin-slow` has **no consumer** — the spinner uses Tailwind's built-in `animate-spin`
(`button.tsx:93`); see §3.12.

### 3.10 Tokens and classes with zero consumers

Flagged, not deleted — some exist to serve markup that has not been written yet.

| Thing | Where | Status |
|---|---|---|
| `--gutter` + `.gutter` | `globals.css:27, 316-318` | No consumer anywhere in `src/`. All horizontal inset goes through `--pad-page` |
| `--section-y` + `.section-y` | `globals.css:29, 322-324` | No consumer; landing sections hand-roll their own clamps |
| `--shadow-raised` | `globals.css:40` | One intended consumer (`shadow-raised`, `account-menu.tsx:49`) that the `@theme` gap makes inert — §9 item 1 |
| shadcn interop block (9 vars) | `globals.css:43-51` | Zero consumers, by design as a registry safety net |
| `--font-heading` → `font-heading` | `globals.css:71` | Zero consumers; headings inherit `font-sans` from `<html>`, which is the same face |
| `--font-serif` → `font-serif` | `globals.css:69` | Zero consumers, and unusable upright — the face loads italic-only (`.aside` is the correct route) |
| `text-press` | via `@theme` `--color-press` | Unused; `press` is consumed as `bg-press` (`nav.tsx:70`) and as a raw var in charts/fx CSS |
| `@keyframes spin-slow` | `globals.css:347-351` | Zero consumers |
| `linePath()` | `series.ts:125-131` | Zero consumers. Exported for the "must not imply a curve" case; nothing needs it yet |
| `AreaStream` (whole component) | `area-stream.tsx` | Vendored and complete, not yet placed on a page |
| `KpiTile`, `KpiTileRow`, `TickStrip` | `tick-gauge.tsx:221-371` | Only `TickGauge` is consumed (`analytics/page.tsx:5`) |
| `CodeTabs` | `snippet-tabs.tsx:90` | Zero consumers (`SnippetTabs` is the one in use) |
| `ShinyText`, `Marquee`, `DotPattern` | `src/components/fx/` | Vendored, not yet placed (§6.3) |

---

## 4. Primitive kit — `src/components/ui/*`

Reach for these before writing markup. If none fits, that is a signal about the design, not an
invitation to hand-roll. Every file imports `cn` from `@/lib/cn` (verified: no `clsx`, no
`tailwind-merge`, no `@/lib/utils` import anywhere in `src/`).

### 4.1 `badge.tsx` — state without hue

- **`StatusDot({ tone, label, className })`** (`badge.tsx:20-35`). `tone` is `"active" | "idle" | "attention" | "failed"`
  (`badge.tsx:7`). The dot is `aria-hidden` and the **`label` prop is required by the type**, so
  the colour-alone failure is structurally impossible. Shapes: `active` = filled `paper`;
  `idle` = hollow `edge` ring ("never used, unknown, or merely pending"); `attention` = **dashed**
  `warn` ring; `failed` = filled `danger`. Use for connection/API/key/row health. Never for
  trend, sentiment, or decoration. All 7 call sites pass a label (verified).
- **`Badge({ children, variant, mono, className })`** (`badge.tsx:47-71`). 28px chip. Variants:
  `neutral` (edge/mist), `inverted` (**filled paper, ink text** — "the strong, affirmative state"),
  `outline` (dashed, dust — the weakest), `failed` (danger). `mono` defaults true (11px, 0.08em,
  uppercase); pass `mono={false}` for a 12px sentence chip. Rank is `inverted > neutral > outline`.
- **`MethodTag({ method })`** + **`isHttpMethod(value)`** (`badge.tsx:73-98`). 64px-min mono chip for
  GET/POST/PATCH/PUT/DELETE. Only `DELETE` earns `danger` (`badge.tsx:86, 91`) — the verb is
  carried by the word, so a wall of GETs does not become a colour chart. Use `isHttpMethod` as
  the type guard when narrowing a string from form state.
- **`StatusCode({ code })`** (`badge.tsx:100-115`). Tabular mono number. `5xx` → `danger`,
  `4xx` → `paper`, everything else `mist`. **`4xx` is deliberately not `warn`**: a client error is
  the caller's mistake, not the platform degrading. `code` is also mirrored into `title`.

### 4.2 `button.tsx` — controls

- **`Button`** (`button.tsx:40-62`): props `variant` (`solid|line|danger|ghost`, default `line`),
  `size` (`sm|min-h-10`, `md|min-h-11`, `lg|min-h-14`), `loading`, and native button props. It
  forces `type="button"` (`button.tsx:48`) — you must opt into `submit` deliberately. `loading`
  disables the button, sets `aria-busy`, adds `cursor-progress` and prepends a `Spinner`
  (`button.tsx:53-58`).
- **`PillLink`** (`button.tsx:72-85`): the same two axes on a Next `<Link>`, plus
  `prefetch|target|rel`. Any navigation shaped like a control is this, never an `<a>` with pill
  classes (the one exception is `Pagination`, which is a hairline-list control — §4.9).
- **`Spinner`** (`button.tsx:88-98`): `aria-hidden` hairline ring — `edge` border with a `paper`
  top edge. Inversion is the accent, so there is no coloured spinner.
- **`pillClass(variant, size, className)`** (`button.tsx:25-32`): exported for raw anchors that
  must look like a pill. `ghost` ignores `size` and pins `min-h-11 px-4`.
- Touch-floor tension: `.pill` sets `min-height: 44px`, but `SIZES.sm` = `min-h-10` (40px) wins as
  a utility — §9 item 4.

### 4.3 `code.tsx` — plates

- **`CodeBlock({ code, label, tone, copyable, className })`** (`code.tsx:5-36`): a `folio` label row
  with an optional `CopyButton`, then `pre.codeblock`. `tone="failed"` turns the code `danger` —
  this is the response-error use case, nothing else. `copyable={false}` for decorative snippets.
- **`InlineCode({ children })`** (`code.tsx:38-40`): `children` is typed `string` on purpose; it is
  an identifier, not a container.

### 4.4 `copy.tsx` — honesty about the clipboard

- **`useCopy(value)`** (`copy.tsx:23-46`): returns `{ state, copy }` with `state` in
  `"idle" | "copied" | "failed"`, auto-reset after 2s (`copy.tsx:10`). It resolves the real
  promise and **refuses to claim success it did not get** (`copy.tsx:22`), and is unmount-safe via
  a `mounted` ref. Use this before writing any copy affordance.
- **`CopyButton`** (`copy.tsx:48-73`): button label becomes `Copied` / `Try again`, and a separate
  `aria-live="polite"` `.folio` announces `on the clipboard` / `copy blocked`. The announcement is
  not colour, and not the button label alone.
- **`CopyField({ value, label, revealOnce, className })`** (`copy.tsx:76-116`): read-only `.field`
  that selects everything on focus/click; `revealOnce` adds the "this is the only time the full
  value is shown" warning (`key-reveal` flow).

### 4.5 `dialog.tsx` — native, and gated

- **`Dialog({ open, title, description, onClose, children, footer, size })`**
  (`dialog.tsx:13-75`): a real `<dialog>` driven by `showModal()`/`close()` in an effect
  (`dialog.tsx:33-38`). Reason, stated at the file header: *"focus trapping, Escape and
  top-layer stacking come from the browser, which is why this system installs no modal
  library."* `size` `sm|md|lg` → `max-w-md|xl|3xl`; body scrolls at `min(70vh,640px)`; the close
  control is a `ghost` button with `aria-label="Close dialog"`. Backdrop lives in globals
  because `::backdrop` is not Tailwind-targetable.
- **`ConfirmDialog({ open, title, body, confirmLabel, requireText, busy, error, onConfirm, onClose })`**
  (`dialog.tsx:82-150`). **`requireText` is a real gate, not a caption** (`dialog.tsx:109-110`):
  `gated = requireText !== undefined && typed !== requireText` and the `danger` confirm button is
  `disabled={gated}` (`dialog.tsx:123`). The typed text resets whenever the dialog closes
  (`dialog.tsx:105-107`). The prompt labels the field with the exact string to type
  (`dialog.tsx:138`), so the user types the object's name — "the sheet title is the thing the user
  actually recognises" (`dialog.tsx:77-80`). **Rule: any irreversible action passes `requireText`.**
  Key revocation and endpoint deletion are the canonical cases. `error` renders as a `role="alert"`
  line with a `⚠` prefix — severity by glyph, because chrome has no red.

### 4.6 `field.tsx` — controls

`TextField` / `TextArea` / `SelectField` share `FieldShell` (`field.tsx:22-49`) and the `CONTROL`
string `"field font-sans disabled:cursor-not-allowed disabled:opacity-60"` (`field.tsx:51-52`).
Contract, from the file header (`field.tsx:7-10`): 16px text so iOS never zooms, **border colour
is the focus affordance**, and the error is wired to the input. Precisely:

- id comes from `useId()` unless passed; `aria-describedby` points at `${id}-error` when an error
  exists, otherwise `${id}-hint` (`field.tsx:81`, 107, 151) — error wins, hint never disappears
  alongside it.
- `aria-invalid="true"` only when `error` is set (`field.tsx:80`) — that attribute is what drives
  `.field[aria-invalid] { border-color: var(--danger) }` (`globals.css:223-225`).
- Required fields mark the label with a `paper` `*` (`field.tsx:35`), not a red one.
- `SelectField` is `appearance-none` with an inline SVG chevron (`field.tsx:143-149`).
- **`Toggle({ label, checked, onChange, hint, disabled })`** (`field.tsx:174-203`): real checkbox
  with `role="switch"`, `sr-only` input driven by `peer-*`, track flips to `paper` when checked
  and the knob to `ink` — inversion, and a `peer-focus-visible` outline so the hidden input is
  still reachable. 44px minimum row height.
- **`CheckRow({ label, description, checked, onChange, disabled })`** (`field.tsx:205-242`): the
  multi-select row for key scopes and allowed operations; 44px tall, label on `paper`,
  description on `dust`.

### 4.7 `panel.tsx` — structure

- **`Panel({ children, className, as })`** (`panel.tsx:3-13`): `as` is `"section" | "div" | "article"` —
  pick the landmark, don't wrap a div in a section later.
- **`PanelHeader({ title, description, action })`** (`panel.tsx:15-40`): renders `h2` at 18px
  semibold, −0.02em. Since pages render one `h1` via `PageHeader`, panel titles are `h2` — the
  document outline is a consequence of using the kit, not extra work.
- **`PanelBody({ children, className })`** (`panel.tsx:42-44`): `px-5 py-5`, nothing else.
- **`PageHeader({ folio, title, description, action })`** (`panel.tsx:47-72`): folio index → `h1`
  at `clamp(30px,4vw,44px)` → one-line promise capped at `62ch` on `dust`. This is **the** page
  opener; every dashboard page uses it, and it is the source of the "one `h1` per page" rule.
- **`Metric({ label, value, sub, tone, loading })`** (`panel.tsx:78-109`): KPI tile, `folio` caption,
  big `clamp(28px,3.2vw,38px)` `.num` value, mono `dust` `sub`. `loading` swaps in a skeleton of
  the same size so nothing jumps. `tone="failed"` is *the only colour the system allows a metric*
  (`panel.tsx:74-77`) — a number that is actually telling you something broke.
- **`Row({ children, className, as, interactive })`** (`panel.tsx:112-134`): the house list row —
  hairline-separated, **not a card** ("the house structure, not a card", `panel.tsx:111`). Last row
  loses its border. `interactive` adds the `lift` hover wash at `--dur-fast`.
- **`RowTitle({ title, meta, href })`** (`panel.tsx:137-164`): two-line identity — name on `paper`
  (truncated), provenance in mono `dust` that lifts to `mist` on hover. With `href` the whole block
  is one anchor. Never nest a second link inside.

### 4.8 `snippet-tabs.tsx` — examples that cannot drift

- **`SnippetTabs({ request, className })`** (`snippet-tabs.tsx:21-87`): cURL/JavaScript/Python from
  `src/lib/snippets` — *"the same builders the public engine's tests pin, so the UI can never
  drift from the documented behaviour"* (`snippet-tabs.tsx:17-20`). If `validateSnippetRequest`
  returns issues, **it renders the issue list instead of code** (`snippet-tabs.tsx:68-73`) rather
  than printing a snippet that would lie. Roving tabindex, Arrow/Home/End keys,
  `role=tablist/tab/tabpanel` (`snippet-tabs.tsx:29-33, 51-56`).
- **`CodeTabs({ examples, label, className })`** (`snippet-tabs.tsx:90-135`): same tab shape for a
  caller holding finished strings. Returns `null` on an empty array. Currently unconsumed.

### 4.9 `state.tsx` — the honest empty/loading/failure set

- **`Skeleton`** / **`SkeletonRows({ rows, className })`** (`state.tsx:3-22`): the rows match the
  shape they replace *"so the page does not jump"*, and carry `role="status" aria-label="Loading"`.
- **`EmptyState({ title, body, action })`** (`state.tsx:24-47`): **dashed** `edge` border +
  `rounded-panel` — the dashed stroke is the system's sign for "nothing here yet", used nowhere
  else. Always give an `action` if one exists.
- **`ErrorState({ title, body, code, action })`** (`state.tsx:49-80`): `role="alert"`, `⚠` prefix,
  title on `paper`, body on `mist`, and the machine `code` in mono uppercase `dust`. *"The ⚠ prefix
  carries severity because this system has no red for chrome."* Retry sits beside it, never below
  the fold.
- **`Banner({ tone, title, body, action })`** (`state.tsx:82-111`): account-level notices (an expired
  Google connection). 2px left rule carries the tone: `neutral` → `paper`, `attention` → `warn`,
  `failed` → `danger`; `role` is `status` vs `alert` accordingly. Note `neutral` is `paper` — a
  plain notice is emphatic, not grey.
- **`LoadingText({ children })`** (`state.tsx:113-119`): `role="status"` mono uppercase. For inline
  waits, when a skeleton would be theatre.

### 4.10 `table.tsx` — real tabular data

Header comment is the rule: *"Real `<table>` markup, because logs and key inventories are tabular
data. Structure comes from hairlines only: no header fill, no zebra striping, no rounded cells"*
(`table.tsx:3-6`).

- **`TableScroll({ label, children })`** (`table.tsx:8-28`): `role="region"`, `tabIndex={0}`,
  `aria-label` — *"wide tables scroll horizontally as a keyboard-reachable region"*. Any table
  wider than its container is inside this.
- **`Table`** (`table.tsx:30-36`): `min-w-[680px]`, `border-collapse`, left-aligned.
- **`Th`** (`table.tsx:38-61`): `scope` (`col`/`row`), optional `align="right"`, content wrapped in
  `.folio`, `font-normal` on the element (the emphasis is the folio's, not the cell's).
- **`Tr({ interactive })`** (`table.tsx:63-83`): hairline below, last row clean, `lift` hover wash.
- **`Td({ align, numeric })`** (`table.tsx:85-108`): 14px `mist`; `numeric` implies
  right-align **and** `.num`.
- **`MonoCell({ value, title })`** (`table.tsx:110-117`): *"a cell that must never wrap or reflow:
  ids, hashes, previews."* Truncated at 180px with the full value in `title`. Pair with
  `shortId()` from `format.ts:84-88`.
- **`Pagination({ page, totalPages, totalRows, buildHref })`** (`table.tsx:119-164`): **link-based,
  by decision** — *"no client state, works with the filter query string, and is crawlable by the
  browser's back button."* `totalPages <= 1` degrades to a plain row count, not a dead control.

### 4.11 Format layer contract

`src/lib/format.ts` is the single voice for values (`format.ts:1-4`). Two rules with teeth:
`formatRelative` is client-only because a server/client double computation can differ and cause a
hydration mismatch (`format.ts:63-67`) — a Server Component uses `formatDateTime`; and every
null-ish input returns `—` (`format.ts:13, 20, 26, 48, 54, 60, 86`), which is the same glyph the
chart kit uses for "no limit given" (`tick-gauge.tsx:186`, `charts.css` readouts). Never render
`0`, `-`, `null` or `undefined` for a missing value.

---

## 5. Chart kit — `src/components/charts/*`

### 5.1 Invariants (non-negotiable)

1. **Declarative SVG, server-renderable.** No chart is a `"use client"` component;
   `area-stream.tsx`, `tick-gauge.tsx`, `diverging-waves.tsx`, `sparkline.tsx`,
   `column-chart.tsx` and `series.ts` contain no client directive, no state, no effects. They
   compute geometry from props and emit HTML. The only interactivity is CSS `:hover`/
   `:focus-within` and native `<title>` tooltips.
2. **A chart fabricates nothing.** Stated at `series.ts:12-16`: an absent bucket stays absent —
   broken path, no band thickness, `—`/`no reading` in the readout — and *"an empty input renders
   an empty plot instead of a flat line dressed up as a trend."* Axis maxima come from the input
   or from an explicit `domainMax` the caller passes (`series.ts:15`, `area-stream.tsx:49-50`,
   `column-chart.tsx:29-30`).
3. **Non-finite input is dropped, never guessed** (`sparkline.tsx:50`, `column-chart.tsx:59`,
   `diverging-waves.tsx:60-70`); `maxFinite`/`minFinite`/`sumFinite` ignore non-finite values and
   return 0 for empty (`series.ts:148-167`).
4. **Gaps are real gaps.** `consecutiveRuns()` (`series.ts:138-146`) splits indices into runs, so a
   hole in the shared bucket axis becomes two paths *"instead of one line drawn across data that
   was never measured"* — used by both `area-stream.tsx:181-187` and `diverging-waves.tsx:141-153`.
5. **Hue is the semantic channel only.** `ChartTone = "neutral" | "elevated" | "failed"`
   (`series.ts:18-22`); `elevated` → `--warn`, `failed` → `--danger`, and that is the entire colour
   surface of `charts.css` (`charts.css:258-286, 576-582, 638-644, 701-724, 762-773, 863-878, 949-963`).
   Everything else — series identity, emphasis, hierarchy — is stroke weight, dash pattern,
   opacity ladder and texture.
6. **Series differentiation without hue**, `area-stream.tsx:30-34`:
   `BAND_LUMINANCE = [.95,.74,.52,.36,.24]`, `LINE_LUMINANCE = [1,.72,.5,.36]`,
   `LINE_WEIGHT = [2.4,1.8,1.5,1.2]`, `LINE_DASH = [none, "10 4", "3 3", "12 3 3 3"]`,
   `TEXTURES = [solid, hatch, dots, grid]` (SVG patterns at `area-stream.tsx:305-333`). Index-based
   and cyclic; a legend swatch repeats the same weight/dash/texture (`area-stream.tsx:512-563`).
7. **Honest degenerate states.** Empty → `szc-empty` dashed plate with "No data yet"
   (`charts.css:139-154`: *"an honest hole, not a flat line pretending to be a trend"*). Single
   bucket → discrete bar/ticks and a printed reading list, *"no path, no implied slope"*
   (`area-stream.tsx:565-673`, `diverging-waves.tsx:386-401`); `smoothPath` itself returns `""` for
   no points and a lone `M` for one, so a caller cannot accidentally draw a trend
   (`series.ts:98-119`). Single-value runs get a `szc-marker` tick, *"otherwise a real zero-only
   bucket looks like no data"* (`area-stream.tsx:425-435`, `diverging-waves.tsx:160-172`).
8. **Every chart degrades under reduced motion** (`charts.css:1051-1090`): all animations dropped,
   dashoffset parked at 0, capsules at full height, `cursor: default`. The rest state is the
   readable state; the scrub line and dense value notes stay hidden because they are an
   affordance, *"never the only way to read a number"*.
9. **Text is a first-class citizen.** Each figure carries `role="img"` + a computed `aria-label`
   naming the range and the series (`area-stream.tsx:193-200`, `tick-gauge.tsx:97-105`,
   `column-chart.tsx:66-78`, `sparkline.tsx:78`), an `<svg aria-hidden>`, a `figcaption` explaining
   how to read it, and a data table (`sr-only` normally; **visible** `szc-table` when a column
   chart is dense and values are hover-only, `column-chart.tsx:80-84`). Axis labels, chips and
   readouts are HTML rails, not SVG text, so they stay crisp: plots use
   `preserveAspectRatio="none"` + `vectorEffect="non-scaling-stroke"` (`charts.css:133-137`).
10. **Charts know nothing about the domain.** `series.ts:6-11`: no chart imports `src/server/**`;
    a page maps its own rows into the primitive input types and passes pre-formatted strings,
    *"so the numbers on screen are the caller's own numbers."*

### 5.2 Inputs (`series.ts`)

| Type | Shape | Notes |
|---|---|---|
| `SeriesPoint` | `{ t: string; v: number }` | `t` is the bucket label **exactly as the caller words it** (`series.ts:24-28`) |
| `NamedSeries` | `{ name; points; tone? }` | `series.ts:30-36` |
| `DivergingRow` | `{ t; positive; negative }` | Both are **positive magnitudes**; the chart picks the side, never the sign, so "3 failed" is `3`, not `-3` (`series.ts:38-49`) |
| `QuotaReading` | `{ used; limit; warnAt? }` | `warnAt` is the caller's own early-warning value (`series.ts:51-57`) |
| `DistributionBucket` | `{ label; value; tone? }` | one bar (`series.ts:59-64`) |
| `KpiTileReading` | `{ caption; value; detail?; chip?; tone?; variant?; ticks? }` | `value`/`caption`/`detail` are already-formatted strings; the tile computes nothing (`series.ts:66-80`) |
| `ValueFormatter` / `ShareFormatter` | `(n) => string` | `rawValue` = `String(value)`, "no rounding, no unit invention" (`series.ts:82-88`) |
| `Point2`, `smoothPath`, `linePath`, `consecutiveRuns`, `maxFinite`, `minFinite`, `sumFinite` | geometry helpers | `smoothPath(points, start="M", k=0.17)` is Catmull-Rom→Bezier at tension **k = 0.17**, with the source's endpoint clamps (`series.ts:98-119`); `r()` rounds path data only — *"displayed numbers never pass through here"* (`series.ts:93-96`) |

### 5.3 Components

| Export | What | Props that matter | Reach for it when |
|---|---|---|---|
| `AreaStream` (`area-stream.tsx:109`) | Multi-series over time. `mode="river"` mirrors stacked bands about a centre line (band = share of bucket total, ribbon = total); `mode="overlay"` puts each series on one zero-anchored axis (`area-stream.tsx:41-46`) | `series`, `label`, `mode`, `height` (default 240; width always from the container, `area-stream.tsx:47-48`), `domainMax`, `formatValue`, `caption`, `alternative` | Traffic split across several endpoints/methods. Not yet placed on a page |
| `TickGauge` (`tick-gauge.tsx:66`) | Quota/rate burn as a half sweep of tick marks: filled = consumed, rest = headroom. 56 ticks over 180°→360°, `OUTER_R 136`, major every 7 at `R 112`, `GATE_R 104`, stroke 3.2/4 (`tick-gauge.tsx:21-31`) | `used`, `limit`, `warnAt` (caller's own value; at or above it the tone is `elevated`), `tickCount` clamped 7-120 (`tick-gauge.tsx:43-44`), `readout`, `caption`, `alternative` | Hour/day rate-limit burn. In use at `analytics/page.tsx:5` |
| `TickStrip` (`tick-gauge.tsx:240`) | 36 hairline ticks, taller every sixth (`tick-gauge.tsx:31-32`) | `used`, `limit`, `warnAt`, `note` | Inside a KPI tile: *"values are printed as text, so the strip is decoration-proof and the numbers survive without it"* (`tick-gauge.tsx:236-238`) |
| `KpiTile` / `KpiTileRow` (`tick-gauge.tsx:312, 348`) | Tile with cap/value/detail/chip; `solidIndex` marks the **one** inverted tile per row, "emphasis by inversion, not hue" (`charts.css:816-821`) | `KpiTileReading` fields, `formatValue` | Overview/dashboard KPI rows. On a solid tile, failure reads as a 3px `danger` **rule** rather than coloured type (`charts.css:871-878`) |
| `DivergingWaves` (`diverging-waves.tsx:90`) | Success above the axis, failure below, one `smoothPath` per side; optional `previous` window drawn behind at 1.6 weight + `10 4` dash (`diverging-waves.tsx:24-27, 39-41`) | `rows`, `aboveName`, `belowName` (caller words them), `previous`, `domainMax`, `height` (246) | Error-rate-over-time. In use at `analytics/page.tsx:4` |
| `Sparkline` (`sparkline.tsx:40`) | Fixed 96×30 per-row series; 15% lo/hi pad, flat series draws on the mid line (`sparkline.tsx:54-60`) | `points`, `label`, `tone`, `wash`, `readout` | Endpoint/log rows. Two-point series get real spacing (`sparkline.tsx:15-16, 61-65`). In use at `analytics/endpoint-usage.tsx:2` |
| `ColumnChart` (`column-chart.tsx:46`) | Capsule columns (HTML, so they stay round at any width, `charts.css:485`) over a recessive full-height track; the latest bucket gets a `press` ring (`column-chart.tsx:158`, `charts.css:572-574`) | `buckets`, `label`, `height` (160 + 18px label gutter), `domainMax`, `formatValue`, `formatShare`, `unitLabel` (*"the chart never invents a unit"*, `column-chart.tsx:34-35`) | Per-day/hour buckets, status-code distributions. In use on overview + analytics |

### 5.4 `charts.css`

The shared sheet (`charts.css:1-13` states the derivation): the reference kept its CSS in a
template string with gradient backgrounds, a blurred colour core, glass panels and three hues for
asset classes — *"All of that is gone. What survives here is its geometry and its monochrome
visual language."* Charts import it from the component (`import "./charts.css"`), so styles ship
only with the chart. Custom properties are namespaced `szc-*` (`szc-figure`, `szc-band`,
`szc-tick`, `szc-col-bar`, `szc-tile`, `szc-spark-*`, …) and tone is always carried by a
`data-tone` attribute, never by a modifier class you have to remember. Layout hooks at
`charts.css:966-1008` handle ≤420px: figure padding, rail width, label sizes, and
`.szc-spark-svg { max-width: 100% }` because *"a sparkline in a table cell may not force the row
wider than the viewport."*

---

## 6. FX catalogue — `src/components/fx/*` (vendored animation)

This section reproduces each file's own header comment. **The header in the file is the
authoritative provenance**; if this summary and a header disagree, the header wins and this
section is the bug.

### 6.1 The vendoring pipeline

- Components were taken from the **published registries**, not from a package:
  `https://reactbits.dev/r/{PascalName}-TS-TW.json` (React Bits, TS + Tailwind flavour) and
  `https://magicui.design/r/{kebab}.json` (Magic UI). Real source was read out of those JSON
  payloads, adapted, and written into `src/components/fx/`.
- **No component library was installed as a dependency.** `package.json` contains `next`, `react`,
  `react-dom`, `server-only`, `zod`, `drizzle-orm`, `pg`, `google-auth-library`, `googleapis` and
  dev tooling — no UI kit, no `motion`, no `gsap`. This is why the registry ships `clsx` +
  `tailwind-merge` imports and this repo does not.
- Registry CSS was extracted from the payloads too. Several sources ship **no `@keyframes` at
  all** (React Bits shiny/glitch are rAF engines; Magic UI's circular bar has `meta.json
  `css: {}`), so their motion lives in the local `.css` as real classes (`shiny-text.css:1-4`,
  `glitch-text.css:1-5`, `progress-ring.css:5-8`).
- Each vendored file is a **faithful port plus a written diff list**: the engine is kept verbatim
  where it is good, and every deviation is an intentional, recorded adaptation (defaults retargeted
  to tokens, decorative features removed, props replaced by semantics). Each file ends with a
  reduced-motion guarantee.

### 6.2 The adaptation contract (every `fx/*` file obeys this)

1. `cn` is imported from **`@/lib/cn`** — never from `clsx` or `tailwind-merge` directly, never
   from `@/lib/utils` (which does not exist here). Verified: zero offending imports in `src/`.
2. **Token classes only** — `bg-*`, `text-*`, `border-*`, `rounded-*`, `fill-*`, `stroke-*` from
   §3. No raw hex in styling. The only permitted raw values are structural alpha/mask channels
   (a `#000` in a `mask-image` gradient or an SVG texture pattern is geometry, not hue —
   `glitch-text.css:3-5`, `marquee.css:5-6`) and the rAF parse sentinel `#000000`
   (`shiny-text.tsx:104`).
3. **Every `.css` ends with a `@media (prefers-reduced-motion: reduce)` block.** Verified for all
   eight `fx/*.css` files plus `charts.css` and `globals.css`. The block must state *what the rest
   state is*, not merely disable animation (`noise.css:95-105` re-lists the opt-in modifiers so
   they are neutralised too; `pattern.css:39-47` holds the source's `initial` state rather than
   freezing mid-pulse; `glitch-text.css:115-138` makes the promise **without any JS at all**).
4. **Decorative layers get `aria-hidden="true"` and `pointer-events-none`** (`noise.tsx:28-29, 82`;
   `pattern.tsx:41-45, 157-159`; marquee clones `marquee.tsx:87-90`; SVG inside a `role="img"`
   figure; `ink-features.tsx:643, 659`). Where a clone could take a click, it is also disabled
   (`marquee.css:46-49`).
5. **Hue only for `warn`/`danger`** — the two chromatic components were re-tinted rather than
   deleted: GlitchText's red/cyan split became `["var(--press)","var(--paper)"]`
   (`glitch-text.tsx:3, 151`), ProgressRing's colour props became `tone` (`progress-ring.tsx:11-12`).
6. **A header comment naming the source URL and every change made.** No exceptions, and it is the
   first thing in the file (`shiny-text.tsx:3`, `pattern.tsx:1`, `series.ts:1`, `ink-features.tsx:1`).
7. Strict-TS hygiene: untyped prop escape hatches are dropped rather than cast (`pattern.tsx:1` —
   the source's `[key: string]: unknown`), `useId()` values are stripped of colons so `#id`
   selectors work for consumers (`pattern.tsx:13-14`, `area-stream.tsx:121`).
8. `magnet.tsx` has no `.css` and that is compliant, not an omission: *"Timing tokens do not apply
   here: the motion is a spring integrator, not a duration/ease pair"* (`magnet.tsx:1`), and its
   reduced-motion handling is a full JS teardown (`magnet.tsx:185-186, 292-295`).

### 6.3 Per-file inventory

**`shiny-text.tsx` / `.css` — React Bits `ShinyText`**
(`https://reactbits.dev/r/ShinyText-TS-TW.json`). Colour props default to Black Press tokens
(`var(--mist)` base, `var(--press)` shine) and are resolved through a var-aware parser first, so
contrast never drops below the base 10:1 (`shiny-text.tsx:93-98` — the registry accepted literal
CSS colours only). The endless `loop` default became **one sweep per pointer enter**
(`trigger = "hover"`, `shiny-text.tsx:140, 17-18, 31`; `loop` remains opt-in). Sweep duration falls
back to `--dur-slow` read off the theme at runtime (`shiny-text.tsx:204-211`) and the default
easing is `--ease-press`'s cubic bezier sampled per frame instead of the source's 2s/smooth
(`shiny-text.tsx:58-85`). **The source's `glow` blurred duplicate layer was dropped — house rule:
no glow.** Structural arbitrary-variant classes moved to `shiny-text.css`; the rAF
gradient/bands/pointer-follow engine is vendored verbatim. The CSS rest state under reduced motion
is full-weight `--mist` clipped to the text: readable, no shine (`shiny-text.css:16-24`).

**`glitch-text.tsx` / `.css` — React Bits `GlitchText`**
(`https://reactbits.dev/r/GlitchText-TS-TW.json`). Default `trigger` is `"hover"` — *"glitch is
opt-in; a heading never glitches without user intent"* (`glitch-text.tsx:26-27, 157`); `click`
fires a bounded burst, `always` stays available explicitly. The red/cyan `shadowColors` default
became the monochrome `["var(--press)","var(--paper)"]` (`glitch-text.tsx:151`). Tailwind
arbitrary-variant layer strings and the `bandMask()` custom properties moved verbatim into
`glitch-text.css` as real classes; `cursor-pointer` now applies only to the click trigger
(`glitch-text.tsx:3`, `glitch-text.css:29-32`); the source's `font-black` became the house display
weight 800 (`glitch-text.css:13`). The rAF slice/rgb/scan/noise engine is vendored unchanged. The
`noise` mode renders per-character cells, so the original layer is `aria-hidden` and the real
string is duplicated in an `sr-only` span (`glitch-text.tsx:429-444`).

**`marquee.tsx` / `.css` — Magic UI `marquee`** (`https://magicui.design/r/marquee.json`).
`cn` from `@/lib/cn`. The registry's `animate-marquee`/`animate-marquee-vertical` theme shortcuts,
its `--gap`/`--duration` vars and both `@keyframes` moved verbatim into `marquee.css` as plain
classes (this app's Tailwind theme defines no animation slots). The demos' `useMediaQuery` gate is
inlined as a private hook so hover-pause is skipped on `(hover: none)` devices
(`marquee.tsx:10-21, 69, 77`). The demos' Fade edge mask is folded in as a `fade` prop
(`marquee.tsx:52-56`). **Every clone track after the first is `aria-hidden` +
`pointer-events-none`** so screen readers read the content once and off-screen copies never
intercept clicks (`marquee.tsx:87-90`, `marquee.css:46-49`). Under reduced motion the strip stops
scrolling entirely and the first copy rests in normal flow, fully readable (`marquee.css:85-94`).

**`noise.tsx` / `.css` — React Bits `Noise`** (`https://reactbits.dev/r/Noise-TS-TW.json`). The
runtime canvas + `toBlob()` grain tile was **replaced by a static, desaturated SVG `feTurbulence`
data URI** (alpha forced opaque so it behaves like the source's grey tile, `noise.css:20`); the
rAF loop became transform/opacity keyframes (`noise.css:26-33, 62-93`). `colored` / `dust` /
`scratches` were **dropped** (hue + canvas machinery). Grain is **static by default: `fps`
defaults to 0** and jitter/flicker are opt-in (`noise.tsx:13-14, 47-52`). **Opacity is clamped to
`MAX_GRAIN_OPACITY = 0.09`** — "the source allowed 0-1, print texture needs single digits" — so
body text keeps its contrast (`noise.tsx:33-34, 59`). The scanline plate uses
`color-mix(in srgb, var(--ink) 55%, transparent)`, not a hex (`noise.css:42-48`). Everything stays
on the grain element itself because an extra wrapper around a `mix-blend-mode` child would create a
stacking context and change how the grain blends (`noise.css:9-11`). Root is
`pointer-events-none` + `aria-hidden` (`noise.tsx:28-29, 82`).

**`magnet.tsx` — React Bits `Magnet`** (`https://reactbits.dev/r/Magnet-TS-TW.json`). Spring
physics, shared exclusive arbitration and the whole prop API are **verbatim**. `padding` went
100→**0**, so the pull engages only while the pointer is inside the element (`magnet.tsx:18-19,
145`). `maxOffset` **defaults to 8 and is capped at 12** — *"a magnet may nudge a control, never
relocate it out from under the cursor"* (`magnet.tsx:64-66, 167`); `tilt` (≤8°) and `scale`
(0.94–1.08) get the same rail (`magnet.tsx:67-69, 170-171`). `will-change` is applied only when
motion is allowed (`magnet.tsx:274`). Reduced motion makes the component **inert before it
registers**, and it tears down if the preference is switched on mid-session, rather than merely
targeting zero (`magnet.tsx:185-186, 292-300`). Touch pointers are ignored
(`magnet.tsx:118`).

**`pattern.tsx` / `.css` — Magic UI `grid-pattern` + `dot-pattern`**
(`https://magicui.design/r/grid-pattern.json`, `https://magicui.design/r/dot-pattern.json`), both
kept as separate exports in one file. Greys remap to tokens: `fill-/stroke-gray-400/30` →
`fill-rule stroke-rule`, `text-neutral-400/80` → `text-dust/80` (`pattern.tsx:43, 158`). The
untyped `[key: string]: unknown` escape hatch is dropped so strict TS checks every prop. `useId()`
colons are stripped so `#id` selectors work. **DotPattern's `glow` was re-homed without its
dependency**: the source animated through `motion` (framer-motion), which is not installed and was
not added, so the identical animation (opacity 0.4→1, scale 1→1.5, reverse repeat, staggered delay)
became the `fx-dot-pulse` keyframe in `pattern.css` (`pattern.css:13-37`, `pattern.tsx:92-93`).
The per-dot `Math.random()` stagger became a deterministic phase
(`(i * 7919) % 1000 / 1000 * 5s`, `pattern.tsx:10-11, 147`); the dot field is `useMemo`ised and
measured with a `ResizeObserver` rather than a window resize listener (`pattern.tsx:117-134`).
The file carries `"use client"` — grid-pattern ships without it, but it now shares a module with
the hook-using dot-pattern (`pattern.tsx:2`).

**`progress-ring.tsx` / `.css` — Magic UI `animated-circular-progress-bar`**
(`https://magicui.design/r/animated-circular-progress-bar.json`). The
`gaugePrimaryColor`/`gaugeSecondaryColor` props are **replaced by tokens plus a semantic
`tone: "default" | "warn" | "danger"`** (`progress-ring.tsx:9-12`) — thumb `--paper`, track
`--rule`, and the track stays a hairline for every tone so the ring never turns decorative
(`progress-ring.css:40-77`). The source's `stroke-dasharray` arc is kept as the equivalent
`stroke-dashoffset` arc, so only dashoffset/stroke/transform transition; all arc geometry,
rotations including the gap circle's `scaleY(-1)` mirror, and the `--circle-size` custom-prop math
are verbatim (`progress-ring.css:10-64`). Timing moved from inline `1s`/`ease` to
`--dur-base`/`--dur-slow`/`--ease-press`, and the removed `animate-in fade-in` (from
`tailwindcss-animate`, not installed) became one local `fx-ring-fade-in` keyframe
(`progress-ring.css:1-8, 20-22, 87-94`). **The widget gained `role="img"` plus an `aria-label`
naming the real percentage** (with an optional `label` prop) while the `<svg>` is `aria-hidden`
(`progress-ring.tsx:33-43, 57`). The arc saturates at 0-100 but the readout shows the **true
rounded percent, so over-quota values stay honest** (`progress-ring.tsx:28-30, 99`). Reduced motion
rests the ring at its final value with the number simply present (`progress-ring.css:96-109`).

**`ink-features.tsx` / `.css` — "InkOrbitFeatures"** (from `ink-orbit-saas-template`, supplied by
the project owner 2026-11-05). A reference marketing section **retargeted to three truthful Sheet
Zaber diagrams**: the endpoint flow (real `/api/v1` verbs through the four per-request checks onto
a response envelope), the four checks (key → access → limits → row), and the rate-limit windows —
replacing the reference's integrations hub and its invented AI forecast chart
(`ink-features.tsx:1`). **Removed: the invented team portraits, presence dots, the auto-incrementing
ticking report counter, and the forecast series.** The `#22c55e` presence dot and coloured
drop-shadows are deleted; hue keeps its two documented meanings — a throttle is `--warn`, a
refused/failed request is `--danger` (`ink-features.css:9-12`). Every colour maps onto the app's
own custom properties, and the template's light/dark switch and theme prop went with them
(`ink-features.css:6-12`). Durations/easings come from the `--dur-*`/`--ease-press` tokens instead
of hard-coded numbers (`ink-features.css:13-14`). Defaults cite the product docs —
`docs/plan.md` D5/D8/D10/D11/D13, `docs/architecture.md` §3 and §6, `docs/security.md` §2 and §4,
`docs/backend-api-contract.md` §1 — and the copy carries the actual limits (1000/hour, 10000/day,
per-API hourly override, `ink-features.tsx:202-208`) and the actual verbs, scopes and envelope
shapes (`ink-features.tsx:211-253`). The rate-limit chart is explicitly *"a steady-rate model of
the two documented windows — never a claim about anyone's traffic"* and says so on screen
(`ink-features.tsx:985-989, 1121-1123`). **Both timers now pause on user intent** (the checks
auto-stepper stops on hover/focus and rests on the completed state under reduced motion,
`ink-features.tsx:860-869`) and **every diagram gained keyboard operation plus a DOM text
equivalent**: `role="button"` stops with Enter/Space/arrows/Home/End (`stepFromKey`,
`ink-features.tsx:133-158, 689-703`), the limiter is a `role="slider"` with full
`aria-valuetext` (`ink-features.tsx:1012-1055`), and each SVG is paired with a printed readout
(`ink-features.tsx:841-847, 964-971`). The 375px case pans the diagram and repeats the readout
beneath it (`ink-features.tsx:620-621`). The role classes in `ink-features.css` are deliberately
**unlayered so they beat Tailwind utilities** — never combine one with a `fill-*`/`stroke-*`
utility on the same element; use the `-on` / `-warn` variants (`ink-features.css:17-18`).

### 6.4 BLOCKED set (a real constraint, not a preference)

These cannot be vendored in this repo's current state. They are **not** "not yet tried": each
needs a dependency this project does not have, and installing one was out of scope.

| Wanted | Blocked on | Why it is blocked here |
|---|---|---|
| React Bits **CountUp** | `gsap@^3.13` + `@gsap/react` | GSAP-based number roll |
| React Bits **SplitText** | `gsap@^3.13` + `@gsap/react` | GSAP SplitText plugin |
| React Bits **ScrambledText** | `motion@^12` | animated glyph scramble |
| React Bits **AnimatedContent** | `motion@^12` | transition variants |
| React Bits **BlurText** | `motion@^12` | staggered filter/opacity |
| React Bits **DecryptedText** | `motion@^12` | interval + animated glyph swap |
| Magic UI **terminal** | `motion@^12` | typewriter/sequence |
| Magic UI **number-ticker** | `motion@^12` | animated value |
| Magic UI **border-beam** | `motion@^12` | animated conic sweep (and a moving coloured beam would fail the monochrome rule anyway — re-tint it before unblocking) |

The blocker: **`package.json` and `pnpm-lock.yaml` are owned by the Backend Agent and were
modified during this work**, so nothing was installed and the lockfile was not touched. Only
zero-dependency components were vendored (which is exactly why `pattern.css` exists: dot-pattern's
`glow` was re-homed into keyframes instead of adding `motion`).

**Pending dependency request** (needs an explicit go-ahead from the lead / Backend Agent):
add **`motion@^12`** to unlock ScrambledText, AnimatedContent, BlurText, DecryptedText, terminal,
number-ticker and border-beam; and/or **`gsap@^3.13` + `@gsap/react`** to unlock CountUp and
SplitText. `motion@^12` alone unblocks 7 of the 9, so it is the smaller ask and the recommended
one. Note that D14's "`motion` for animation" line (`docs/plan.md:81`) does not authorise the
install — that row was overridden with the monochrome decision, and an install is a dependency
change under another agent's ownership.

### 6.5 DECLINED set

| Reference | Decision | Reason |
|---|---|---|
| **SignUpFlow** | Declined | Would have meant placeholder auth UI for a flow the product does not have. Sheet Zaber is invitation-only with Google sign-in — there is no signup form to style (`docs/security.md` / `docs/authentication-flow.md`; see `docs/plan.md:76` D11, D12) |
| **IconFolder** | Declined | A file-browser concept the product does not have. The objects here are spreadsheets, endpoints, keys and log rows |
| **FinanceBento's internal 36-month data generator** (`ink-orbit-saas-template`, lines 178-187) | **Refused outright** | It **fabricates a series**, which is the exact failure §5.1 rule 2 forbids. Only its geometry was taken (`area-stream.tsx:1`, `series.ts:1`) |

Declining is a design-system act: it is the "no invented UI" principle (§7.3) applied to the
catalogue. A component that would need fake data to look right is not a missing feature, it is a
wrong feature.

---

## 7. Cross-cutting rules

### 7.1 Accessibility floor

- **One `h1` per page.** `PageHeader` is the only thing that emits one in the app
  (`panel.tsx:62`); marketing pages do it directly (`(marketing)/page.tsx:220`,
  `login/page.tsx:76`, `not-found.tsx:68`, `legal-doc.tsx:42`). Panel and section titles are `h2`
  (`panel.tsx:34`, `landing-section.tsx:24`), feature titles `h3` (`ink-features.tsx:488`). Use the
  kit and the outline is correct by construction. — *Why: screen-reader navigation is heading-based;
  a second `h1` or a skipped level makes the page unreadable in outline mode.*
- **Status is never colour alone.** Every `StatusDot` pairs with its word — `label` is a required
  prop and the dot is `aria-hidden` (`badge.tsx:20-35`); `attention` is also distinguished by a
  **dashed** ring (`badge.tsx:15`); errors carry a `⚠` glyph and text (`state.tsx:74`,
  `field.tsx:39-41`); the "filled dot = write scope" convention is spelled out in a printed legend
  (`ink-features.tsx:846`). — *Why: the system has exactly two hues and both mean failure, so a
  reader without colour access must still get the state.*
- **Visible focus from the kit**: global `:focus-visible` ring (`globals.css:101-104`), field focus
  via border colour (`globals.css:219-222`), `peer-focus-visible` on the switch
  (`field.tsx:196`), `focus-visible:outline-offset-[-1px]` on scroll regions (`table.tsx:23`),
  `:focus-within` scrub reveal (`charts.css:301-304`), and SVG stops that honour
  `:focus-visible` (`ink-features.css:158-161`). — *Why: an unfocusable control is a dead control.*
- **Labelled controls.** `TextField`/`TextArea`/`SelectField` always render a real `<label
  htmlFor>` and wire `aria-describedby` to error-or-hint (`field.tsx:32-48, 77-84`). Icon-only
  buttons get `aria-label` (`dialog.tsx:61`). Regions, tabs, sliders, switches and images get
  roles + names (`table.tsx:19-24`, `snippet-tabs.tsx:37-49`, `ink-features.tsx:1012-1020`,
  `progress-ring.tsx:33-39`).
- **Reduced motion honoured in both paths**: the global CSS kill-switch (`globals.css:353-365`,
  which also sets `scroll-behavior: auto`), a per-sheet rest-state contract in every `.css`, **and**
  JS that reads `matchMedia` — ShinyText parks one-shot and refuses to loop
  (`shiny-text.tsx:179, 320-348`), GlitchText refuses to run and calls `rest()`
  (`glitch-text.tsx:188, 229-231`), Magnet tears its listeners down mid-session
  (`magnet.tsx:185-186, 292-295`), InkOrbitFeatures never renders the SMIL packets or the
  auto-stepper (`ink-features.tsx:349, 757, 863-868, 898`). — *Why: CSS-only would leave rAF and
  SMIL loops running, which is the part that actually hurts.*
- **Copy never lies about the clipboard** (`copy.tsx:22, 66-70`) and the announcement is
  `aria-live`, not a colour change.
- Touch targets aim for 44px (`.pill` min-height, `min-h-11` rows/toggles, `szc-col` `min-height:
  44px` at `charts.css:537`); the `sm` pill undercuts it — §9 item 4.

### 7.2 Typographic voice

Serif for prose and editorial (`font-serif`/`Instrument Serif` only via `.aside`); **Bricolage for
display and UI** (`.display`, all default text); **mono for identifiers and code** (`.folio`,
`MethodTag`, `StatusCode`, `MonoCell`, `code.inline`, every chart readout). `.num` on every figure,
so tabular alignment is a rule rather than an accident (`globals.css:160-162`). Sizes are explicit
(`text-[13px]` meta, `text-[14px]` controls and table cells, `text-[15px]` body,
`text-[18px]` panel titles, `clamp(...)` for headings and metrics) — there is no numeric type
scale, and the scale you see *is* these numbers; adding a new one should be a deliberate step, not
a fudge. Emphasis is weight and inversion, never a colour change (`globals.css:142-150`,
`badge.tsx:41-42`, `nav.tsx:70`).

### 7.3 No invented UI for a concept that does not exist

The product's vocabulary is: spreadsheets (registered workbooks), endpoints/API configurations,
API keys with scopes, request logs, analytics windows, invitations, Google connections. If a
component would need a concept outside that list to look right, **decline it** (§6.5) — that is how
SignUpFlow and IconFolder were refused.

How this shows up in styling, concretely:

- `ink-features.tsx` is the template's feature section with the fake parts deleted: no portraits,
  no presence dots, no ticking counter, no forecast series; the counters are the documented
  limits, and the one modelled chart labels itself as a model (`ink-features.tsx:1, 985-989`).
- Charts refuse to draw a trend that was not measured (§5.1 rules 2-7) and refuse a unit the
  caller did not name (`column-chart.tsx:34-35`).
- `SnippetTabs` renders validation issues instead of code it cannot guarantee
  (`snippet-tabs.tsx:68-73`).
- `Pagination` collapses to a row count instead of dead page links (`table.tsx:134-140`).
- `EmptyState` uses a dashed plate instead of an illustration of something the product has never
  shown (`state.tsx:38`).
- Copy states the real thing: "This is the only time the full value is shown" (`copy.tsx:108-112`),
  "Nothing has been recorded for this window yet, so there is no line to draw"
  (`area-stream.tsx:234-235`).

### 7.4 Single-writer principle for state

One owner per piece of state; no parallel sources to reconcile.

- Server Components own data; client components own only interaction. `nav.tsx` receives the role
  as a **plain string prop** from the server layout because the file may not import from
  `src/server/**` (`server-only`) — the literal union mirrors `SessionRole` (`nav.tsx:3-9, 16`).
- Pages drive state through **URL search params** — `logs/filter-params.ts`,
  `analytics/window-params.ts`, `analytics/window-switch.tsx`, link-based `Pagination`
  (`table.tsx:119-124`) — so navigation, back button and share links all agree with the screen.
- Form state that must survive to a mutation lives in one place: `create-key-form.tsx:7` — "The
  field state here is only what the controls display; no key material is kept".
- Local UI state is scoped to the component that renders it (`Dialog` typed text
  `dialog.tsx:103-107`, active tab `snippet-tabs.tsx:22`, the diagram's selected verb
  `ink-features.tsx:591`). The `revealOnce` plaintext exists exactly once, in the copy of the
  server action that returns it.
- Mutations go through the route's `actions.ts` files (`apis/actions.ts`, `keys/actions.ts`,
  `spreadsheets/actions.ts`) with `src/lib/action-result.ts` as the single shape; `loading`/`busy`
  is owned by the caller of the action, and `Button loading` disables itself (`button.tsx:53-55`).
  Charts own no state at all (§5.1 rule 1).

### 7.5 The acceptance bar (the user's standard)

Four prohibitions, each with a check you can actually run:

| Prohibition | How a reviewer checks it |
|---|---|
| **No dead buttons** | Every `Button` has an `onClick`, a `type="submit"`, or is `disabled` for a visible reason; every `PillLink` resolves to a route that renders (§9 item 2); `ConfirmDialog`'s gate is the only intentional "cannot press yet" |
| **No fake charts** | Every chart input traces to a query result or a documented constant; `series.ts` has no data generators; no series is invented (§6.5) |
| **No placeholder analytics** | Every metric is derived from real rows or renders `Metric loading` / `—`; no "Lorem", no "—" presented as a measurement, no invented percentages (`series.ts:84-86`, `column-chart.tsx:104`) |
| **No broken navigation** | Every `href` in `navItemsFor`, in the marketing header/footer and in each page's actions resolves to a page under `src/app` (currently violated — §9 item 2) |

Anything that would fail one of these is not a styling choice to make.

---

## 8. Styling a new page — the short recipe

1. `PageHeader` with a `folio` index, the page's one `h1`, and at most one `action`.
2. Content in `Panel` + `PanelHeader` + `PanelBody`; lists as `Row` + `RowTitle`, tables as
   `TableScroll` > `Table` > `Th`/`Tr`/`Td`(+`MonoCell`) > `Pagination`.
3. Metrics via `Metric` or `KpiTileRow` (`solidIndex` = the one inverted tile).
4. Charts via the kit; map your rows into `SeriesPoint`/`NamedSeries`/`DivergingRow`/
   `DistributionBucket`/`QuotaReading` and pass `formatValue` from `src/lib/format.ts`.
5. Controls: `TextField`/`SelectField`/`Toggle`/`CheckRow`, `Button`/`PillLink`, `Dialog` /
   `ConfirmDialog` (with `requireText`) for anything irreversible, `CopyField`/`CopyButton` for
   anything a user has to capture.
6. Loading and failure: `Skeleton`/`SkeletonRows` matching the real shape, then `EmptyState` /
   `ErrorState` / `Banner` / `LoadingText`. Never a spinner in place of a layout.
7. Status: `StatusDot` with its word, `Badge`, `MethodTag`, `StatusCode`. Ask whether you need
   hue at all — usually `inverted` / `neutral` / `outline` is enough.
8. Type: `.folio` above data, `.display` for the big heading, `.num` on figures, `.aside` for one
   editorial line, `.kbd`/`InlineCode`/`CodeBlock` for literals.
9. Space: `.pad-page`, then the kit's `px-5 py-4` / `px-5 py-5`. Rhythm tokens: §3.2.
10. Motion: `duration-(--dur-fast)` for colour, `--dur-base` for entrances, `--dur-slow` for
    draws, always `var(--ease-press)` / `ease-(--ease-press)`; opacity/transform only; add a
    reduced-motion rest state.
11. FX: only from `src/components/fx/`, obeying §6.2. If a new effect needs a dependency, it is
    blocked until the install is approved (§6.4).
12. Check §7.5 before you call it done.

---

## 9. Drift and follow-ups

Found while reading; **not fixed** (source files are out of this document's scope). Each is a
file:line and the smallest correct fix.

1. **`shadow-raised` is used but never generated.** `--shadow-raised` is declared in
   `:root`/`.dark` (`src/app/globals.css:40`) but **not** in the `@theme inline` block
   (`globals.css:54-78`), which is the only place this file creates utilities. In Tailwind v4 the
   `shadow-*` utility namespace is fed by `--shadow-*` theme keys, so `shadow-raised` on the
   account menu (`src/components/app/account-menu.tsx:49`) resolves to nothing and that popover
   has **no elevation and no 1px edge** on a pure-black ground. Fix: add
   `--shadow-raised: var(--shadow-raised);` to `@theme inline`. *(I could not confirm this from
   build output — the only CSS in `.next/` predates Black Press and still defines
   `--status-green/amber/red` and a Space Grotesk font, so it is stale. Flagging as reasoning
   from the `@theme` model; a `pnpm build` and a grep for `.shadow-raised` in the emitted CSS
   would settle it.)*
2. **Three primary nav destinations have no route.** `nav.tsx:25, 28, 32` advertise
   `/playground`, `/settings`, `/admin`, and `logs/page.tsx:113, 184` and `overview/page.tsx:105`
   also link to `/playground`, but no page exists under `src/app` for any of the three — only API
   routes (`src/app/api/internal/playground/route.ts`, `src/app/api/internal/admin/**`). This
   violates the "no broken navigation" bar (§7.5). Four agents are in this tree concurrently, so
   this may be in-flight; **re-verify before treating it as open.**
3. **A `code.tsx` comment references a `/docs` route that does not exist**
   (`src/components/ui/code.tsx:4`, "used by `/docs` … and the playground response viewer");
   `docs/plan.md:82` (D15) still specifies an in-app `/docs` route group. Either the route lands
   or the comment and D15 should be corrected.
4. **`sm` pills fall under the 44px touch floor.** `.pill` sets `min-height: 44px`
   (`globals.css:169`) but `SIZES.sm = "min-h-10"` (40px) is a utility and therefore wins
   (`button.tsx:20`). `CopyButton` defaults to `sm` (`copy.tsx:51`), so the most-used small
   control is 40px. Decide: raise `sm` to `min-h-11`, or record 40px as the intentional small size.
5. **Raw hex duplicating tokens.**
   - `src/components/ui/field.tsx:234` — `accent-[#f2f2f2]` on `CheckRow` (identical to `--paper`);
     should be token-driven.
   - `src/components/ui/field.tsx:146` — the `SelectField` chevron data URI hard-codes
     `%238a8a8a` (identical to `--dust`); it will not follow a token change.
   - `src/app/globals.css:217` — `.field::placeholder` uses `#7d7d7d`, a grey that is in neither
     the ladder nor the registry (closest token is `--dust` `#8a8a8a`).
   - `src/app/globals.css:274` — `.skeleton` gradient midpoint `#141414` sits between `--lift`
     (`#0a0a0a`) and `--raise` (`#101010`) and matches neither.
   - `src/components/charts/area-stream.tsx:292-326` — `#ffffff` in the fade mask and `#000000` in
     the hatch/dots/grid texture patterns. The mask stops are alpha channels (defensible, cf.
     `glitch-text.css:3-5`); the texture strokes are *visible* ink and equal `--ink` — worth a
     comment or a token even if the value cannot change.
   - `src/components/fx/ink-features.css:26-29` — the hatch uses `rgb(242 242 242 / 0.05)`; a
     `color-mix(in srgb, var(--paper) 5%, transparent)` equivalent exists (`noise.css:44` uses it).
6. **Unconsumed tokens/classes** — full list in §3.10. The decisions to record: keep the shadcn
   interop block as a registry safety net but do not write new code against it; delete or wire up
   `--gutter`, `--section-y`/`.section-y`, `@keyframes spin-slow`, `linePath`, `font-heading`;
   and note that `.section-y` is what the marketing page's hand-rolled `py-[clamp(...)]` values
   were trying to be.
7. **Mono weight requests outside the loaded axis.** `charts.css:670-679` (`.szc-gauge-big`) and
   `charts.css:846-855` (`.szc-tile-value`) ask `font-weight: 300` from JetBrains Mono, which is
   loaded at 400 and 500 only (`layout.tsx:21-26`); the thin look is browser-synthesised or
   silently floored. Same class of issue if any mono surface asks for 600/700. Fix: widen the
   loaded weights or accept 400 as the lightest.
8. **`font-serif` is exported but not usable upright.** Instrument Serif is loaded italic-only
   (`layout.tsx:13-19`), while `@theme` publishes `--font-serif` (`globals.css:69`), inviting a
   `font-serif` class that would fall back to Georgia. `.aside` is the sanctioned path; consider
   dropping the utility mapping or documenting the constraint in the token table.
9. **`.skeleton` ignores the motion tokens** — `animation: skeleton-sweep 1.4s …`
   (`globals.css:276`) hard-codes a duration that exists nowhere in the `--dur-*` ladder. Either
   add a token or use `--dur-slow`; a global reduced-motion override currently handles it only by
   clamping duration (`globals.css:353-365`).
10. **`docs/plan.md:81` (D14) and `docs/plan.md:30-32` still describe the superseded identity** —
    Space Grotesk, `motion` for animation, and "functional color for status (green/red/amber)",
    plus a note that the portfolio's "black only" rule does *not* apply to Sheet Zaber. The shipped
    system is Bricolage + Instrument + JetBrains, zero-dependency animation, monochrome with two
    semantic hues, and it *does* adopt the portfolio's no-hue rule. This document records the
    override (§1); `plan.md` should be amended by whoever owns that file. Also note
    `docs/architecture.md:11` lists `/docs` in the (marketing) group topology, which does not
    exist (§9 item 3).

---

## 10. What could not be determined from this tree

- **Whether `shadow-raised` renders.** Blocked by the stale `.next` CSS (see §9 item 1); a build
  or dev run would settle it and was out of scope here.
- **The intended consumer of `--gutter`/`--section-y`.** They are fully specified in the token
  block, so they were written for a purpose, but nothing in `src/` reads them and no comment says
  what they were for. Marketing rhythm currently contradicts `--section-y`.
- **Whether the unconsumed kit exports (`AreaStream`, `KpiTile*`, `TickStrip`, `CodeTabs`,
  `ShinyText`, `Marquee`, `DotPattern`) are scheduled or speculative.** They are complete,
  documented and tested-by-shape, but no page imports them and no plan entry names a placement.
  Treat them as available, not as unused code to delete.
- **The origin date/version of each registry payload.** The headers cite registry URLs, not the
  fetched date or a version hash, so a future re-vendor cannot diff against a known upstream
  revision. Recommended follow-up (for whoever edits `fx/*`): add `fetched: <date>` to each header.
- **`IMPLEMENTATION.md` and `docs/*` are being edited by other agents concurrently**; where this
  document cites them (`docs/plan.md:81`, `docs/backend-api-contract.md` §1.4,
  `docs/architecture.md` §3) it cites what was in the tree at read time.


## Portfolio composition layer

Chapter vocabulary shared with the portfolio, with no new dependencies. Components: `ui/chapter.tsx` (`Folio`,
`TitleAside`, `Rings`), `ui/stat-band.tsx`, `ui/count-up.tsx`, `marketing/ribbon.tsx`, `marketing/tab-to-endpoint.tsx`,
`marketing/faq.tsx`, `app/command-palette.tsx`, `app/breadcrumbs.tsx`, `app/setup-checklist.tsx`, `app/error-screen.tsx`.
Motion lives in `globals.css` (`.hero-rise`, `.stagger-page`, `.scroll-rise`, `.ring-line`, `.plate-*`), and everything
that loops or responds to scroll sits behind `prefers-reduced-motion: no-preference`. Keep opacity entrances under 500ms.
