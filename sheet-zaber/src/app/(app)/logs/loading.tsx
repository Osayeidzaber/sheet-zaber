import { PageSkeleton } from "@/components/ui/page-skeleton"

export default function Loading() {
  return <PageSkeleton label="Loading logs" stats={3} panels={[8]} />
}
