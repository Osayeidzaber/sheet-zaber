import { describe, expect, it } from "vitest"

import { apiPublicId, generateShortId, shortIdFromPublicId } from "@/lib/api-public-id"

describe("short API addresses", () => {
  it("generates five lowercase letters or digits", () => {
    for (let i = 0; i < 200; i++) expect(generateShortId()).toMatch(/^[a-z0-9]{5}$/)
  })

  it("builds a readable URL segment from the name", () => {
    expect(apiPublicId("test123", "a1b2c")).toBe("test123-a1b2c")
    expect(apiPublicId("  My Orders / 2026! ", "a1b2c")).toBe("my-orders-2026-a1b2c")
    expect(apiPublicId("日本語", "a1b2c")).toBe("a1b2c")
    expect(apiPublicId("a".repeat(100), "a1b2c")).toBe(`${"a".repeat(40)}-a1b2c`)
  })

  it("reads the short id back, whatever the name part says", () => {
    expect(shortIdFromPublicId("test123-a1b2c")).toBe("a1b2c")
    expect(shortIdFromPublicId("renamed-api-a1b2c")).toBe("a1b2c")
    expect(shortIdFromPublicId("a1b2c")).toBe("a1b2c")
  })

  it("does not treat a uuid or a malformed segment as a short id", () => {
    expect(shortIdFromPublicId("346add77-125d-4818-b9f4-6f6d84bb4f86")).toBeNull()
    expect(shortIdFromPublicId("test123")).toBeNull()
    expect(shortIdFromPublicId("TEST-A1B2C")).toBeNull()
    expect(shortIdFromPublicId("")).toBeNull()
  })
})
