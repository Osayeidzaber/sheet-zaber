/* Pill styles. Not a client module, so server and client components can both call it. */
import { cn } from "@/lib/cn"

export type PillVariant = "solid" | "line" | "danger" | "ghost"
export type PillSize = "sm" | "md" | "lg"

const VARIANTS: Record<PillVariant, string> = {
  solid: "pill pill-solid",
  line: "pill pill-line",
  danger: "pill pill-danger",
  ghost:
    "inline-flex items-center justify-center gap-2 rounded-full text-dust transition-colors duration-(--dur-fast) hover:text-paper",
}

const SIZES: Record<PillSize, string> = {
  sm: "min-h-10 px-4 text-[14px]",
  md: "min-h-11 px-5 text-[15px]",
  lg: "min-h-14 px-7 text-[16px]",
}

export function pillClass(
  variant: PillVariant = "line",
  size: PillSize = "md",
  className?: string
): string {
  if (variant === "ghost") return cn(VARIANTS.ghost, "min-h-11 px-4", className)
  return cn(VARIANTS[variant], SIZES[size], className)
}
