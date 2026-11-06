"use client"

/*
 * The invitation step of `/login`. This posts to the backend's own
 * `POST /auth/invitation` (src/app/auth/invitation/route.ts:88) instead of a frontend server
 * action, because that route is the single place the attempt bucket, the real client IP, the
 * session cookie and the open-redirect guard live. Duplicating those writes in an action would
 * have created a second, weaker path to the same state.
 *
 * Progressive enhancement: without JavaScript the browser posts the form and the route answers
 * 303 to /overview; with it we ask for JSON and render the `ActionError` envelope inline.
 */

import { useState } from "react"
import type { FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { TextField } from "@/components/ui/field"

type FieldState = {
  status: "idle" | "pending" | "error"
  message?: string
  code?: string
  fieldError?: string
  usernameError?: string
  retryAfter?: string
}

const IDLE: FieldState = { status: "idle" }

export function InvitationForm() {
  const [state, setState] = useState<FieldState>(IDLE)

  async function submit(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget
    const data = new FormData(form)
    const code = data.get("code")
    const username = data.get("username")

    if (typeof fetch !== "function") return // no JS: the browser posts and follows the 303

    event.preventDefault()
    setState({ status: "pending" })

    try {
      const response = await fetch("/auth/invitation", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ code: typeof code === "string" ? code : "", username: typeof username === "string" ? username : "" }),
      })

      const body: unknown = await response.json().catch(() => null)
      const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {}

      if (response.ok && typeof record.redirect === "string") {
        window.location.assign(record.redirect)
        return
      }

      const error =
        record.error !== null && typeof record.error === "object"
          ? (record.error as Record<string, unknown>)
          : undefined
      const fields =
        error !== undefined && error.fields !== null && typeof error.fields === "object"
          ? (error.fields as Record<string, unknown>)
          : undefined

      setState({
        status: "error",
        code: typeof error?.code === "string" ? error.code : "request_failed",
        message:
          typeof error?.message === "string"
            ? error.message
            : `The invitation step failed (HTTP ${response.status}). Try again.`,
        fieldError: typeof fields?.code === "string" ? fields.code : undefined,
        usernameError: typeof fields?.username === "string" ? fields.username : undefined,
        retryAfter:
          typeof fields?.retry_after === "string" ? fields.retry_after : undefined,
      })
    } catch {
      setState({
        status: "error",
        code: "network",
        message: "Could not reach the invitation endpoint. Check your connection and try again.",
      })
    } finally {
      setState((current) => (current.status === "pending" ? IDLE : current))
    }
  }

  return (
    <form action="/auth/invitation" method="post" onSubmit={submit} className="flex flex-col gap-4">
      <TextField
        label="Username"
        name="username"
        required
        minLength={3}
        maxLength={30}
        pattern="[A-Za-z0-9_]+"
        autoComplete="username"
        spellCheck={false}
        placeholder="your_name"
        hint="3 to 30 letters, numbers or underscores."
        error={state.usernameError}
        disabled={state.status === "pending"}
      />
      <TextField
        label="Invitation code"
        name="code"
        required
        autoComplete="one-time-code"
        spellCheck={false}
        placeholder="ZABER-XXXX-XXXX"
        hint="Given to you by someone with permission to invite. Codes are case-insensitive."
        error={state.fieldError}
        disabled={state.status === "pending"}
        className="font-mono"
      />

      {state.status === "error" && state.message ? (
        <p role="alert" className="text-[13px] leading-[1.6] text-paper">
          ⚠ {state.message}
          {state.retryAfter
            ? ` Retry in about ${Math.ceil(Number(state.retryAfter) / 60) || 1} minute(s).`
            : ""}
          {state.code ? (
            <span className="ml-2 font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
              {state.code}
            </span>
          ) : null}
        </p>
      ) : null}

      <Button type="submit" variant="solid" loading={state.status === "pending"}>
        {state.status === "pending" ? "Checking invitation…" : "Enter with invitation"}
      </Button>
    </form>
  )
}
