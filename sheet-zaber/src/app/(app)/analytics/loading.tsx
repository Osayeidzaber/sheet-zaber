import { PageSkeleton } from "@/components/ui/page-skeleton"

export default function Loading() {
  return <PageSkeleton label="Loading analytics" stats={6} panels={[3, 4]} />
}
