"use client"

import { useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy"
import { cn } from "@/lib/cn"
import { buildCurl, buildJavaScript, buildPython, validateSnippetRequest } from "@/lib/snippets"
import type { SnippetRequest } from "@/lib/snippets"

const LANGUAGES = [
  { id: "curl", label: "cURL", build: buildCurl },
  { id: "javascript", label: "JavaScript", build: buildJavaScript },
  { id: "python", label: "Python", build: buildPython },
] as const

/**
 * Request examples for one call. The snippets come from `src/lib/snippets`, the same builders
 * the public engine's tests pin, so the UI can never drift from the documented behaviour.
 */
export function SnippetTabs({ request, className }: { request: SnippetRequest; className?: string }) {
  const [active, setActive] = useState<(typeof LANGUAGES)[number]["id"]>("curl")
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([])

  const issues = useMemo(() => validateSnippetRequest(request), [request])
  const selected = LANGUAGES.find((language) => language.id === active) ?? LANGUAGES[0]
  const code = issues.length > 0 ? "" : selected.build(request)

  const focusTab = (index: number) => {
    const next = (index + LANGUAGES.length) % LANGUAGES.length
    setActive(LANGUAGES[next].id)
    tabsRef.current[next]?.focus()
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div role="tablist" aria-label="Request examples" className="flex flex-wrap gap-1">
        {LANGUAGES.map((language, index) => {
          const isSelected = language.id === active
          return (
            <button
              key={language.id}
              ref={(node) => {
                tabsRef.current[index] = node
              }}
              role="tab"
              type="button"
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => setActive(language.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") focusTab(index + 1)
                if (event.key === "ArrowLeft") focusTab(index - 1)
                if (event.key === "Home") focusTab(0)
                if (event.key === "End") focusTab(LANGUAGES.length - 1)
              }}
              className={cn(
                "folio min-h-10 rounded-field px-3 py-2 transition-colors",
                isSelected ? "border border-paper text-paper" : "border border-rule text-dust hover:border-edge hover:text-mist"
              )}
            >
              {language.label}
            </button>
          )
        })}
      </div>

      {issues.length > 0 ? (
        <ul role="alert" className="flex flex-col gap-1 border-l-2 border-danger pl-3 text-[13px] text-danger">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="folio">{selected.label}</span>
            <CopyButton value={code} />
          </div>
          <pre tabIndex={0} role="tabpanel" aria-label={`${selected.label} example`} className="codeblock">
            {code}
          </pre>
        </div>
      )}
    </div>
  )
}

/** Same tabs, but for a caller that already has the finished strings (e.g. a static docs page). */
export function CodeTabs({
  examples,
  label,
  className,
}: {
  examples: Array<{ id: string; label: string; code: string }>
  label?: string
  className?: string
}) {
  const [active, setActive] = useState(examples[0]?.id ?? "")
  const selected = examples.find((example) => example.id === active) ?? examples[0]

  if (!selected) return null

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div role="tablist" aria-label={label ?? "Code examples"} className="flex flex-wrap gap-1">
        {examples.map((example) => {
          const isSelected = example.id === selected.id
          return (
            <Button
              key={example.id}
              type="button"
              size="sm"
              variant={isSelected ? "solid" : "ghost"}
              aria-selected={isSelected}
              role="tab"
              onClick={() => setActive(example.id)}
            >
              {example.label}
            </Button>
          )
        })}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="folio">{selected.label}</span>
          <CopyButton value={selected.code} />
        </div>
        <pre tabIndex={0} role="tabpanel" aria-label={selected.label} className="codeblock">
          {selected.code}
        </pre>
      </div>
    </div>
  )
}
