import Link from "next/link"

import { pillClass } from "@/components/ui/pill"
import { Panel, PanelBody } from "@/components/ui/panel"
import { cn } from "@/lib/cn"
import { formatDay } from "@/lib/format"
import {
  ANALYTICS_WINDOWS,
  analyticsHref,
  type AnalyticsWindow,
  type AnalyticsWindowDays,
} from "./window-params"

/*
 * The window is a link, not a widget: choosing 30 days navigates, the page re-runs the aggregate
 * queries with the new bounds, and the URL you end up on is the one you can hand to someone else.
 */
export function WindowSwitch({
  current,
  window,
}: {
  current: AnalyticsWindowDays
  window: AnalyticsWindow
}) {
  return (
    <Panel as="section">
      <PanelHeaderish
        measured={formatDay(window.from.toISOString())}
        through={formatDay(window.to.toISOString())}
        days={current}
      />
      <PanelBody className="flex flex-wrap items-center gap-3">
        <nav aria-label="Analytics window" className="flex flex-wrap items-center gap-3">
          {ANALYTICS_WINDOWS.map((days) => (
            <Link
              key={days}
              href={analyticsHref(days)}
              aria-current={days === current ? "true" : undefined}
              className={cn(pillClass(days === current ? "solid" : "line", "sm"))}
            >
              {days} days
            </Link>
          ))}
        </nav>
        <span className="font-mono text-[12px] text-dust">
          Window {formatDay(window.from.toISOString())} – {formatDay(window.to.toISOString())},
          measured against the same {current} days before it.
        </span>
      </PanelBody>
    </Panel>
  )
}

function PanelHeaderish({
  measured,
  through,
  days,
}: {
  measured: string
  through: string
  days: AnalyticsWindowDays
}) {
  return (
    <div className="border-b border-rule px-5 py-4">
      <p className="folio">Window</p>
      <p className="mt-2 text-[15px] text-paper">
        Last {days} days · {measured} through {through}
      </p>
      <p className="mt-1 text-[13px] leading-[1.6] text-dust">
        Every figure below is bounded by this window unless it says otherwise. The two short budget
        gauges are fixed 1-hour and 24-hour reads, because that is the shape the limits are written
        in.
      </p>
    </div>
  )
}
