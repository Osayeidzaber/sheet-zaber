"use client"

import Link from "next/link"
import type { ButtonHTMLAttributes, ComponentProps } from "react"

import { cn } from "@/lib/cn"

import { pillClass, type PillSize, type PillVariant } from "./pill"

export { pillClass, type PillSize, type PillVariant }

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: PillVariant
  size?: PillSize
  loading?: boolean
}

export function Button({
  variant = "line",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(pillClass(variant, size, className), loading && "cursor-progress")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  )
}

type PillLinkProps = Pick<ComponentProps<typeof Link>, "prefetch" | "target" | "rel"> & {
  href: string
  variant?: PillVariant
  size?: PillSize
  className?: string
  children: React.ReactNode
}

export function PillLink({
  href,
  variant = "line",
  size = "md",
  className,
  children,
  ...rest
}: PillLinkProps) {
  return (
    <Link href={href} className={pillClass(variant, size, className)} {...rest}>
      {children}
    </Link>
  )
}

/** Inversion is the accent in this system, so the spinner is a hairline ring. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 animate-spin rounded-full border border-edge border-t-paper",
        className
      )}
    />
  )
}
