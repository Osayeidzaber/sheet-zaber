import { PillLink } from "@/components/ui/button"
import { Panel, PanelHeader, Row } from "@/components/ui/panel"
import { cn } from "@/lib/cn"

export type SetupStep = { title: string; body: string; done: boolean; href: string; action: string }

/** First-run path, derived from what the account really holds. Hidden once every step is done. */
export function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const finished = steps.filter((step) => step.done).length
  if (finished === steps.length) return null
  const next = steps.findIndex((step) => !step.done)

  return (
    <Panel as="section">
      <PanelHeader
        title="Publish your first endpoint"
        description={`${finished} of ${steps.length} steps done.`}
      />
      <ol>
        {steps.map((step, index) => (
          <Row key={step.title} as="li">
            <span
              aria-hidden="true"
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-full border font-mono text-[12px]",
                step.done ? "border-paper bg-paper text-ink" : "border-edge text-mist"
              )}
            >
              {step.done ? "✓" : String(index + 1).padStart(2, "0")}
            </span>
            <div className="min-w-[200px] flex-1">
              <p className={cn("text-[15px] font-semibold", step.done && "text-dust")}>
                {step.title}
                {step.done ? <span className="sr-only"> (done)</span> : null}
              </p>
              <p className="mt-1 text-[13px] leading-[1.6] text-dust">{step.body}</p>
            </div>
            {step.done ? null : (
              <PillLink href={step.href} variant={index === next ? "solid" : "line"} size="sm">
                {step.action}
              </PillLink>
            )}
          </Row>
        ))}
      </ol>
    </Panel>
  )
}
