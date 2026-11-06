"use client"

/** Adapted from React Bits "ShinyText" (https://reactbits.dev/r/ShinyText-TS-TW.json). Colour props now default to Black Press tokens (`var(--mist)` base, `var(--press)` shine, resolved through a var-aware parser so contrast never drops below the base 10:1); the endless `loop` default became one `hover` sweep per pointer entry; sweep duration falls back to the app's `--dur-slow` and the default easing is `--ease-press`'s cubic bezier instead of the source's 2s/smooth; the source's `glow` blurred duplicate layer was dropped (house rule: no glow) and the structural arbitrary-variant classes moved to shiny-text.css; the rAF gradient/bands/pointer-follow engine itself is vendored verbatim. */

import { useEffect, useRef } from "react"
import type { CSSProperties, ReactNode } from "react"

import { cn } from "@/lib/cn"
import "./shiny-text.css"

type Easing = "press" | "smooth" | "linear" | "snappy"
type Trigger = "loop" | "hover" | "view"

export interface ShinyTextProps {
  text?: string
  children?: ReactNode
  /** Any CSS colour, including `var(--token)`. Default `var(--mist)`. */
  color?: string
  /** Any CSS colour, including `var(--token)`. Default `var(--press)`. */
  shineColor?: string
  /** Sweep seconds. When omitted the component reads `--dur-slow` from the theme. */
  speed?: number
  delay?: number
  angle?: number
  shineWidth?: number
  softness?: number
  bands?: number
  direction?: "left" | "right"
  easing?: Easing
  /** `loop` is opt-in; the default is a single sweep on pointer enter. */
  trigger?: Trigger
  yoyo?: boolean
  followPointer?: boolean
  pauseOnHover?: boolean
  disabled?: boolean
  className?: string
  style?: CSSProperties
}

interface Settings {
  color: string
  shineColor: string
  speed: number | null
  delay: number
  angle: number
  shineWidth: number
  softness: number
  bands: number
  sign: number
  ease: (t: number) => number
  trigger: Trigger
  yoyo: boolean
  followPointer: boolean
  pauseOnHover: boolean
  disabled: boolean
}

/** cubic-bezier(0.16, 1, 0.3, 1) — the app's `--ease-press`, sampled per frame. */
const cubicBezier = (x1: number, y1: number, x2: number, y2: number) => {
  const A = (a: number, b: number) => 1 - 3 * b + 3 * a
  const B = (a: number, b: number) => 3 * b - 6 * a
  const C = (a: number) => 3 * a
  const calc = (t: number, a: number, b: number) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t
  const slope = (t: number, a: number, b: number) => (3 * A(a, b) * t + 2 * B(a, b)) * t + C(a)
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = calc(t, x1, x2) - x
      if (Math.abs(err) < 1e-4) break
      const d = slope(t, x1, x2)
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    return calc(t, y1, y2)
  }
}

const EASINGS: Record<Easing, (t: number) => number> = {
  press: cubicBezier(0.16, 1, 0.3, 1),
  linear: (t) => t,
  smooth: (t) => 0.5 - Math.cos(Math.PI * t) / 2,
  snappy: (t) => (t < 0.5 ? 16 * Math.pow(t, 5) : 1 - Math.pow(-2 * t + 2, 5) / 2),
}
const TRIGGERS: Trigger[] = ["loop", "hover", "view"]
const FALLOFF = [0, 0.2, 0.4, 0.6, 0.8, 1]

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

let paint: CanvasRenderingContext2D | null = null

/** The source accepted literal CSS colours only; tokens like `var(--mist)` are resolved first. */
const VAR_RE = /^var\(\s*(--[\w-]+)\s*\)$/
const resolveColor = (value: string, el: HTMLElement): string => {
  const match = VAR_RE.exec(value)
  return match ? getComputedStyle(el).getPropertyValue(match[1]).trim() : value
}

const parseColor = (value: string): number[] | null => {
  if (typeof document === "undefined") return null
  if (!paint) paint = document.createElement("canvas").getContext("2d")
  if (!paint) return null
  paint.fillStyle = "#000000"
  paint.fillStyle = value
  const resolved = String(paint.fillStyle)
  if (resolved.startsWith("#")) {
    return [1, 3, 5].map((i) => parseInt(resolved.slice(i, i + 2), 16)).concat(1)
  }
  const parts = resolved.match(/[\d.]+/g)
  if (!parts || parts.length < 3) return null
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), parts.length > 3 ? Number(parts[3]) : 1]
}

const blend = (from: number[], to: number[], amount: number) => {
  const channel = (a: number, b: number) =>
    Math.round(Math.pow(Math.pow(a / 255, 2.2) * (1 - amount) + Math.pow(b / 255, 2.2) * amount, 1 / 2.2) * 255)
  const alpha = from[3] * (1 - amount) + to[3] * amount
  if (alpha <= 0) return "rgba(0, 0, 0, 0)"
  const weigh = (a: number, b: number) => (a * from[3] * (1 - amount) + b * to[3] * amount) / alpha
  const r = from[3] === to[3] ? channel(from[0], to[0]) : Math.round(weigh(from[0], to[0]))
  const g = from[3] === to[3] ? channel(from[1], to[1]) : Math.round(weigh(from[1], to[1]))
  const b = from[3] === to[3] ? channel(from[2], to[2]) : Math.round(weigh(from[2], to[2]))
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`
}

const ShinyText = ({
  text,
  children,
  color = "var(--mist)",
  shineColor = "var(--press)",
  speed,
  delay = 0,
  angle = 120,
  shineWidth = 40,
  softness = 0.8,
  bands = 1,
  direction = "left",
  easing = "press",
  trigger = "hover",
  yoyo = false,
  followPointer = false,
  pauseOnHover = false,
  disabled = false,
  className = "",
  style,
}: ShinyTextProps) => {
  const rootRef = useRef<HTMLSpanElement>(null)
  const syncRef = useRef<(() => void) | null>(null)
  const content = children ?? text

  const settings: Settings = {
    color,
    shineColor,
    speed: speed === undefined ? null : Math.max(0.1, speed),
    delay: Math.max(0, delay),
    angle,
    shineWidth: clamp(shineWidth, 2, 200),
    softness: clamp(softness, 0, 1),
    bands: clamp(Math.round(bands), 1, 3),
    sign: direction === "right" ? 1 : -1,
    ease: EASINGS[easing as Easing] ?? EASINGS.press,
    trigger: TRIGGERS.includes(trigger as Trigger) ? (trigger as Trigger) : "hover",
    yoyo,
    followPointer,
    pauseOnHover,
    disabled,
  }
  // A post-commit sync rather than a render-time write (`react-hooks/refs`). Every reader is a rAF
  // callback or a listener registered by the mount effect below, and this effect is declared first,
  // so the first frame already sees the current values.
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  })

  useEffect(() => {
    syncRef.current?.()
  })

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    const state = {
      pos: null as number | null,
      vel: 0,
      phase: "idle",
      from: 0,
      to: 0,
      start: 0,
      duration: 1,
      resume: 0,
      flip: false,
      inside: false,
      target: 0,
      visible: true,
      seen: false,
      colors: "",
    }
    let base: number[] | null = null
    let shine: number[] | null = null
    let raf = 0
    let timer = 0
    let last = 0
    let alive = true
    let cachedSpeed = 0

    /** Sweep pacing defaults to the app's `--dur-slow` token instead of a hard-coded number. */
    const tokenSeconds = () => {
      if (cachedSpeed > 0) return cachedSpeed
      const raw = getComputedStyle(root).getPropertyValue("--dur-slow").trim()
      const num = Number.parseFloat(raw)
      cachedSpeed = Math.max(0.1, Number.isFinite(num) && num > 0 ? (raw.includes("ms") ? num / 1000 : num) : 0.9)
      return cachedSpeed
    }

    const extent = () => {
      const s = settingsRef.current!
      return s.shineWidth / 2 + (s.bands - 1) * s.shineWidth * 1.3 + 2
    }
    const entry = () => (settingsRef.current!.sign > 0 ? -extent() : 100 + extent())
    const exit = () => (settingsRef.current!.sign > 0 ? 100 + extent() : -extent())
    const nearest = () => (state.target < 50 ? -extent() : 100 + extent())

    const gradient = (pos: number, fill: number[]) => {
      const s = settingsRef.current!
      const half = s.shineWidth / 2
      const core = half * (1 - s.softness)
      const fade = half - core
      const stops: [number, number][] = []
      for (let band = 0; band < s.bands; band++) {
        const center = pos - s.sign * band * s.shineWidth * 1.3
        const strength = 1 - band * 0.28
        for (const side of [-1, 1]) {
          for (const f of FALLOFF) {
            const at = center + side * (core + fade * (1 - f))
            const amount = f * f * (3 - 2 * f) * strength
            stops.push([at, amount])
          }
        }
      }
      stops.sort((a, b) => a[0] - b[0])
      const list = stops.map(([at, amount]) => `${blend(fill, shine!, amount)} ${at.toFixed(2)}%`)
      return `linear-gradient(${s.angle}deg, ${blend(fill, shine!, 0)} 0%, ${list.join(", ")}, ${blend(fill, shine!, 0)} 100%)`
    }

    const draw = () => {
      const s = settingsRef.current!
      const key = `${s.color}|${s.shineColor}`
      if (key !== state.colors) {
        state.colors = key
        base = parseColor(resolveColor(s.color, root))
        shine = parseColor(resolveColor(s.shineColor, root))
      }
      if (!base || !shine) {
        root.style.backgroundImage = `linear-gradient(${s.color}, ${s.color})`
        return
      }
      if (state.pos === null || s.disabled) {
        root.style.backgroundImage = `linear-gradient(${s.color}, ${s.color})`
        return
      }
      root.style.backgroundImage = gradient(state.pos, base!)
    }

    const sweep = (from: number, to: number, now: number) => {
      const s = settingsRef.current!
      const span = Math.abs(exit() - entry()) || 1
      state.phase = "sweep"
      state.from = from
      state.to = to
      state.start = now
      state.duration = (s.speed ?? tokenSeconds()) * 1000 * Math.max(0.15, Math.abs(to - from) / span)
    }

    const wake = () => {
      if (raf || !alive) return
      window.clearTimeout(timer)
      timer = 0
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }

    const tick = (now: number) => {
      raf = 0
      if (!alive) return
      const s = settingsRef.current!
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
      last = now
      if (s.disabled) {
        state.pos = null
        state.phase = "idle"
        draw()
        return
      }
      const following = s.followPointer && state.inside
      if (following) {
        if (state.pos === null) state.pos = nearest()
        const stiffness = 220
        state.vel += ((state.target - state.pos) * stiffness - state.vel * 2 * Math.sqrt(stiffness)) * dt
        state.pos += state.vel * dt
        state.phase = "follow"
        draw()
        raf = requestAnimationFrame(tick)
        return
      }
      if (state.phase === "follow") {
        state.vel = 0
        sweep(state.pos ?? nearest(), nearest(), now)
      }
      if (state.phase === "sweep") {
        if (s.pauseOnHover && state.inside) {
          state.start += dt * 1000
          raf = requestAnimationFrame(tick)
          return
        }
        const t = clamp((now - state.start) / state.duration, 0, 1)
        state.pos = state.from + (state.to - state.from) * s.ease(t)
        draw()
        if (t < 1) {
          raf = requestAnimationFrame(tick)
          return
        }
        if (s.trigger !== "loop" || reduce) {
          state.phase = "idle"
          state.pos = null
          draw()
          return
        }
        state.phase = "wait"
        state.resume = now + s.delay * 1000
      }
      if (state.phase === "wait") {
        if (!state.visible) return
        if (now < state.resume) {
          window.clearTimeout(timer)
          timer = window.setTimeout(wake, state.resume - now)
          return
        }
        if (s.yoyo) {
          state.flip = !state.flip
          sweep(state.flip ? exit() : entry(), state.flip ? entry() : exit(), now)
        } else {
          sweep(entry(), exit(), now)
        }
        raf = requestAnimationFrame(tick)
        return
      }
      if (state.phase === "idle" && s.trigger === "loop" && !reduce && state.visible) {
        state.flip = false
        sweep(entry(), exit(), now)
        raf = requestAnimationFrame(tick)
      }
    }

    const locate = (event: PointerEvent) => {
      const s = settingsRef.current!
      const rect = root.getBoundingClientRect()
      const radians = (s.angle * Math.PI) / 180
      const dx = Math.sin(radians)
      const dy = -Math.cos(radians)
      const length = Math.abs(rect.width * dx) + Math.abs(rect.height * dy) || 1
      const along =
        (event.clientX - rect.left - rect.width / 2) * dx + (event.clientY - rect.top - rect.height / 2) * dy
      return 50 + (along / length) * 100
    }

    const onEnter = (event: PointerEvent) => {
      const s = settingsRef.current!
      state.inside = true
      state.target = locate(event)
      if (s.disabled) return
      if (s.followPointer) {
        if (state.pos === null) state.pos = nearest()
      } else if (s.trigger === "hover" && state.phase === "idle" && !reduce) {
        sweep(entry(), exit(), performance.now())
      }
      wake()
    }
    const onMove = (event: PointerEvent) => {
      state.target = locate(event)
      if (settingsRef.current!.followPointer) wake()
    }
    const onLeave = () => {
      state.inside = false
      wake()
    }

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((item) => item.isIntersecting)
      state.visible = visible
      const s = settingsRef.current!
      if (!visible) return
      if (s.trigger === "view" && !state.seen && !reduce && !s.disabled) {
        state.seen = true
        sweep(entry(), exit(), performance.now())
      }
      wake()
    })
    observer.observe(root)

    root.addEventListener("pointerenter", onEnter)
    root.addEventListener("pointermove", onMove)
    root.addEventListener("pointerleave", onLeave)

    syncRef.current = () => {
      const s = settingsRef.current!
      if (s.disabled) {
        state.pos = null
        state.phase = "idle"
      } else if (s.trigger !== "loop" && state.phase === "wait") {
        state.phase = "idle"
        state.pos = null
      }
      draw()
      wake()
    }
    draw()
    wake()

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      observer.disconnect()
      root.removeEventListener("pointerenter", onEnter)
      root.removeEventListener("pointermove", onMove)
      root.removeEventListener("pointerleave", onLeave)
      syncRef.current = null
    }
  }, [])

  return (
    <span
      ref={rootRef}
      className={cn("fx-shiny", className)}
      style={{ backgroundImage: `linear-gradient(${color}, ${color})`, ...style }}
    >
      {content}
    </span>
  )
}

export { ShinyText }
export default ShinyText
