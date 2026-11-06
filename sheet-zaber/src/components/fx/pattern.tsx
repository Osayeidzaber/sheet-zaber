/** Adapted from Magic UI "grid-pattern" (https://magicui.design/r/grid-pattern.json) and Magic UI "dot-pattern" (https://magicui.design/r/dot-pattern.json), both kept as separate exported components in one file. Greys remap to Black Press tokens (`fill-/stroke-gray-400/30` -> `fill-rule stroke-rule`, `text-neutral-400/80` -> `text-dust/80`), the untyped `[key: string]: unknown` prop escape hatch is dropped so strict TS still checks every prop, `useId()` values are stripped of their colons so `#id` selectors work for consumers, and dot-pattern's `glow` is re-implemented without its dependency: the source animates through `motion` (framer-motion), which is not installed and was not added, so the identical animation (opacity 0.4->1, scale 1->1.5, reverse repeat, staggered delay) became keyframes in pattern.css with a deterministic per-dot phase instead of `Math.random()` per render, the dot field is memoised and measured with a ResizeObserver rather than a window resize listener, and the file carries "use client" (grid-pattern ships without it, but it now shares a module with the hook-using dot-pattern). */
"use client"

import "./pattern.css"

import { useEffect, useId, useMemo, useRef, useState } from "react"

import { cn } from "@/lib/cn"

/** The source's `Math.random() * 5` spread, now applied deterministically per dot. */
const GLOW_PHASE_SPREAD = 5

/** React's useId wraps the value in colons, which breaks `#id` selectors for consumers. */
const usePatternId = () => useId().replace(/:/g, "")

export interface GridPatternProps extends React.SVGProps<SVGSVGElement> {
  width?: number
  height?: number
  x?: number
  y?: number
  squares?: Array<[x: number, y: number]>
  strokeDasharray?: string
  className?: string
}

/** Hairline grid plate. Static by default; `squares` fills the cells you name. */
export function GridPattern({
  width = 40,
  height = 40,
  x = -1,
  y = -1,
  strokeDasharray = "0",
  squares,
  className,
  ...props
}: GridPatternProps) {
  const id = usePatternId()

  return (
    <svg
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full fill-rule stroke-rule",
        className
      )}
      {...props}
    >
      <defs>
        <pattern
          id={id}
          width={width}
          height={height}
          patternUnits="userSpaceOnUse"
          x={x}
          y={y}
        >
          <path
            d={`M.5 ${height}V.5H${width}`}
            fill="none"
            strokeDasharray={strokeDasharray}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" strokeWidth={0} fill={`url(#${id})`} />
      {squares && (
        <svg x={x} y={y} className="overflow-visible">
          {squares.map(([squareX, squareY]) => (
            <rect
              strokeWidth="0"
              key={`${squareX}-${squareY}`}
              width={width - 1}
              height={height - 1}
              x={squareX * width + 1}
              y={squareY * height + 1}
            />
          ))}
        </svg>
      )}
    </svg>
  )
}

export interface DotPatternProps extends React.SVGProps<SVGSVGElement> {
  width?: number
  height?: number
  x?: number
  y?: number
  cx?: number
  cy?: number
  cr?: number
  className?: string
  /** Opt-in pulse. The plate is static unless this is true. */
  glow?: boolean
}

/**
 * Dot field sized to the container. Dots are counted from the measured box, so the field is
 * empty until the first layout pass — same as the source. One circle per dot, as upstream;
 * keep the spacing coarse on large surfaces if you turn `glow` on.
 */
export function DotPattern({
  width = 16,
  height = 16,
  x = 0,
  y = 0,
  cx = 1,
  cy = 1,
  cr = 1,
  className,
  glow = false,
  ...props
}: DotPatternProps) {
  const id = usePatternId()
  const containerRef = useRef<SVGSVGElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const measure = () => {
      const box = container.getBoundingClientRect()
      setDimensions(current =>
        current.width === box.width && current.height === box.height
          ? current
          : { width: box.width, height: box.height }
      )
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const columns = Math.ceil(dimensions.width / width)
  const rows = Math.ceil(dimensions.height / height)

  const dots = useMemo(
    () =>
      Array.from({ length: columns * rows }, (_, i) => {
        const col = i % columns
        const row = Math.floor(i / columns)
        return {
          x: col * width + cx + x,
          y: row * height + cy + y,
          delay: (((i * 7919) % 1000) / 1000) * GLOW_PHASE_SPREAD,
        }
      }),
    [columns, rows, width, height, x, y, cx, cy]
  )

  return (
    <svg
      ref={containerRef}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full text-dust/80",
        className
      )}
      {...props}
    >
      <defs>
        <radialGradient id={`${id}-gradient`}>
          <stop offset="0%" stopColor="currentColor" stopOpacity="1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      {dots.map(dot => (
        <circle
          key={`${dot.x}-${dot.y}`}
          cx={dot.x}
          cy={dot.y}
          r={cr}
          fill={glow ? `url(#${id}-gradient)` : "currentColor"}
          className={glow ? "fx-dot-glow" : undefined}
          style={
            glow
              ? ({ "--fx-dot-delay": `${dot.delay.toFixed(3)}s` } as React.CSSProperties)
              : undefined
          }
        />
      ))}
    </svg>
  )
}
