import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

/*
 * Contract-documentation tests (docs/backend-api-contract.md §3 docs contract).
 *
 * These fail loudly when a shared doc is renamed, when an error code documented for the
 * public engine disappears, or when the authentication/Google material drifts back into
 * architecture.md — all of which would break frontend integration silently.
 */

const docPath = (name: string) => fileURLToPath(new URL(`../docs/${name}`, import.meta.url))
const doc = (name: string) => readFile(docPath(name), "utf8")

const REQUIRED_ENVELOPE_CODES = [
  "validation_failed",
  "invalid_range",
  "invalid_json",
  "missing_key",
  "invalid_key",
  "key_scope_insufficient",
  "key_restricted",
  "api_disabled",
  "operation_not_allowed",
  "write_requires_primary_key",
  "api_not_found",
  "record_not_found",
  "ambiguous_record",
  "body_too_large",
  "google_sheet_inaccessible",
  "tab_not_found",
  "header_mismatch",
  "rate_limited",
  "google_reauth_required",
  "google_quota_exceeded",
  "internal_error",
]

describe("contract docs", () => {
  it("documents every canonical error code", async () => {
    const spec = await doc("backend-api-contract.md")
    for (const code of REQUIRED_ENVELOPE_CODES) {
      expect(spec, `missing error code: ${code}`).toContain(`\`${code}\``)
    }
  })

  it("keeps the authentication flow in authentication-flow.md, not architecture.md", async () => {
    const auth = await doc("authentication-flow.md")
    const arch = await doc("architecture.md")
    for (const anchor of ["sz_pending", "__Host-sz_session", "prompt=consent", "OWNER_EMAIL"]) {
      expect(auth, `authentication-flow.md missing ${anchor}`).toContain(anchor)
    }
    expect(arch).toContain("authentication-flow.md")
    expect(arch).not.toContain("sz_pending")
  })

  it("documents the Google token lifecycle and the Picker verification boundary", async () => {
    const g = await doc("google-integration.md")
    for (const anchor of [
      "TOKEN_ENCRYPTION_KEY",
      "reauth_required",
      "spreadsheets.get",
      "deleteDimension",
      "Picker",
    ]) {
      expect(g, `google-integration.md missing ${anchor}`).toContain(anchor)
    }
  })

  it("publishes the backend-owned signatures the dashboard integrates against", async () => {
    const spec = await doc("backend-api-contract.md")
    for (const anchor of [
      "Internal contract surfaces",
      "requireUser",
      "requireOwner",
      "readUser",
      "can(",
      "signSession",
    ]) {
      expect(spec, `internal contract missing ${anchor}`).toContain(anchor)
    }
  })

  it("publishes the ownership table, version log and two-way request lists", async () => {
    const s = await doc("integration-status.md")
    for (const anchor of [
      "## Ownership",
      "## Contract version log",
      "## Frontend → backend requests",
      "## Backend → frontend requests",
      "## Measured vs asserted",
    ]) {
      expect(s, `integration-status.md missing section ${anchor}`).toContain(anchor)
    }
  })
})
