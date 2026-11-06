import { PageSkeleton } from "@/components/ui/page-skeleton"

export default function Loading() {
  return <PageSkeleton label="Loading endpoints" stats={3} panels={[5]} />
}
