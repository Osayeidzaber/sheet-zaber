import { CopyButton } from "@/components/ui/copy"
import { cn } from "@/lib/cn"

/**
 * Static code plate. Real consumers: the `/docs` routes (directly and through
 * `src/components/docs/docs-page.tsx`), the landing page, `/settings`, the spreadsheet detail page
 * and the playground response viewer; `InlineCode` serves those plus the legal pages.
 */
export function CodeBlock({
  code,
  label,
  tone = "neutral",
  copyable = true,
  className,
}: {
  code: string
  label?: string
  tone?: "neutral" | "failed"
  copyable?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <div className="flex items-center justify-between gap-3">
          <span className="folio">{label}</span>
          {copyable ? <CopyButton value={code} /> : null}
        </div>
      ) : null}
      <pre
        tabIndex={0}
        className={cn(
          "codeblock",
          tone === "failed" && "text-danger"
        )}
      >
        {code}
      </pre>
    </div>
  )
}

export function InlineCode({ children }: { children: string }) {
  return <code className="inline">{children}</code>
}
