/** Adapted from React Bits "Magnet" (https://reactbits.dev/r/Magnet-TS-TW.json). Spring physics, shared exclusive arbitration and the whole prop API are kept; `padding` now defaults to 0 so the pull engages only while the pointer is inside the element, travel is clamped to 8px by default and capped at 12px so a click target can never be shoved out from under the cursor, `tilt` and `scale` get the same rail, `will-change` is applied only when motion is allowed, and a reduced-motion preference makes the component inert before it registers (and it tears down if the preference is switched on mid-session) rather than merely targeting zero. Timing tokens do not apply here: the motion is a spring integrator, not a duration/ease pair, so no magnet.css was needed. */
"use client"

import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react"

import { cn } from "@/lib/cn"

export type MagnetAxis = "both" | "x" | "y"

export interface MagnetSpring {
  stiffness?: number
  damping?: number
  mass?: number
}

export interface MagnetProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  /** Ring of reach in px. 0 (default) engages only while the pointer is inside the element. */
  padding?: number
  disabled?: boolean
  /** Divisor on the pointer delta: higher is a weaker pull. */
  magnetStrength?: number
  /** Hard ceiling on travel; the effective value is additionally capped at MAX_TRAVEL. */
  maxOffset?: number
  exclusive?: boolean
  axis?: MagnetAxis
  tilt?: number
  scale?: number
  spring?: MagnetSpring
  onActiveChange?: (active: boolean) => void
  wrapperClassName?: string
  innerClassName?: string
}

type Motion = { x: number; y: number; tiltX: number; tiltY: number; scale: number }

type Point = { x: number; y: number }

type Settings = {
  padding: number
  disabled: boolean
  strength: number
  maxOffset: number
  exclusive: boolean
  axis: MagnetAxis
  tilt: number
  scale: number
  stiffness: number
  damping: number
  mass: number
  onActiveChange?: (active: boolean) => void
}

type Entry = {
  wrapper: HTMLDivElement
  settings: { current: Settings }
  wake: () => void
  active: boolean
}

const DEFAULT_SPRING = { stiffness: 170, damping: 16, mass: 1 }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
/** House rails: a magnet may nudge a control, never relocate it out from under the cursor. */
const DEFAULT_TRAVEL = 8
const MAX_TRAVEL = 12
const MAX_TILT = 8
const MIN_SCALE = 0.94
const MAX_SCALE = 1.08

const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

const registry = new Set<Entry>()
const field: { pointer: Point | null; owner: Entry | null } = { pointer: null, owner: null }
let detach: (() => void) | null = null

const reach = (rect: DOMRect, pointer: Point) => {
  const dx = pointer.x - (rect.left + rect.width / 2)
  const dy = pointer.y - (rect.top + rect.height / 2)
  const outside = Math.hypot(Math.max(0, Math.abs(dx) - rect.width / 2), Math.max(0, Math.abs(dy) - rect.height / 2))
  return { dx, dy, outside }
}

const arbitrate = () => {
  let winner: Entry | null = null
  let nearest = Infinity
  let closest = Infinity
  for (const entry of registry) {
    const s = entry.settings.current
    let near: { dx: number; dy: number; outside: number } | null = null
    if (field.pointer && !s.disabled) {
      near = reach(entry.wrapper.getBoundingClientRect(), field.pointer)
      if (near.outside > s.padding) near = null
    }
    if (!s.exclusive) {
      if (near || entry.active) entry.wake()
      continue
    }
    if (!near) continue
    const center = Math.hypot(near.dx, near.dy)
    if (near.outside < nearest || (near.outside === nearest && center < closest)) {
      winner = entry
      nearest = near.outside
      closest = center
    }
  }
  const previous = field.owner
  field.owner = winner
  if (previous && previous !== winner) previous.wake()
  if (winner) winner.wake()
}

const attach = () => {
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return
    field.pointer = { x: event.clientX, y: event.clientY }
    arbitrate()
  }
  const onLeave = () => {
    field.pointer = null
    arbitrate()
  }
  window.addEventListener("pointermove", onPointerMove, { passive: true })
  window.addEventListener("scroll", arbitrate, { passive: true, capture: true })
  document.documentElement.addEventListener("pointerleave", onLeave)
  window.addEventListener("blur", onLeave)
  return () => {
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("scroll", arbitrate, { capture: true })
    document.documentElement.removeEventListener("pointerleave", onLeave)
    window.removeEventListener("blur", onLeave)
  }
}

/**
 * Pointer-follow wrapper for a single control. The wrapper stays in flow; only the inner
 * plate is transformed, and it settles back to rest the moment the pointer leaves.
 * The source exposes no external ref — it owns both of its element refs.
 */
export function Magnet({
  children,
  padding = 0,
  disabled = false,
  magnetStrength = 2,
  maxOffset,
  exclusive = true,
  axis = "both",
  tilt = 0,
  scale = 1,
  spring,
  onActiveChange,
  wrapperClassName = "",
  innerClassName = "",
  style,
  ...props
}: MagnetProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const wakeRef = useRef<(() => void) | null>(null)
  const settings: Settings = {
    padding: Math.max(0, padding),
    disabled,
    strength: Math.max(0.1, magnetStrength),
    maxOffset: clamp(maxOffset ?? DEFAULT_TRAVEL, 0, MAX_TRAVEL),
    exclusive,
    axis,
    tilt: clamp(tilt, 0, MAX_TILT),
    scale: clamp(scale, MIN_SCALE, MAX_SCALE),
    stiffness: Math.max(1, spring?.stiffness ?? DEFAULT_SPRING.stiffness),
    damping: Math.max(0, spring?.damping ?? DEFAULT_SPRING.damping),
    mass: Math.max(0.01, spring?.mass ?? DEFAULT_SPRING.mass),
    onActiveChange,
  }
  const settingsRef = useRef(settings)
  // Synced after commit rather than during render (`react-hooks/refs`). The spring loop reads this
  // on its next animation frame, so the one-frame delay is invisible and render stays pure.
  useEffect(() => {
    settingsRef.current = settings
  })

  useEffect(() => {
    const wrapper = wrapperRef.current
    const inner = innerRef.current
    if (!wrapper || !inner) return undefined

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    if (motionQuery.matches) return undefined

    const current: Motion = { x: 0, y: 0, tiltX: 0, tiltY: 0, scale: 1 }
    const velocity: Motion = { x: 0, y: 0, tiltX: 0, tiltY: 0, scale: 0 }
    let active = false
    let raf = 0
    let last = 0

    const solve = (target: Motion, dt: number) => {
      const s = settingsRef.current
      let resting = true
      ;(Object.keys(current) as (keyof Motion)[]).forEach(key => {
        const force = s.stiffness * (target[key] - current[key]) - s.damping * velocity[key]
        velocity[key] += (force / s.mass) * dt
        current[key] += velocity[key] * dt
        const epsilon = key === "scale" ? 0.001 : 0.05
        if (Math.abs(target[key] - current[key]) > epsilon || Math.abs(velocity[key]) > epsilon) resting = false
      })
      return resting
    }

    const measure = () => {
      const s = settingsRef.current
      const target: Motion = { x: 0, y: 0, tiltX: 0, tiltY: 0, scale: 1 }
      if (s.disabled || !field.pointer) return { target, engaged: false }
      if (s.exclusive && field.owner !== entry) return { target, engaged: false }
      const rect = wrapper.getBoundingClientRect()
      const { dx, dy, outside } = reach(rect, field.pointer)
      if (outside > s.padding) return { target, engaged: false }
      const pull = s.padding > 0 ? 1 - smoothstep(s.padding * 0.5, s.padding, outside) : 1
      let x = s.axis === "y" ? 0 : (dx / s.strength) * pull
      let y = s.axis === "x" ? 0 : (dy / s.strength) * pull
      const length = Math.hypot(x, y)
      if (length > s.maxOffset) {
        x *= s.maxOffset / length
        y *= s.maxOffset / length
      }
      const nx = clamp(dx / Math.max(rect.width / 2, 1), -1, 1)
      const ny = clamp(dy / Math.max(rect.height / 2, 1), -1, 1)
      target.x = x
      target.y = y
      target.tiltX = -ny * s.tilt * pull
      target.tiltY = nx * s.tilt * pull
      target.scale = 1 + (s.scale - 1) * pull
      return { target, engaged: true }
    }

    const apply = () => {
      const { x, y, tiltX, tiltY, scale: liveScale } = current
      const turned = Math.abs(tiltX) > 0.01 || Math.abs(tiltY) > 0.01
      inner.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)${
        turned ? ` perspective(800px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg)` : ""
      }${Math.abs(liveScale - 1) > 0.0005 ? ` scale(${liveScale.toFixed(4)})` : ""}`
    }

    const frame = (now: number) => {
      raf = 0
      const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60
      last = now
      const { target, engaged } = measure()
      if (engaged !== active) {
        active = engaged
        entry.active = engaged
        if (engaged) wrapper.setAttribute("data-magnet-active", "")
        else wrapper.removeAttribute("data-magnet-active")
        settingsRef.current.onActiveChange?.(engaged)
      }
      const steps = Math.ceil(dt / (1 / 120))
      let resting = true
      for (let i = 0; i < steps; i++) resting = solve(target, dt / steps)
      if (resting) {
        ;(Object.keys(current) as (keyof Motion)[]).forEach(key => {
          current[key] = target[key]
          velocity[key] = 0
        })
      }
      apply()
      if (!resting) raf = requestAnimationFrame(frame)
      else last = 0
    }

    function wake() {
      if (!raf) raf = requestAnimationFrame(frame)
    }

    const entry: Entry = { wrapper, settings: settingsRef, wake, active: false }
    registry.add(entry)
    if (!detach) detach = attach()
    inner.style.willChange = "transform"
    wakeRef.current = () => {
      arbitrate()
      wake()
    }

    const teardown = () => {
      cancelAnimationFrame(raf)
      wakeRef.current = null
      inner.style.willChange = ""
      registry.delete(entry)
      if (field.owner === entry) field.owner = null
      if (!registry.size && detach) {
        detach()
        detach = null
      }
    }

    const onMotionChange = (event: MediaQueryListEvent) => {
      if (event.matches) teardown()
    }
    motionQuery.addEventListener("change", onMotionChange)

    return () => {
      motionQuery.removeEventListener("change", onMotionChange)
      teardown()
    }
  }, [])

  useEffect(() => {
    wakeRef.current?.()
  })

  return (
    <div
      ref={wrapperRef}
      className={cn(wrapperClassName) || undefined}
      style={{ position: "relative", display: "inline-block", ...style }}
      {...props}
    >
      <div ref={innerRef} className={cn(innerClassName) || undefined}>
        {children}
      </div>
    </div>
  )
}
