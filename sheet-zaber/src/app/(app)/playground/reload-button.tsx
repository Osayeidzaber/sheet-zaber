"use client"

import { Button } from "@/components/ui/button"

/**
 * A real reload affordance for a read that failed above it. `window.location.reload()` is the whole
 * action — the page re-runs its server reads, which is exactly what a stale list needs. No fake
 * "retry" that only clears local state, and no client router refresh that would replay the same
 * cached props.
 */
export function ReloadButton({ label = "Reload the page" }: { label?: string }) {
  return (
    <Button variant="line" size="sm" onClick={() => window.location.reload()}>
      {label}
    </Button>
  )
}
