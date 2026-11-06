import "server-only"

import { env } from "@/lib/env"
import type { EmailMessage } from "./client"

/*
 * The invitation message. The plaintext code appears HERE and in the email body it produces —
 * those are the two sanctioned places (`backend-api-contract.md` §4.5); nothing that leaves this
 * builder may be logged, audited or echoed into an error.
 *
 * Deep-link decision (`src/app/login/page.tsx` is frontend-owned, read-only here): `/login`
 * parses only `error` and `step` from its search params — `code` is not one of them — so a
 * `?code=…` link would silently drop the code. Until the frontend prefills it, the email links to
 * the bare `/login` and gives the code as separately-copyable text, with the one instruction that
 * matches the real flow (`docs/authentication-flow.md` §1): sign in with Google first, then paste
 * the code on the step that follows.
 *
 * Copy is deliberately quiet about data handling and says nothing the schema does not do: only
 * the SHA-256 hash is stored, there are no passwords, nothing is created unless the invitee signs
 * in. No external assets, no tracking pixels, inline styles only.
 */

export type InvitationEmailInput = {
  /** the normalized address the invitation is going to */
  to: string
  /** the plaintext code — rendered once, in the body, and nowhere else */
  code: string
  expiresAt: Date | null
  /** How many accounts the code admits; the copy must not promise single use otherwise. */
  maxUses?: number
}

/** The site's sign-in page, without a query: the login route has no prefilled-code UX (see above). */
export function invitationSignInUrl(): string {
  return `${env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "")}/login`
}

/** Deterministic and copy-testable: `2026-12-01 08:30 UTC`. */
export function formatInvitationExpiry(expiresAt: Date): string {
  return `${expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function buildInvitationEmail(input: InvitationEmailInput): EmailMessage {
  const url = invitationSignInUrl()
  const expiry = input.expiresAt ? formatInvitationExpiry(input.expiresAt) : null
  const subject = "Your Sheet Zaber invitation code"
  const maxUses = input.maxUses ?? 1
  const usage = maxUses === 1 ? "works exactly once" : `can be used ${maxUses} times`

  const text = [
    "You are invited to Sheet Zaber — a private, invitation-only platform that turns one",
    "tab of one Google Sheet you own into one REST endpoint.",
    "",
    "To claim your account:",
    "",
    `  1. Open ${url} and sign in with Google.`,
    "  2. When the site asks for an invitation code, paste the code below.",
    "",
    "Invitation code (copy it on its own — do not click into it):",
    "",
    `  ${input.code}`,
    "",
    expiry
      ? `This code ${usage} and expires on ${expiry}.`
      : `This code ${usage}.`,
    "",
    "Notes:",
    "- Only the SHA-256 hash of the code is stored — never the code itself.",
    "- There are no passwords here: Google is the only credential.",
    "- If you were not expecting this invitation, ignore it; nothing is created until you",
    "  sign in with Google and redeem the code.",
    "",
  ].join("\n")

  const codeBoxStyle = [
    "margin:20px 0",
    "padding:14px 16px",
    "border:1px solid #c9c9c9",
    "border-radius:8px",
    "background:#f6f6f6",
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    "font-size:18px",
    "letter-spacing:1px",
    "text-align:center",
    "word-break:break-all",
  ].join(";")

  const html = [
    `<div style="max-width:560px;margin:0 auto;padding:24px;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1b1b1b">`,
    `<h1 style="font-size:20px;margin:0 0 14px">You are invited to Sheet Zaber</h1>`,
    `<p style="margin:0 0 14px">Sheet Zaber is a private, invitation-only platform that turns one tab of one Google Sheet you own into one REST endpoint. There is no public sign-up.</p>`,
    `<p style="margin:0 0 8px"><strong>To claim your account:</strong></p>`,
    `<ol style="margin:0 0 16px;padding-left:22px">`,
    `<li>Open <a href="${escapeHtml(url)}" style="color:#0b57d0">${escapeHtml(url)}</a> and sign in with Google.</li>`,
    `<li>When the site asks for an invitation code, paste the code below.</li>`,
    `</ol>`,
    `<p style="margin:0">Invitation code (copy it on its own):</p>`,
    `<div style="${codeBoxStyle}">${escapeHtml(input.code)}</div>`,
    `<p style="margin:0 0 16px">${
      expiry
        ? `This code ${usage} and expires on <strong>${escapeHtml(expiry)}</strong>.`
        : `This code ${usage}.`
    }</p>`,
    `<p style="margin:0 0 6px;color:#5a5a5a;font-size:13px">Only the SHA-256 hash of the code is stored — never the code itself. There are no passwords here: Google is the only credential.</p>`,
    `<p style="margin:0;color:#5a5a5a;font-size:13px">If you were not expecting this invitation, ignore it; nothing is created until you sign in with Google and redeem the code.</p>`,
    `</div>`,
  ].join("\n")

  return { to: input.to, subject, text, html }
}
