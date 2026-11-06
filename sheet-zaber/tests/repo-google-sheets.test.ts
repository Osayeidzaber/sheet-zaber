import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { apiConfigurations, googleConnections, registeredSpreadsheets } from "@/server/db/schema"
import type { SpreadsheetTab } from "@/server/db/queries/spreadsheets"

import {
  TEST_DB_URL_KEY,
  getTestDb,
  getTestDbUrl,
  migrateTestDb,
  startTestDb,
  stopTestDb,
  truncateAll,
  type TestDb,
} from "./helpers/db"

/*
 * Integration coverage for the Google connection and registered-spreadsheet repositories,
 * against the same ephemeral PostgreSQL 16 the smoke contract runs on (no mocks, no skips).
 * The api-configuration row needed for the cascade check is inserted RAW: those modules are
 * owned by other tasks and are not imported here.
 *
 * `refreshTokenEnc` fixtures are opaque base64-looking placeholders — this layer never
 * encrypts, decrypts or asserts anything about the plaintext behind them.
 */

const TOKEN_A = "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu"
const TOKEN_B = "bmV3LWNpcGhlcnRleHQ="
const TOKEN_C = "eG=="
const SHEETS_SCOPE = "openid email https://www.googleapis.com/auth/spreadsheets"

const SHEET1: SpreadsheetTab[] = [{ id: 0, title: "Sheet1", rows: 100, columns: 26 }]
const TWO_TABS: SpreadsheetTab[] = [
  { id: 0, title: "Sheet1", rows: 200, columns: 26 },
  { id: 1, title: "Invoices", rows: 50, columns: 8 },
]

/** One hour ago: makes a later `updated_at` / `connected_at` write observable. */
function anHourAgo(): Date {
  return new Date(Date.now() - 3_600_000)
}

describe("google connection and spreadsheet repositories", () => {
  let test: TestDb
  let repo: {
    users: typeof import("@/server/db/queries/users")
    connections: typeof import("@/server/db/queries/google-connections")
    spreadsheets: typeof import("@/server/db/queries/spreadsheets")
  }

  beforeAll(async () => {
    let url: string
    try {
      url = inject(TEST_DB_URL_KEY)
    } catch {
      await startTestDb()
      await migrateTestDb()
      url = getTestDbUrl()
    }
    // The repositories go through production's `db`, which validates DATABASE_URL at import
    // time, so the modules are imported only after the test instance's URL is published.
    process.env.DATABASE_URL = url
    test = await getTestDb()
    repo = {
      users: await import("@/server/db/queries/users"),
      connections: await import("@/server/db/queries/google-connections"),
      spreadsheets: await import("@/server/db/queries/spreadsheets"),
    }
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  async function seedUser(label: string) {
    const stamp = `${label}-${randomUUID()}`
    return repo.users.createUser({
      googleSub: `sub-${stamp}`,
      email: `gheets-${stamp}@example.com`,
      role: "user",
    })
  }

  function connectInput(userId: string, label: string, refreshTokenEnc: string = TOKEN_A) {
    return {
      userId,
      googleEmail: `sheets-${label}-${randomUUID()}@example.com`,
      refreshTokenEnc,
      scope: SHEETS_SCOPE,
    }
  }

  async function seedConnection(userId: string, label: string, refreshTokenEnc?: string) {
    return repo.connections.upsertConnection(connectInput(userId, label, refreshTokenEnc))
  }

  async function seedSpreadsheet(userId: string, connectionId: string, googleSheetId: string) {
    return repo.spreadsheets.upsertSpreadsheet({
      userId,
      connectionId,
      googleSheetId,
      title: "Roster",
      tabs: SHEET1,
    })
  }

  it("keeps one connection row per Google account and revives it on re-consent", async () => {
    const alice = await seedUser("alice")
    const connection = await repo.connections.upsertConnection(connectInput(alice.id, "primary"))
    expect(connection.id).toEqual(expect.any(String))
    expect(connection.status).toBe("connected")
    expect(connection.lastUsedAt).toBeNull()

    await repo.connections.markConnectionStatus(connection.id, "reauth_required")
    // Backdate so "re-consent bumps updated_at" is provable rather than coincidental.
    await test
      .update(googleConnections)
      .set({ updatedAt: anHourAgo() })
      .where(eq(googleConnections.id, connection.id))

    const reconnected = await repo.connections.upsertConnection({
      userId: alice.id,
      googleEmail: connection.googleEmail,
      refreshTokenEnc: TOKEN_B,
      scope: "openid email",
    })

    expect(reconnected.id).toBe(connection.id)
    expect(reconnected.userId).toBe(alice.id)
    expect(reconnected.googleEmail).toBe(connection.googleEmail)
    expect(reconnected.refreshTokenEnc).toBe(TOKEN_B)
    expect(reconnected.scope).toBe("openid email")
    expect(reconnected.status).toBe("connected")
    expect(reconnected.connectedAt).toEqual(connection.connectedAt)
    expect(reconnected.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(await repo.connections.listConnections(alice.id)).toHaveLength(1)
  })

  it("stores several Google accounts for one user as separate rows in a stable order", async () => {
    const alice = await seedUser("alice")
    const bob = await seedUser("bob")
    const accounts = await Promise.all(
      ["work", "personal", "labs"].map((label) => seedConnection(alice.id, label))
    )
    await seedConnection(bob.id, "work")

    const listed = await repo.connections.listConnections(alice.id)
    expect(listed).toHaveLength(3)
    expect(new Set(listed.map((row) => row.id)).size).toBe(3)
    expect(listed.map((row) => row.googleEmail).sort()).toEqual(
      accounts.map((row) => row.googleEmail).sort()
    )
    expect(listed.every((row) => row.userId === alice.id)).toBe(true)
    // The order must not depend on read order (the tie-break below is what makes it stable).
    expect((await repo.connections.listConnections(alice.id)).map((row) => row.id)).toEqual(
      listed.map((row) => row.id)
    )
    expect(await repo.connections.listConnections(bob.id)).toHaveLength(1)
    expect(await repo.connections.listConnections(randomUUID())).toHaveLength(0)
  })

  it("finds a usable connection without an id, and any status by id", async () => {
    const alice = await seedUser("alice")
    const older = await seedConnection(alice.id, "older", TOKEN_A)
    const newer = await seedConnection(alice.id, "newer", TOKEN_C)
    await test
      .update(googleConnections)
      .set({ connectedAt: anHourAgo() })
      .where(eq(googleConnections.id, older.id))

    expect((await repo.connections.findConnectionForUser(alice.id))?.id).toBe(newer.id)

    await repo.connections.markConnectionStatus(newer.id, "reauth_required")
    expect((await repo.connections.findConnectionForUser(alice.id))?.id).toBe(older.id)

    await repo.connections.markConnectionStatus(older.id, "disconnected")
    expect(await repo.connections.findConnectionForUser(alice.id)).toBeUndefined()

    // Dead rows stay addressable by id so the UI can show and delete them.
    expect((await repo.connections.findConnectionForUser(alice.id, older.id))?.status).toBe(
      "disconnected"
    )
    expect((await repo.connections.findConnectionForUser(alice.id, newer.id))?.status).toBe(
      "reauth_required"
    )
    expect(await repo.connections.findConnectionForUser(alice.id, randomUUID())).toBeUndefined()
    expect(await repo.connections.findConnectionForUser(randomUUID(), older.id)).toBeUndefined()

    const bob = await seedUser("bob")
    const bobs = await seedConnection(bob.id, "own")
    expect(await repo.connections.findConnectionForUser(alice.id, bobs.id)).toBeUndefined()
    expect((await repo.connections.findConnectionForUser(bob.id))?.id).toBe(bobs.id)
  })

  it("stamps usage without touching the connection record", async () => {
    const alice = await seedUser("alice")
    const connection = await seedConnection(alice.id, "usage")

    await repo.connections.touchConnectionUsed(connection.id)
    const used = await repo.connections.findConnectionForUser(alice.id, connection.id)
    expect(used?.lastUsedAt).toBeInstanceOf(Date)
    expect(used?.status).toBe("connected")
    expect(used?.refreshTokenEnc).toBe(TOKEN_A)
    expect(used?.updatedAt).toEqual(connection.updatedAt)

    // Unknown id is a no-op, not a throw — usage writes must never break a request.
    await repo.connections.touchConnectionUsed(randomUUID())
  })

  it("deletes a connection only for its owner and cascades that connection's sheets", async () => {
    const alice = await seedUser("alice")
    const bob = await seedUser("bob")
    const aConnection = await seedConnection(alice.id, "a")
    const aSecond = await seedConnection(alice.id, "a-second")
    const bConnection = await seedConnection(bob.id, "b")
    await seedSpreadsheet(alice.id, aConnection.id, "sheet-a")
    await seedSpreadsheet(alice.id, aSecond.id, "sheet-a2")
    const bSheet = await seedSpreadsheet(bob.id, bConnection.id, "sheet-b")

    await repo.connections.deleteConnection(bConnection.id, alice.id)
    expect(await repo.connections.listConnections(bob.id)).toHaveLength(1)
    expect(await repo.spreadsheets.listSpreadsheets(bob.id)).toHaveLength(1)

    await repo.connections.deleteConnection(bConnection.id, bob.id)
    expect(await repo.connections.listConnections(bob.id)).toHaveLength(0)
    // registered_spreadsheets.connection_id is ON DELETE CASCADE.
    expect(await repo.spreadsheets.listSpreadsheets(bob.id)).toHaveLength(0)
    expect(await repo.spreadsheets.findSpreadsheet(bob.id, bSheet.id)).toBeUndefined()

    // A foreign delete cascades nothing, and a cascade only takes the sheets of that connection.
    expect(await repo.connections.listConnections(alice.id)).toHaveLength(2)
    await repo.connections.deleteConnection(aConnection.id, alice.id)
    const remaining = await repo.spreadsheets.listSpreadsheets(alice.id)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.googleSheetId).toBe("sheet-a2")
    expect(remaining[0]?.connectionId).toBe(aSecond.id)
  })

  it("upserts a spreadsheet on (user, google sheet id) and re-points its connection", async () => {
    const alice = await seedUser("alice")
    const first = await seedConnection(alice.id, "first")
    const second = await seedConnection(alice.id, "second")

    const sheet = await seedSpreadsheet(alice.id, first.id, "sheet-roster")
    expect(sheet.status).toBe("active")
    expect(sheet.tabs).toEqual(SHEET1)
    expect(sheet.connectionId).toBe(first.id)

    await repo.spreadsheets.setSpreadsheetStatus(sheet.id, "inaccessible")
    await test
      .update(registeredSpreadsheets)
      .set({ updatedAt: anHourAgo() })
      .where(eq(registeredSpreadsheets.id, sheet.id))

    const refreshed = await repo.spreadsheets.upsertSpreadsheet({
      userId: alice.id,
      connectionId: second.id,
      googleSheetId: "sheet-roster",
      title: "Roster 2026",
      tabs: TWO_TABS,
    })

    expect(refreshed.id).toBe(sheet.id)
    expect(refreshed.connectionId).toBe(second.id)
    expect(refreshed.title).toBe("Roster 2026")
    expect(refreshed.tabs).toEqual(TWO_TABS)
    expect(refreshed.status).toBe("active")
    expect(refreshed.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(await repo.spreadsheets.listSpreadsheets(alice.id)).toHaveLength(1)

    // The unique key is per user, so a second account registers its own row for the same sheet.
    const bob = await seedUser("bob")
    const bobsConnection = await seedConnection(bob.id, "own")
    const bobsSheet = await seedSpreadsheet(bob.id, bobsConnection.id, "sheet-roster")
    expect(bobsSheet.id).not.toBe(sheet.id)
    expect(await repo.spreadsheets.listSpreadsheets(bob.id)).toHaveLength(1)
    expect(await repo.spreadsheets.listSpreadsheets(alice.id)).toHaveLength(1)
  })

  it("returns a spreadsheet whatever its status, and never to another owner", async () => {
    const alice = await seedUser("alice")
    const bob = await seedUser("bob")
    const connection = await seedConnection(alice.id, "own")
    const sheet = await seedSpreadsheet(alice.id, connection.id, "sheet-a")

    await repo.spreadsheets.setSpreadsheetStatus(sheet.id, "inaccessible")
    const downed = await repo.spreadsheets.findSpreadsheet(alice.id, sheet.id)
    if (!downed) throw new Error("an inaccessible row must still be found")
    expect(downed.status).toBe("inaccessible")
    expect(downed.tabs).toEqual(SHEET1)
    expect(downed.updatedAt.getTime()).toBeGreaterThanOrEqual(downed.createdAt.getTime())

    expect(await repo.spreadsheets.findSpreadsheet(bob.id, sheet.id)).toBeUndefined()
    expect(await repo.spreadsheets.findSpreadsheet(alice.id, randomUUID())).toBeUndefined()

    await repo.spreadsheets.setSpreadsheetStatus(sheet.id, "active")
    expect((await repo.spreadsheets.findSpreadsheet(alice.id, sheet.id))?.status).toBe("active")
  })

  it("replaces the tab snapshot, and the title only when one is supplied", async () => {
    const alice = await seedUser("alice")
    const connection = await seedConnection(alice.id, "own")
    const sheet = await seedSpreadsheet(alice.id, connection.id, "sheet-a")

    await repo.spreadsheets.updateSpreadsheetTabs(
      sheet.id,
      [{ id: 0, title: "Sheet1", rows: 300, columns: 26 }],
      "Roster 300"
    )
    const retabbed = await repo.spreadsheets.findSpreadsheet(alice.id, sheet.id)
    expect(retabbed?.tabs).toEqual([{ id: 0, title: "Sheet1", rows: 300, columns: 26 }])
    expect(retabbed?.title).toBe("Roster 300")

    await test
      .update(registeredSpreadsheets)
      .set({ updatedAt: anHourAgo() })
      .where(eq(registeredSpreadsheets.id, sheet.id))

    await repo.spreadsheets.updateSpreadsheetTabs(sheet.id, TWO_TABS)
    const kept = await repo.spreadsheets.findSpreadsheet(alice.id, sheet.id)
    expect(kept?.title).toBe("Roster 300")
    expect(kept?.tabs).toEqual(TWO_TABS)
    expect(kept?.status).toBe("active")
    expect(kept?.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)

    await repo.spreadsheets.updateSpreadsheetTabs(randomUUID(), TWO_TABS)
  })

  it("deletes a spreadsheet only for its owner, cascading the raw API row", async () => {
    const alice = await seedUser("alice")
    const bob = await seedUser("bob")
    const connection = await seedConnection(alice.id, "own")
    const sheet = await seedSpreadsheet(alice.id, connection.id, "sheet-a")
    await test.insert(apiConfigurations).values({
      id: randomUUID(),
      userId: alice.id,
      spreadsheetId: sheet.id,
      name: "Roster API",
      tabTitle: "Sheet1",
      allowedOperations: ["GET"],
    })

    await repo.spreadsheets.deleteSpreadsheet(bob.id, sheet.id)
    expect(await repo.spreadsheets.findSpreadsheet(alice.id, sheet.id)).toBeDefined()

    await repo.spreadsheets.deleteSpreadsheet(alice.id, sheet.id)
    expect(await repo.spreadsheets.listSpreadsheets(alice.id)).toHaveLength(0)
    expect(await repo.spreadsheets.findSpreadsheet(alice.id, sheet.id)).toBeUndefined()
    const dependents = await test
      .select({ id: apiConfigurations.id })
      .from(apiConfigurations)
      .where(eq(apiConfigurations.spreadsheetId, sheet.id))
    expect(dependents).toHaveLength(0)

    // Deleting a registration never touches the Google grant itself.
    expect(await repo.connections.listConnections(alice.id)).toHaveLength(1)
  })

  it("honours a caller-supplied client: a rolled back connect writes nothing", async () => {
    const alice = await seedUser("alice")
    const bob = await seedUser("bob")

    await expect(
      test.transaction(async (tx) => {
        const connection = await repo.connections.upsertConnection(connectInput(alice.id, "in-tx"), tx)
        await repo.spreadsheets.upsertSpreadsheet(
          {
            userId: alice.id,
            connectionId: connection.id,
            googleSheetId: "sheet-tx",
            title: "Tx",
            tabs: SHEET1,
          },
          tx
        )
        throw new Error("rollback on purpose")
      })
    ).rejects.toThrow("rollback on purpose")

    expect(await repo.connections.listConnections(alice.id)).toHaveLength(0)
    expect(await repo.spreadsheets.listSpreadsheets(alice.id)).toHaveLength(0)

    const inTx = await test.transaction(async (tx) => {
      const connection = await repo.connections.upsertConnection(connectInput(alice.id, "committed"), tx)
      const sheet = await repo.spreadsheets.upsertSpreadsheet(
        {
          userId: alice.id,
          connectionId: connection.id,
          googleSheetId: "sheet-committed",
          title: "Committed",
          tabs: SHEET1,
        },
        tx
      )
      await repo.connections.markConnectionStatus(connection.id, "reauth_required", tx)
      await repo.spreadsheets.setSpreadsheetStatus(sheet.id, "inaccessible", tx)
      await repo.connections.deleteConnection(connection.id, bob.id, tx)
      return { connection, sheet }
    })
    expect((await repo.connections.findConnectionForUser(alice.id, inTx.connection.id))?.status).toBe(
      "reauth_required"
    )
    expect((await repo.spreadsheets.findSpreadsheet(alice.id, inTx.sheet.id))?.status).toBe(
      "inaccessible"
    )
  })
})
