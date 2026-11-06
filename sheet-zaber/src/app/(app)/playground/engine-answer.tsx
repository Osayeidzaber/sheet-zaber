"use client"

import Link from "next/link"

import { Badge, MethodTag, StatusCode } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock } from "@/components/ui/code"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import type { PlaygroundRequest, PlaygroundResponse } from "@/lib/playground"
import { formatDuration, formatNumber } from "@/lib/format"
import { engineErrorCode, parseJsonBody, prettyJson, statusText } from "./path-shapes"

/*
 * The engine's answer, shown as the answer and nothing else (`backend-api-contract.md` §4.8).
 *
 * Rule 1 drives every line below: `status` is the engine's own number, so a 404/409/422/429 arrives
 * inside `data` on a playground call that SUCCEEDED. This panel labels that a completed request, never
 * a client error, and it never re-derives, re-orders or re-formats a byte: the body plate renders
 * `response.body` verbatim, and the parsed view is an addition underneath it with its own heading.
 *
 * `durationMs` is labelled for what it is — the engine's own measured duration (§4.8), i.e. the same
 * figure the request-log row carries — and the log link is the check on that claim.
 */

export type EngineAnswerProps = {
  response: PlaygroundResponse
  sent: PlaygroundRequest
  /** The public URL the same call would use, for the reference line. */
  baseUrl: string
  /** Log link target: `/logs?apiId=…`, a real filter this app reads (`logs/filter-params.ts:136`). */
  logsHref: string
  /** Offered when the refusal is about the key row, which this page's list may now be stale about. */
  onReload?: () => void
}

/** The path as it was sent, plus the query string the engine actually parsed. */
function requestLine(baseUrl: string, request: PlaygroundRequest): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item)
    } else {
      params.append(key, value)
    }
  }
  const query = params.toString()
  return `${baseUrl}/${request.path}${query === "" ? "" : `?${query}`}`
}

export function EngineAnswer({
  response,
  sent,
  baseUrl,
  logsHref,
  onReload,
}: EngineAnswerProps) {
  const refused = Math.floor(response.status / 100) >= 4
  const code = engineErrorCode(response.body)
  const parsed = parseJsonBody(response.body)
  const pretty = parsed === undefined ? null : prettyJson(parsed)
  const headerEntries = Object.entries(response.headers)

  return (
    <Panel as="section">
      <PanelHeader
        title="Engine response"
        description="Exactly what /api/v1 answered: status, headers and body, unaltered."
        action={
          <span className="flex flex-wrap items-center gap-2">
            <MethodTag method={sent.method} />
            <StatusCode code={response.status} />
            <span className="folio">{statusText(response.status)}</span>
          </span>
        }
      />
      <PanelBody className="flex flex-col gap-5">
        <p className="text-[13px] leading-[1.7] text-mist">
          {refused ? (
            <>
              <span className="text-paper">The request completed.</span> The engine chose to answer{" "}
              <span className="font-mono text-paper">{response.status}</span>. That is its response,
              not a playground failure — nothing here re-mapped it to 200, and nothing re-mapped it
              to 500.
            </>
          ) : (
            <>
              The engine answered{" "}
              <span className="font-mono text-paper">{response.status}</span> in{" "}
              <span className="num font-mono text-paper">{formatDuration(response.durationMs)}</span>.
            </>
          )}
        </p>

        {code === "invalid_key" || code === "missing_key" ? (
          <div className="flex flex-col items-start gap-3 border-l-2 border-warn bg-lift px-4 py-3">
            <p className="text-[13px] leading-[1.6] text-paper">
              The engine could not authenticate the key row you picked. It answers with identical 401
              bytes for a row that is not yours, a row that no longer exists, and a row revoked or
              lapsed since this page loaded — those cases are deliberately indistinguishable, so this page cannot tell you which one happened.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {onReload ? (
                <Button variant="line" size="sm" onClick={onReload}>
                  Reload the key list
                </Button>
              ) : null}
              <Link href="/keys" className="pill pill-line min-h-10 px-4 text-[14px]">
                Manage keys
              </Link>
            </div>
          </div>
        ) : null}

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="folio">Duration (engine-measured)</dt>
            <dd className="num font-mono text-[15px] text-paper">{response.durationMs} ms</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="folio">Body length</dt>
            <dd className="num font-mono text-[15px] text-paper">
              {formatNumber(response.body.length)} characters
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
            <dt className="folio">URL called</dt>
            <dd className="break-all font-mono text-[13px] text-mist">{requestLine(baseUrl, sent)}</dd>
          </div>
        </dl>

        <p className="text-[13px] leading-[1.7] text-dust">
          The duration is the engine&apos;s own figure, so it is the same number the request-log row
          for this call carries. Verify it in{" "}
          <Link href={logsHref} className="text-paper underline">
            the request log
          </Link>
          .
        </p>

        <div className="flex flex-col gap-2">
          <p className="folio">Response headers</p>
          {headerEntries.length === 0 ? (
            <p className="font-mono text-[13px] text-dust">
              the answer carried no headers besides content-type
            </p>
          ) : (
            <pre tabIndex={0} className="codeblock">
              {headerEntries.map(([key, value]) => `${key}: ${value}`).join("\n")}
            </pre>
          )}
          <p className="text-[13px] leading-[1.6] text-dust">
            <span className="font-mono">content-type</span> is absent by construction: the playground defines
            these headers as the engine&apos;s outcome minus <span className="font-mono">content-type</span>,
            which the playground route sets for its own envelope. The order below is the object&apos;s
            own — nothing is sorted, added or re-derived.
          </p>
        </div>

        {response.body === "" ? (
          <div className="flex flex-col gap-2">
            <p className="folio">Body (verbatim bytes)</p>
            <p className="text-[13px] leading-[1.6] text-dust">
              The engine returned no bytes. Nothing is shown as the body, and there is nothing to
              copy.
            </p>
          </div>
        ) : (
          <CodeBlock
            label="Body (verbatim bytes)"
            code={response.body}
            tone={refused ? "failed" : "neutral"}
          />
        )}

        {pretty !== null ? (
          <div className="flex flex-col gap-2 border-t border-rule pt-5">
            <CodeBlock label="Same body parsed as JSON (re-indented for reading only)" code={pretty} />
            <p className="text-[13px] leading-[1.6] text-dust">
              This second plate is an addition, never a replacement: the bytes the engine sent are the
              ones above; this one is what those bytes mean. It appears only because the body parsed.
            </p>
          </div>
        ) : null}

        {code !== null && refused ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-5">
            <Badge variant="failed">{code}</Badge>
            <p className="min-w-0 flex-1 text-[13px] leading-[1.6] text-dust">
              The engine&apos;s <span className="font-mono">error.code</span> for this answer, read out
              of the body it returned — the JSON envelope is what a real client would parse.
            </p>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  )
}
