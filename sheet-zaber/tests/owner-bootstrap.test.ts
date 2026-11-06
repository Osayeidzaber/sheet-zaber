import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { TEST_DB_URL_KEY, getTestDb, getTestDbUrl, migrateTestDb, startTestDb, stopTestDb, truncateAll } from "./helpers/db"

let bootstrapOwner: typeof import("@/server/auth/owner-bootstrap").bootstrapOwner
let users: typeof import("@/server/db/queries/users")

describe("owner bootstrap", () => {
  beforeAll(async () => {
    let url: string
    try {
      url = inject(TEST_DB_URL_KEY)
    } catch {
      await startTestDb()
      await migrateTestDb()
      url = getTestDbUrl()
    }
    process.env.DATABASE_URL = url
    await getTestDb()
    bootstrapOwner = (await import("@/server/auth/owner-bootstrap")).bootstrapOwner
    users = await import("@/server/db/queries/users")
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  it("creates the first owner for OWNER_EMAIL, ignoring case", async () => {
    const row = await bootstrapOwner({ sub: "a", email: "OWNER@example.com" })
    expect(row?.role).toBe("owner")
  })

  it("refuses any other email on an empty instance", async () => {
    expect(await bootstrapOwner({ sub: "a", email: "someone@example.com" })).toBeNull()
    expect(await users.findUserByGoogleSub("a")).toBeUndefined()
  })

  it("closes once an owner exists, even a different Google account with that email", async () => {
    expect(await bootstrapOwner({ sub: "a", email: "owner@example.com" })).not.toBeNull()
    expect(await bootstrapOwner({ sub: "b", email: "owner@example.com" })).toBeNull()
  })
})
