/** Adapted from React Bits "Noise" (https://reactbits.dev/r/Noise-TS-TW.json). The grain tile is regenerated as a static, desaturated SVG feTurbulence data URI in noise.css instead of a runtime canvas + `toBlob()`, the requestAnimationFrame loop is replaced by transform/opacity keyframes, `colored` / `dust` / `scratches` are dropped (hue + canvas machinery), grain is static by default with `fps` / `flicker` as opt-ins, and grain opacity is clamped to single-digit so body text keeps its contrast. */
import "./noise.css"

import { cn } from "@/lib/cn"

export type NoiseBlendMode = "normal" | "overlay" | "soft-light" | "multiply" | "screen" | "difference"

export type NoiseProps = {
  /** Layer opacity. Clamped to MAX_GRAIN_OPACITY so body text keeps its contrast. */
  opacity?: number
  /** Tile scale multiplier (rendered size = 256px * size). */
  size?: number
  /** Frames per second for the grain jitter. 0 (default) keeps the grain static. */
  fps?: number
  blendMode?: NoiseBlendMode
  /** 0-1 grain spread; the source's own 0.5 + contrast * 1.1 formula, now a CSS contrast. */
  contrast?: number
  /** 0-1 opacity of the static scanline plate. 0 (default) renders nothing. */
  scanlines?: number
  /** 0-1 depth of the opacity flicker. 0 (default) keeps the layer steady. */
  flicker?: number
  fixed?: boolean
  zIndex?: number
  className?: string
  style?: React.CSSProperties
}

const ROOT = "pointer-events-none absolute inset-0 overflow-hidden"
const FIXED = "pointer-events-none fixed inset-0 overflow-hidden"
const GRAIN = "bg-repeat [image-rendering:pixelated]"

const TILE = 256
/** House ceiling for the grain plate: the source allowed 0-1, print texture needs single digits. */
const MAX_GRAIN_OPACITY = 0.09
/** Keyframe stops in fx-noise-jitter, so duration = stops / fps renders at the asked rate. */
const JITTER_STOPS = 6
const BLENDS: NoiseBlendMode[] = ["normal", "overlay", "soft-light", "multiply", "screen", "difference"]

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * Decorative grain overlay. Place it inside a positioned container as the first child so it
 * sits behind the content; it is `pointer-events-none` and `aria-hidden` and never opts into
 * a stacking level of its own unless you pass `zIndex`.
 */
export function Noise({
  opacity = 0.05,
  size = 1,
  fps = 0,
  blendMode = "overlay",
  contrast = 0.6,
  scanlines = 0,
  flicker = 0,
  fixed = false,
  zIndex,
  className,
  style,
}: NoiseProps) {
  const grainOpacity = clamp(opacity, 0, MAX_GRAIN_OPACITY)
  const rate = clamp(fps, 0, 60)
  const flickerDepth = clamp(flicker, 0, 1)
  const scanlineOpacity = clamp(scanlines, 0, 1)
  const blend: NoiseBlendMode = BLENDS.includes(blendMode) ? blendMode : "normal"
  const vars = {
    "--fx-noise-opacity": String(grainOpacity),
    "--fx-noise-tile": `${TILE * Math.max(0.5, size)}px`,
    "--fx-noise-contrast": (0.5 + clamp(contrast, 0, 1) * 1.1).toFixed(3),
    "--fx-noise-scanline-opacity": String(scanlineOpacity),
    "--fx-noise-flicker-depth": (1 - flickerDepth * 0.7).toFixed(3),
    ...(rate > 0 ? { "--fx-noise-duration": `${(JITTER_STOPS / rate).toFixed(4)}s` } : null),
  } as React.CSSProperties

  return (
    <div
      className={cn(
        fixed ? FIXED : ROOT,
        rate > 0 && "fx-noise--animated",
        flickerDepth > 0 && "fx-noise--flicker",
        className
      )}
      style={{ ...vars, zIndex, ...style }}
      aria-hidden="true"
    >
      <div className={cn(GRAIN, "fx-noise-grain")} style={{ mixBlendMode: blend }} />
      {scanlineOpacity > 0 ? <div className="fx-noise-scanlines" style={{ mixBlendMode: blend }} /> : null}
    </div>
  )
}
