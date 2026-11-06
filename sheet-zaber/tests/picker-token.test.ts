import { describe, expect, it, vi } from "vitest"

import { aesGcmEncrypt } from "@/lib/crypto"
import { env } from "@/lib/env"
import { DRIVE_FILE_SCOPE, mintPickerToken } from "@/server/google/tokens"

const connection = { id: "c1", refreshTokenEnc: "" } as Parameters<typeof mintPickerToken>[0]

describe("mintPickerToken", () => {
  connection.refreshTokenEnc = aesGcmEncrypt("refresh-fixture", env.TOKEN_ENCRYPTION_KEY)

  it("asks Google for a drive.file-only token, never the Sheets scope", async () => {
    const post = vi.fn(async (body: URLSearchParams) => ({ ok: body.has("scope"), json: async () => ({ access_token: "narrow" }) }))
    expect(await mintPickerToken(connection, post)).toBe("narrow")
    const body = post.mock.calls[0][0]
    expect(body.get("scope")).toBe(DRIVE_FILE_SCOPE)
    expect(body.get("scope")).not.toContain("spreadsheets")
    expect(body.get("refresh_token")).toBe("refresh-fixture")
  })

  it("answers null when Google refuses, rather than falling back to a broader token", async () => {
    const post = vi.fn(async () => ({ ok: false, json: async () => ({ error: "invalid_scope" }) }))
    expect(await mintPickerToken(connection, post)).toBeNull()
  })
})
