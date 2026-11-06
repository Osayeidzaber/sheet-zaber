/** Adapted from Magic UI "animated-circular-progress-bar" (https://magicui.design/r/animated-circular-progress-bar.json). Changes: the gaugePrimaryColor/gaugeSecondaryColor props are replaced by Black Press tokens (thumb var(--paper), track var(--rule)) plus a semantic `tone` prop ("default" | "warn" | "danger"); the source's stroke-dasharray arc is kept as the equivalent stroke-dashoffset arc (dasharray = C, offset = C - percent * percent-to-px) so only dashoffset/stroke/transform transition, and its strokeDashoffset="0" attribute moves to CSS; all arcs, rotations (incl. the gap circle's scaleY(-1) mirror), custom-prop geometry and --circle-size origin are kept verbatim from the source; timing moves from inline 1s/ease to --dur-base/--ease-press via progress-ring.css, where the removed `animate-in fade-in` (tw-animate, not installed) becomes one local keyframe; the readout keeps data-current-value, gains font-mono/text-paper, and the widget gains role="img" + aria-label naming the real percentage (with an optional `label` prop) while the svg is aria-hidden; the arc saturates at 0-100 but the readout shows the true rounded percent, so over-quota values stay honest; reduced motion rests the ring at its final value (see progress-ring.css). */

import { cn } from "@/lib/cn"

import "./progress-ring.css"

interface AnimatedCircularProgressBarProps {
  max?: number
  min?: number
  value: number
  /** Hue is semantic-only: `warn` = elevated/degrading, `danger` = failing or disabled. */
  tone?: "default" | "warn" | "danger"
  /** What the ring measures; announced as "<label>: <percent> percent". */
  label?: string
  className?: string
}

export function AnimatedCircularProgressBar({
  max = 100,
  min = 0,
  value = 0,
  tone = "default",
  label,
  className,
}: AnimatedCircularProgressBarProps) {
  const circumference = 2 * Math.PI * 45
  const percentPx = circumference / 100
  const currentPercent = Math.round(((value - min) / (max - min)) * 100)
  // Geometry clamps to the circle's real range; the text readout below stays unclamped.
  const arcPercent = Math.min(100, Math.max(0, currentPercent))

  return (
    <div
      role="img"
      aria-label={
        label
          ? `${label}: ${currentPercent} percent`
          : `${currentPercent} percent`
      }
      data-tone={tone}
      className={cn(
        "fx-progress-ring relative size-40 font-mono text-2xl font-semibold",
        className
      )}
      style={
        {
          "--circle-size": "100px",
          "--circumference": `${circumference}px`,
          "--percent-to-px": `${percentPx}px`,
          "--gap-percent": "5",
          "--offset-factor": "0",
          "--percent-to-deg": "3.6deg",
          transform: "translateZ(0)",
        } as React.CSSProperties
      }
    >
      <svg
        aria-hidden="true"
        fill="none"
        className="size-full"
        strokeWidth="2"
        viewBox="0 0 100 100"
      >
        {currentPercent <= 90 && currentPercent >= 0 && (
          <circle
            cx="50"
            cy="50"
            r="45"
            strokeWidth="10"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="fx-progress-ring__gap"
            style={
              {
                "--stroke-percent": 90 - currentPercent,
              } as React.CSSProperties
            }
          />
        )}
        <circle
          cx="50"
          cy="50"
          r="45"
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="fx-progress-ring__thumb"
          style={
            {
              "--stroke-percent": arcPercent,
            } as React.CSSProperties
          }
        />
      </svg>
      <span
        data-current-value={currentPercent}
        className="fx-progress-ring__value absolute inset-0 m-auto size-fit text-paper"
      >
        {currentPercent}
      </span>
    </div>
  )
}
