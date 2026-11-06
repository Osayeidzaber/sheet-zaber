"use client"

import { Button, PillLink } from "@/components/ui/button"
import { Folio, Rings, TitleAside } from "@/components/ui/chapter"

/** What a route's error boundary shows. Only the opaque digest is printed, never the message. */
export function ErrorScreen({
  error,
  reset,
  homeHref,
}: {
  error: Error & { digest?: string }
  reset: () => void
  homeHref: string
}) {
  return (
    <section role="alert" className="relative overflow-hidden px-4 py-[clamp(56px,10vw,120px)] sm:px-6">
      <Rings at={["85%", "50%"]} sizes={[840, 560, 280]} />
      <div className="relative mx-auto flex max-w-[1180px] flex-col gap-6">
        <Folio aside={error.digest ? `Ref ${error.digest}` : undefined}>Error</Folio>
        <h1 className="display text-[clamp(40px,8vw,104px)] text-paper">
          This page <TitleAside>broke.</TitleAside>
        </h1>
        <p className="max-w-[56ch] text-[15px] leading-[1.7] text-mist">
          Something failed while loading it. Trying again is safe: loading a page changes nothing.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="solid" onClick={reset}>
            Try again
          </Button>
          <PillLink href={homeHref} variant="line">
            Go back
          </PillLink>
        </div>
      </div>
    </section>
  )
}
