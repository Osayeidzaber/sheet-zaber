"use client"

import { ErrorScreen } from "@/components/app/error-screen"

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} homeHref="/overview" />
}
