import { PageSkeleton } from "@/components/ui/page-skeleton"

export default function Loading() {
  return <PageSkeleton label="Loading users" panels={[6]} />
}
