import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import type { SnippetMethod } from "@/lib/snippets"
import { apiKeys, googleConnections, registeredSpreadsheets } from "@/server/db/schema"

import {
  TEST_DB_URL_KEY,
  getTestDb,
  getTestDbUrl,
  migrateTestDb,
  startTestDb,
  truncateAll,
  type TestDb,
} from "./helpers/db"

/*
 * Integration coverage for the two repository modules the public engine and the dashboard both
 * sit on: `api-configurations.ts` and `api-keys.ts`. Runs against the real ephemeral embedded
 * Postgres (globalSetup boots it once for the run). The connection/spreadsheet rows are seeded
 * RAW through the schema, so this file depends on no other query module but `users`.
 */

type ApiConfigsModule = typeof import("@/server/db/queries/api-configurations")
type ApiKeysModule = typeof import("@/server/db/queries/api-keys")
type UsersModule = typeof import("@/server/db/queries/users")
type CreateKeyInput = Parameters<ApiKeysModule["createApiKey"]>[0]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let test: TestDb
let apis: ApiConfigsModule
let keys: ApiKeysModule
let usersRepo: UsersModule

/** Drizzle surfaces the driver's error; walk `cause` anyway so wrapping cannot hide it. */
function pgConstraint(error: unknown): string | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    const candidate = current as { constraint?: unknown; cause?: unknown }
    if (typeof candidate.constraint === "string") return candidate.constraint
    current = candidate.cause
  }
  return undefined
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000)
}

/** The smallest legal config; every test spreads it and overrides what it is about. */
const baseConfig = {
  tabTitle: "Sheet1",
  headerRow: 1,
  permissions: "read" as const,
  allowedOperations: ["GET"] as SnippetMethod[],
}

describe("api configuration and api key query modules", () => {
  beforeAll(async () => {
    let url: string
    try {
      url = inject(TEST_DB_URL_KEY)
    } catch {
      await startTestDb()
      await migrateTestDb()
      url = getTestDbUrl()
    }
    // Before the query modules load, so production's `db` client binds the ephemeral instance.
    process.env.DATABASE_URL = url
    test = await getTestDb()
    apis = await import("@/server/db/queries/api-configurations")
    keys = await import("@/server/db/queries/api-keys")
    usersRepo = await import("@/server/db/queries/users")
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
  })

  async function seedUser() {
    const stamp = randomUUID()
    return usersRepo.createUser({
      googleSub: `sub-${stamp}`,
      email: `configs-${stamp}@example.com`,
      role: "user",
    })
  }

  async function seedSpreadsheet(userId: string, label: string) {
    const connectionId = randomUUID()
    await test.insert(googleConnections).values({
      id: connectionId,
      userId,
      googleEmail: `sheets-${label}@example.com`,
      refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
      scope: "openid email https://www.googleapis.com/auth/spreadsheets",
    })
    const spreadsheetId = randomUUID()
    await test.insert(registeredSpreadsheets).values({
      id: spreadsheetId,
      userId,
      connectionId,
      googleSheetId: `sheet-${label}`,
      title: "Roster",
      tabs: [{ id: 0, title: "Sheet1", rows: 100, columns: 26 }],
    })
    return { connectionId, spreadsheetId }
  }

  async function seedConfig(userId: string, label: string) {
    const { connectionId, spreadsheetId } = await seedSpreadsheet(userId, label)
    const api = await apis.createApiConfiguration({ userId, spreadsheetId, name: `API ${label}`, ...baseConfig })
    return { connectionId, spreadsheetId, api }
  }

  async function seedKey(
    userId: string,
    label: string,
    extra: Partial<Omit<CreateKeyInput, "userId" | "name">> = {}
  ) {
    return keys.createApiKey({
      userId,
      name: `key-${label}`,
      keyHash: extra.keyHash ?? `kh-${randomUUID()}`,
      keyPreview: extra.keyPreview ?? "sz_live_ab12wxyz",
      scopes: extra.scopes ?? ["read"],
      allowedApiIds: extra.allowedApiIds ?? null,
      expiresAt: extra.expiresAt ?? null,
    })
  }

  it("creates an api configuration whose uuid PK is the public api_id and round-trips every field", async () => {
    const alice = await seedUser()
    const { spreadsheetId } = await seedSpreadsheet(alice.id, "full")

    const created = await apis.createApiConfiguration({
      userId: alice.id,
      spreadsheetId,
      name: "Roster API",
      description: "team roster, read/write",
      tabTitle: "Sheet1",
      headerRow: 2,
      primaryKeyColumn: "id",
      permissions: "read_write",
      allowedOperations: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      rateLimitPerHour: 500,
    })
    expect(created.id).toMatch(UUID_RE)
    expect(created.userId).toBe(alice.id)
    expect(created.enabled).toBe(true)
    expect(created.allowedOperations).toHaveLength(5)
    expect(created.rateLimitPerHour).toBe(500)
    expect(created.createdAt).toBeInstanceOf(Date)
    expect(created.updatedAt).toBeInstanceOf(Date)

    // The `q` overload is the transaction handle a service passes; here the pooled test client.
    expect(await apis.findApiConfigurationById(created.id, test)).toEqual(created)
    expect(await apis.findApiConfiguration(alice.id, created.id, test)).toEqual(created)
    expect(await apis.listApiConfigurations(alice.id)).toHaveLength(1)

    // The optional members really are optional: absent means NULL, and NULL means platform default.
    const minimal = await apis.createApiConfiguration({ userId: alice.id, spreadsheetId, name: "Minimal", ...baseConfig })
    expect(minimal.description).toBeNull()
    expect(minimal.primaryKeyColumn).toBeNull()
    expect(minimal.rateLimitPerHour).toBeNull()
    expect(await apis.listApiConfigurations(alice.id)).toHaveLength(2)
  })

  it("surfaces the raw CHECK and FK constraint names instead of swallowing them", async () => {
    const alice = await seedUser()
    const { spreadsheetId } = await seedSpreadsheet(alice.id, "checks")

    const badHeader = await apis
      .createApiConfiguration({ userId: alice.id, spreadsheetId, name: "Zero header", ...baseConfig, headerRow: 0 })
      .catch((error: unknown) => error)
    expect(pgConstraint(badHeader)).toBe("api_configurations_header_row_check")

    const badPermissions = await apis
      .createApiConfiguration({
        userId: alice.id,
        spreadsheetId,
        name: "Writey",
        ...baseConfig,
        permissions: "read_write_delete" as unknown as "read",
      })
      .catch((error: unknown) => error)
    expect(pgConstraint(badPermissions)).toBe("api_configurations_permissions_check")

    const dangling = await apis
      .createApiConfiguration({
        userId: alice.id,
        spreadsheetId: randomUUID(),
        name: "Dangling",
        ...baseConfig,
      })
      .catch((error: unknown) => error)
    expect(pgConstraint(dangling)).toBe("api_configurations_spreadsheet_id_registered_spreadsheets_id_fk")

    const bogusUser = await apis
      .createApiConfiguration({ userId: randomUUID(), spreadsheetId, name: "Ghost", ...baseConfig })
      .catch((error: unknown) => error)
    expect(pgConstraint(bogusUser)).toBe("api_configurations_user_id_users_id_fk")

    // A row illegal for BOTH reasons reports the CHECK, never the FK: Postgres evaluates
    // constraints before the AFTER-ROW foreign-key triggers fire, so a doubly-invalid INSERT
    // cannot be used to prove the FK constraint name.
    const doublyInvalid = await apis
      .createApiConfiguration({
        userId: alice.id,
        spreadsheetId: randomUUID(),
        name: "Both",
        ...baseConfig,
        headerRow: 0,
      })
      .catch((error: unknown) => error)
    expect(pgConstraint(doublyInvalid)).toBe("api_configurations_header_row_check")

    // Nothing half-written: every rejected INSERT left no row behind.
    expect(await apis.listApiConfigurations(alice.id)).toHaveLength(0)
  })

  it("lets a foreign spreadsheet id satisfy the plain FK, then drops the API through cascade", async () => {
    const alice = await seedUser()
    const bob = await seedUser()
    const bobGraph = await seedSpreadsheet(bob.id, "foreign")

    const borrowed = await apis.createApiConfiguration({
      userId: alice.id,
      spreadsheetId: bobGraph.spreadsheetId,
      name: "Borrowed",
      ...baseConfig,
    })
    expect(borrowed.spreadsheetId).toBe(bobGraph.spreadsheetId)
    expect(await apis.findApiConfiguration(alice.id, borrowed.id)).toBeDefined()

    // The documented outcome of the plain FK: deleting bob's connection cascades the spreadsheet
    // and therefore alice's API, even though the API row is hers.
    await test.delete(googleConnections).where(eq(googleConnections.id, bobGraph.connectionId))
    expect(await apis.findApiConfiguration(alice.id, borrowed.id)).toBeUndefined()
    expect(await apis.findApiConfigurationById(borrowed.id)).toBeUndefined()
    expect(await apis.listApiConfigurations(alice.id)).toHaveLength(0)
  })

  it("patches only the keys present and writes an explicit null through updateApiConfiguration", async () => {
    const alice = await seedUser()
    const first = await seedSpreadsheet(alice.id, "first")
    const second = await seedSpreadsheet(alice.id, "second")
    const created = await apis.createApiConfiguration({
      userId: alice.id,
      spreadsheetId: first.spreadsheetId,
      name: "Writable",
      description: "keep me",
      tabTitle: "Sheet1",
      headerRow: 2,
      primaryKeyColumn: "id",
      permissions: "read_write",
      allowedOperations: ["GET", "POST"],
      rateLimitPerHour: 500,
    })

    const renamed = await apis.updateApiConfiguration(alice.id, created.id, { name: "Writable v2" })
    expect(renamed?.name).toBe("Writable v2")
    expect(renamed?.description).toBe("keep me")
    expect(renamed?.headerRow).toBe(2)
    expect(renamed?.allowedOperations).toEqual(["GET", "POST"])
    expect(renamed?.enabled).toBe(true)
    expect(renamed!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

    const cleared = await apis.updateApiConfiguration(alice.id, created.id, {
      spreadsheetId: second.spreadsheetId,
      tabTitle: "People",
      headerRow: 3,
      permissions: "read",
      allowedOperations: ["GET"],
      description: null,
      primaryKeyColumn: null,
      rateLimitPerHour: null,
    })
    expect(cleared?.description).toBeNull()
    expect(cleared?.primaryKeyColumn).toBeNull()
    expect(cleared?.rateLimitPerHour).toBeNull()
    expect(cleared?.headerRow).toBe(3)
    expect(cleared?.permissions).toBe("read")
    expect(cleared?.tabTitle).toBe("People")
    expect(cleared?.spreadsheetId).toBe(second.spreadsheetId)
    expect(cleared?.name).toBe("Writable v2")
    // Persisted, not merely returned.
    expect(await apis.findApiConfiguration(alice.id, created.id)).toEqual(cleared)

    const empty = await apis.updateApiConfiguration(alice.id, created.id, {})
    expect(empty?.name).toBe("Writable v2")
    expect(empty?.description).toBeNull()

    expect(await apis.updateApiConfiguration(alice.id, randomUUID(), { name: "ghost" })).toBeUndefined()
  })

  it("scopes patch, enable and delete to the owner while the engine lookups stay unscoped", async () => {
    const alice = await seedUser()
    const bob = await seedUser()
    const a = await seedConfig(alice.id, "alice")
    const b = await seedConfig(bob.id, "bob")

    expect(await apis.findApiConfiguration(alice.id, b.api.id)).toBeUndefined()
    expect(await apis.updateApiConfiguration(alice.id, b.api.id, { name: "hijacked" })).toBeUndefined()
    await apis.setApiEnabled(alice.id, b.api.id, false)
    await apis.deleteApiConfiguration(alice.id, b.api.id)
    expect(await apis.listApiConfigurations(alice.id)).toHaveLength(1)
    expect(await apis.listApiConfigurations(bob.id)).toHaveLength(1)

    const engineRow = await apis.findApiConfigurationById(b.api.id)
    expect(engineRow?.userId).toBe(bob.id)
    expect(engineRow?.name).toBe("API bob")
    expect(engineRow?.enabled).toBe(true)

    await apis.setApiEnabled(bob.id, b.api.id, false)
    expect((await apis.findApiConfiguration(bob.id, b.api.id))?.enabled).toBe(false)
    expect((await apis.findApiConfigurationById(b.api.id))?.enabled).toBe(false)
    await apis.setApiEnabled(bob.id, b.api.id, true)
    expect((await apis.findApiConfigurationById(b.api.id))?.enabled).toBe(true)

    await apis.deleteApiConfiguration(bob.id, b.api.id)
    expect(await apis.findApiConfigurationById(b.api.id)).toBeUndefined()
    expect(await apis.listApiConfigurations(bob.id)).toHaveLength(0)
    expect(await apis.findApiConfiguration(alice.id, a.api.id)).toBeDefined()
  })

  it("stores a key as hash plus preview and resolves it owner-agnostically by hash", async () => {
    const alice = await seedUser()
    const bob = await seedUser()
    const aliceApi = await seedConfig(alice.id, "scoped")

    const created = await keys.createApiKey({
      userId: alice.id,
      name: "ci",
      keyHash: `kh-${randomUUID()}`,
      keyPreview: "sz_live_ab12wxyz",
      scopes: ["read", "write"],
      allowedApiIds: [aliceApi.api.id],
      expiresAt: minutesFromNow(60),
    })
    expect(created.id).toMatch(UUID_RE)
    expect(created.scopes).toEqual(["read", "write"])
    expect(created.allowedApiIds).toEqual([aliceApi.api.id])
    expect(created.expiresAt).toBeInstanceOf(Date)
    expect(created.revokedAt).toBeNull()
    expect(created.lastUsedAt).toBeNull()
    expect(created.keyPreview).toBe("sz_live_ab12wxyz")

    // Engine path: the hash resolves regardless of who owns the row, and carries the owner.
    const found = await keys.findApiKeyByHash(created.keyHash, test)
    expect(found?.userId).toBe(alice.id)
    expect(found?.keyHash).toBe(created.keyHash)
    expect(await keys.findApiKeyByHash(`kh-${randomUUID()}`)).toBeUndefined()

    const duplicate = await keys
      .createApiKey({
        userId: bob.id,
        name: "clash",
        keyHash: created.keyHash,
        keyPreview: "sz_live_ab12bbbb",
        scopes: ["read"],
        allowedApiIds: null,
        expiresAt: null,
      })
      .catch((error: unknown) => error)
    expect(pgConstraint(duplicate)).toBe("api_keys_key_hash_unique")
  })

  it("revokes only for the owner and takes the key out of the engine path once", async () => {
    const alice = await seedUser()
    const bob = await seedUser()
    const aliceKey = await seedKey(alice.id, "alice")
    const bobKey = await seedKey(bob.id, "bob")

    await keys.revokeApiKey(alice.id, bobKey.id)
    expect(await keys.findApiKeyByHash(bobKey.keyHash)).toBeDefined()
    expect((await test.select().from(apiKeys).where(eq(apiKeys.id, bobKey.id)))[0]?.revokedAt).toBeNull()

    await keys.revokeApiKey(bob.id, bobKey.id)
    expect(await keys.findApiKeyByHash(bobKey.keyHash)).toBeUndefined()
    const [revoked] = await test.select().from(apiKeys).where(eq(apiKeys.id, bobKey.id))
    expect(revoked?.revokedAt).toBeInstanceOf(Date)

    // Once-only: a second revoke keeps the original timestamp rather than rewriting history.
    await keys.revokeApiKey(bob.id, bobKey.id)
    const [again] = await test.select().from(apiKeys).where(eq(apiKeys.id, bobKey.id))
    expect(again?.revokedAt).toEqual(revoked?.revokedAt)

    expect(await keys.findApiKeyByHash(aliceKey.keyHash)).toBeDefined()
  })

  it("hides revoked and expired keys from the engine lookup alike", async () => {
    const alice = await seedUser()
    const expired = await seedKey(alice.id, "expired", { expiresAt: minutesFromNow(-1) })
    const revoked = await seedKey(alice.id, "revoked")
    const live = await seedKey(alice.id, "live", { expiresAt: minutesFromNow(30) })

    expect(await keys.findApiKeyByHash(expired.keyHash)).toBeUndefined()
    await keys.revokeApiKey(alice.id, revoked.id)
    expect(await keys.findApiKeyByHash(revoked.keyHash)).toBeUndefined()
    expect(await keys.findApiKeyByHash(live.keyHash)).toBeDefined()
  })

  it("lists an owner's active keys newest first without ever returning a hash", async () => {
    const alice = await seedUser()
    const bob = await seedUser()
    const older = await seedKey(alice.id, "older")
    const newer = await seedKey(alice.id, "newer", { scopes: ["read", "write"], allowedApiIds: ["api-1"] })
    const privateToBob = await seedKey(bob.id, "private")
    // Age the seeded rows so the DESC ordering assertion cannot hinge on same-millisecond inserts.
    await test.update(apiKeys).set({ createdAt: minutesFromNow(-10) }).where(eq(apiKeys.id, older.id))
    await keys.revokeApiKey(alice.id, older.id)

    const rows = await keys.listApiKeys(alice.id)
    expect(rows).toHaveLength(1)
    const everyHash = [older.keyHash, newer.keyHash, privateToBob.keyHash]
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("keyHash")
      const json = JSON.stringify(row)
      for (const hash of everyHash) expect(json).not.toContain(hash)
    }
    expect(rows[0]?.id).toBe(newer.id)
    expect(rows[0]?.keyPreview).toBe("sz_live_ab12wxyz")
    expect(rows[0]?.scopes).toEqual(["read", "write"])
    expect(rows[0]?.allowedApiIds).toEqual(["api-1"])
    expect(rows[0]?.revokedAt).toBeNull()

    // Expired but unrevoked stays in the inventory so the dashboard can label it.
    const lapsed = await seedKey(alice.id, "lapsed", { expiresAt: minutesFromNow(-1) })
    await test.update(apiKeys).set({ createdAt: minutesFromNow(-5) }).where(eq(apiKeys.id, newer.id))
    expect((await keys.listApiKeys(alice.id)).map((row) => row.id)).toEqual([lapsed.id, newer.id])
    expect(await keys.listApiKeys(bob.id)).toHaveLength(1)
    expect(await keys.listApiKeys(randomUUID())).toHaveLength(0)
  })

  it("throttles last_used_at to one write per minute in a single statement", async () => {
    const alice = await seedUser()
    const key = await seedKey(alice.id, "used")
    expect((await keys.findApiKeyByHash(key.keyHash))?.lastUsedAt).toBeNull()

    await keys.touchKeyUsed(key.id)
    const firstUse = (await keys.findApiKeyByHash(key.keyHash))?.lastUsedAt
    expect(firstUse).toBeInstanceOf(Date)

    await keys.touchKeyUsed(key.id)
    expect((await keys.findApiKeyByHash(key.keyHash))?.lastUsedAt).toEqual(firstUse)

    // Age the row past the window and the very next use writes again.
    await test.update(apiKeys).set({ lastUsedAt: minutesFromNow(-2) }).where(eq(apiKeys.id, key.id))
    await keys.touchKeyUsed(key.id)
    const secondUse = (await keys.findApiKeyByHash(key.keyHash))?.lastUsedAt
    expect(secondUse).toBeInstanceOf(Date)
    expect(secondUse!.getTime()).toBeGreaterThan(firstUse!.getTime())

    // Unknown id: a no-op, not an error — the engine never learns which key rows exist. And the
    // window test must not leak past `id`: an aged row belonging to another key stays untouched.
    const untouched = await seedKey(alice.id, "other")
    const aged = minutesFromNow(-2)
    await test.update(apiKeys).set({ lastUsedAt: aged }).where(eq(apiKeys.id, untouched.id))
    await expect(keys.touchKeyUsed(randomUUID())).resolves.toBeUndefined()
    const [stillAged] = await test.select().from(apiKeys).where(eq(apiKeys.id, untouched.id))
    expect(stillAged?.lastUsedAt).toEqual(aged)
  })
})
