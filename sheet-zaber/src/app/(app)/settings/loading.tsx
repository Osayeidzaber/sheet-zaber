import { PageSkeleton } from "@/components/ui/page-skeleton"

export default function Loading() {
  return <PageSkeleton label="Loading settings" panels={[3, 3]} />
}
