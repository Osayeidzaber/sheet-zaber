"use client"

/*
 * Retry for a failed server read. `router.refresh()` re-requests the current route's Server
 * Components, which is the only honest way to re-run `listConnections` — a link back to
 * `/settings` while already on `/settings` would not re-read anything.
 */

import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"

export function RetryRead({ label = "Retry the read" }: { label?: string }) {
  const router = useRouter()
  return (
    <Button variant="line" size="sm" onClick={() => router.refresh()}>
      {label}
    </Button>
  )
}
