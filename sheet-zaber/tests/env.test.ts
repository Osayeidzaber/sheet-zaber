import { describe, expect, it } from "vitest"

import { parseEnv } from "@/lib/env"

/**
 * All tests exercise `parseEnv` directly with fabricated inputs — no real
 * environment variables are ever needed.
 */
function validInput(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/sheet_zaber",
    SESSION_SECRET: "s".repeat(48),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    OWNER_EMAIL: "owner@example.com",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    NEXT_PUBLIC_SITE_URL: "http://localhost:3001",
    ...overrides,
  }
}

function errorFrom(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected parseEnv to throw, but it did not")
}

describe("parseEnv", () => {
  it("parses a fully valid input, freezes the result, and applies defaults", () => {
    const parsed = parseEnv(validInput())
    expect(parsed.LOG_RETENTION_DAYS).toBe(90)
    expect(parsed.OWNER_EMAIL).toBe("owner@example.com")
    expect(parsed.googleOAuthConfigured).toBe(true)
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it("accepts both postgres:// and postgresql:// schemes", () => {
    expect(() =>
      parseEnv(validInput({ DATABASE_URL: "postgres://user:pw@localhost:5433/db" }))
    ).not.toThrow()
    expect(() =>
      parseEnv(validInput({ DATABASE_URL: "postgresql://user:pw@localhost:5433/db" }))
    ).not.toThrow()
  })

  it("rejects a non-postgres DATABASE_URL", () => {
    const message = errorFrom(() =>
      parseEnv(validInput({ DATABASE_URL: "mysql://user:pw@localhost/db" }))
    )
    expect(message).toContain("DATABASE_URL")
  })

  it("names the missing variable when DATABASE_URL is absent", () => {
    const message = errorFrom(() => parseEnv(validInput({ DATABASE_URL: undefined })))
    expect(message).toContain("DATABASE_URL")
  })

  it("lists EVERY missing variable, not just the first", () => {
    const message = errorFrom(() =>
      parseEnv(
        validInput({
          DATABASE_URL: undefined,
          SESSION_SECRET: undefined,
          OWNER_EMAIL: undefined,
        })
      )
    )
    expect(message).toContain("DATABASE_URL")
    expect(message).toContain("SESSION_SECRET")
    expect(message).toContain("OWNER_EMAIL")
  })

  it("rejects a SESSION_SECRET shorter than 32 characters", () => {
    const message = errorFrom(() => parseEnv(validInput({ SESSION_SECRET: "s".repeat(31) })))
    expect(message).toContain("SESSION_SECRET")
  })

  it("accepts a SESSION_SECRET of exactly 32 characters", () => {
    expect(() => parseEnv(validInput({ SESSION_SECRET: "s".repeat(32) }))).not.toThrow()
  })

  it("rejects a TOKEN_ENCRYPTION_KEY that is not base64 of exactly 32 bytes", () => {
    const tooShort = errorFrom(() =>
      parseEnv(validInput({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(31, 7).toString("base64") }))
    )
    expect(tooShort).toContain("TOKEN_ENCRYPTION_KEY")

    const tooLong = errorFrom(() =>
      parseEnv(validInput({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(33, 7).toString("base64") }))
    )
    expect(tooLong).toContain("TOKEN_ENCRYPTION_KEY")

    const notBase64 = errorFrom(() =>
      parseEnv(validInput({ TOKEN_ENCRYPTION_KEY: "not base64 at all!!!" }))
    )
    expect(notBase64).toContain("TOKEN_ENCRYPTION_KEY")
  })

  it("accepts a TOKEN_ENCRYPTION_KEY that is base64 of exactly 32 bytes", () => {
    expect(() =>
      parseEnv(validInput({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64") }))
    ).not.toThrow()
  })

  it("defaults NEXT_PUBLIC_SITE_URL to http://localhost:3001 outside production", () => {
    const parsed = parseEnv(validInput({ NEXT_PUBLIC_SITE_URL: undefined }))
    expect(parsed.NEXT_PUBLIC_SITE_URL).toBe("http://localhost:3001")
  })

  it("parses dev input without GOOGLE_* and reports googleOAuthConfigured=false", () => {
    const parsed = parseEnv(
      validInput({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined })
    )
    expect(parsed.googleOAuthConfigured).toBe(false)
  })

  it("reports googleOAuthConfigured=false when only one GOOGLE_* var is set", () => {
    const parsed = parseEnv(validInput({ GOOGLE_CLIENT_SECRET: undefined }))
    expect(parsed.googleOAuthConfigured).toBe(false)
  })

  it("rejects production input without GOOGLE_* and names both variables", () => {
    const message = errorFrom(() =>
      parseEnv(
        validInput({
          NODE_ENV: "production",
          GOOGLE_CLIENT_ID: undefined,
          GOOGLE_CLIENT_SECRET: undefined,
        })
      )
    )
    expect(message).toContain("GOOGLE_CLIENT_ID")
    expect(message).toContain("GOOGLE_CLIENT_SECRET")
  })

  it("rejects production input without NEXT_PUBLIC_SITE_URL", () => {
    const message = errorFrom(() =>
      parseEnv(validInput({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: undefined }))
    )
    expect(message).toContain("NEXT_PUBLIC_SITE_URL")
  })

  it("coerces LOG_RETENTION_DAYS to an integer and rejects non-numeric values", () => {
    expect(parseEnv(validInput({ LOG_RETENTION_DAYS: "30" })).LOG_RETENTION_DAYS).toBe(30)
    const message = errorFrom(() => parseEnv(validInput({ LOG_RETENTION_DAYS: "soon" })))
    expect(message).toContain("LOG_RETENTION_DAYS")
  })
})
