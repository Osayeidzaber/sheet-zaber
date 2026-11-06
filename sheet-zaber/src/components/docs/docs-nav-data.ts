/*
 * The section list shared by the docs sidebar (`docs-nav.tsx`) and the /docs contents block.
 * Kept in its own module with no `"use client"` directive so both the server pages and the
 * client navigation read one list: adding a page here and a route directory is the whole
 * contract for a new docs section.
 *
 * Every `href` is a route directory under `src/app/(marketing)/docs/**` and every `anchors.id`
 * is a real `id` rendered by that page, so the navigation cannot contain a dead link.
 */

export type DocsAnchor = { id: string; label: string }

export type DocsNavItem = {
  /** Monospace clause number, printed the same way the legal pages number their clauses. */
  index: string
  href: string
  label: string
  /** One line for the /docs contents list. */
  blurb: string
  /** In-page anchors, listed only while this section is the current one. */
  anchors?: DocsAnchor[]
}

export const DOCS_NAV: DocsNavItem[] = [
  {
    index: "01",
    href: "/docs",
    label: "Overview",
    blurb: "Base URL, the key model, the one envelope, and what invitation-only means here.",
  },
  {
    index: "03",
    href: "/docs/authentication",
    label: "Authentication",
    blurb: "The Authorization header, scopes, restrictions, and why a key is shown once.",
  },
  {
    index: "04",
    href: "/docs/envelope",
    label: "Response envelope",
    blurb: "{ data, meta } on success, one { error } shape on every non-2xx.",
  },
  {
    index: "05",
    href: "/docs/operations",
    label: "Operations",
    blurb: "One subsection per verb: parameters, success shape, realistic failures, an example.",
    anchors: [
      { id: "list-records", label: "List records" },
      { id: "single-record", label: "Single record" },
      { id: "search", label: "Search" },
      { id: "range", label: "Range" },
      { id: "create", label: "Create" },
      { id: "update-merge", label: "Update (merge)" },
      { id: "replace", label: "Replace" },
      { id: "delete", label: "Delete" },
      { id: "not-in-v1", label: "Not in v1" },
    ],
  },
  {
    index: "06",
    href: "/docs/errors",
    label: "Error reference",
    blurb: "Every documented code, the status it is answered with, and what the caller should do.",
  },
  {
    index: "07",
    href: "/docs/rate-limits",
    label: "Rate limits",
    blurb: "The documented defaults, the per-API override, and the ceilings next to them.",
  },
]

/** `href`s in nav order, so the active-section test and the ordering share one source. */
export const DOCS_HREFS: string[] = DOCS_NAV.map((item) => item.href)

/**
 * `/docs` is a prefix of every other route in the group, so it only wins an exact match; the
 * rest also match a deeper path, which cannot happen for them today but must not mis-indicate
 * if a subsection route is added later.
 */
export function isCurrentSection(href: string, pathname: string): boolean {
  return href === "/docs" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)
}
