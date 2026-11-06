import { describe, expect, it } from "vitest"

import { GET } from "@/app/api/health/route"

describe("GET /api/health", () => {
  it("responds 200 with { ok: true }", async () => {
    const response = GET()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })
})
