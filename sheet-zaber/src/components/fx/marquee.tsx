"use client"

/** Adapted from Magic UI "marquee" (https://magicui.design/r/marquee.json). cn comes from @/lib/cn; the source's `animate-marquee`/`animate-marquee-vertical` Tailwind theme shortcuts, its `--gap`/`--duration` vars and the two @keyframes the registry ships moved verbatim into marquee.css as plain classes; the registry demos' `useMediaQuery` gate (demo: `pauseOnHover={!isMobile}`) is inlined as a private hook so hover-pause is skipped on `(hover: none)` devices; the demos' Fade edge mask is folded in as a `fade` prop; and every clone track after the first is `aria-hidden` + pointer-events-none so screen readers read the content once and off-screen copies never intercept clicks. */

import { useCallback, useSyncExternalStore, type ComponentPropsWithoutRef, type ReactNode } from "react"

import { cn } from "@/lib/cn"
import "./marquee.css"

/** The answer on a server, where there is no media query to read - the value the hook opened with. */
const noMediaQuery = () => false

/** The registry demos gate hover-pause with this hook; inlined here (file-ownership rules). */
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    [query],
  )
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query])
  // `matchMedia` is an external system, so it is subscribed to rather than mirrored into state
  // inside an effect (`react-hooks/set-state-in-effect`); React re-reads the snapshot straight
  // after hydration, which is the frame the old effect wrote on.
  return useSyncExternalStore(subscribe, getSnapshot, noMediaQuery)
}

interface MarqueeProps extends ComponentPropsWithoutRef<"div"> {
  /**
   * Optional CSS class name to apply custom styles
   */
  className?: string
  /**
   * Whether to reverse the animation direction
   * @default false
   */
  reverse?: boolean
  /**
   * Whether to pause the animation on hover
   * @default false
   */
  pauseOnHover?: boolean
  /**
   * Content to be displayed in the marquee
   */
  children: ReactNode
  /**
   * Whether to animate vertically instead of horizontally
   * @default false
   */
  vertical?: boolean
  /**
   * Number of times to repeat the content
   * @default 4
   */
  repeat?: number
  /**
   * Fade the strip's edges with a mask gradient (the registry demos' "Fade" treatment)
   * @default false
   */
  fade?: boolean
}

export function Marquee({
  className,
  reverse = false,
  pauseOnHover = false,
  children,
  vertical = false,
  repeat = 4,
  fade = false,
  ...props
}: MarqueeProps) {
  const hoverless = useMediaQuery("(hover: none)")

  return (
    <div
      {...props}
      className={cn(
        "fx-marquee",
        vertical ? "fx-marquee--vertical" : "fx-marquee--horizontal",
        pauseOnHover && !hoverless && "fx-marquee--pause",
        fade && (vertical ? "fx-marquee--fade-v" : "fx-marquee--fade-h"),
        className
      )}
    >
      {Array(repeat)
        .fill(0)
        .map((_, i) => (
          <div
            key={i}
            aria-hidden={i !== 0 || undefined}
            className={cn(
              "fx-marquee__track",
              i !== 0 && "fx-marquee__track--clone",
              reverse && "fx-marquee__track--reverse"
            )}
          >
            {children}
          </div>
        ))}
    </div>
  )
}
