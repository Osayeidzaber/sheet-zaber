import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { invitationRedemptions, invitations, userProfiles, users } from "@/server/db/schema"

import {
  TEST_DB_URL_KEY,
  TEST_TABLE_NAMES,
  getTestDb,
  getTestDbUrl,
  getTestPool,
  migrateTestDb,
  startTestDb,
  stopTestDb,
  truncateAll,
  type TestDb,
} from "./helpers/db"
import { SheetsStubError, fakeSheets, headerKeys } from "./helpers/fake-sheets"

/*
 * Proves the Phase 2.4 harness end to end: a real PostgreSQL 16 (embedded-postgres) with
 * the committed drizzle/ migrations, reached through getTestPool/getTestDb/truncateAll,
 * plus the Sheets stub the Phase 4 engine tests will use. No mocks, no skips.
 */

describe("test infrastructure", () => {
  beforeEach(async () => {
    await truncateAll()
  })

  it("boots the migrated Postgres and round-trips a user with a dependent profile row", async () => {
    const db = await getTestDb()
    const id = randomUUID()
    await db.insert(users).values({ id, googleSub: `sub-${id}`, email: `smoke-${id}@example.com` })
    await db.insert(userProfiles).values({ userId: id, displayName: "Smoke" })

    const [user] = await db.select().from(users).where(eq(users.id, id))
    expect(user.email).toBe(`smoke-${id}@example.com`)
    expect(user.role).toBe("user")
    expect(user.status).toBe("active")
    expect(user.createdAt).toBeInstanceOf(Date)

    const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, id))
    expect(profile.displayName).toBe("Smoke")
    expect(profile.theme).toBe("dark")
    expect(profile.dashboardPrefs).toEqual({})
  })

  it("enforces the UNIQUE, CHECK and FK constraints documented in database-schema.md", async () => {
    const pool = await getTestPool()
    const id = randomUUID()
    await pool.query(`INSERT INTO users (id, google_sub, email) VALUES ($1, $2, $3)`, [
      id,
      `sub-${id}`,
      `smoke-${id}@example.com`,
    ])

    await expect(
      pool.query(`INSERT INTO users (id, google_sub, email) VALUES ($1, $2, $3)`, [
        randomUUID(),
        `sub-${id}`,
        `other-${id}@example.com`,
      ])
    ).rejects.toThrow(/users_google_sub_unique/)

    await expect(
      pool.query(`INSERT INTO users (id, google_sub, email) VALUES ($1, $2, $3)`, [
        randomUUID(),
        `other-sub-${id}`,
        `smoke-${id}@example.com`,
      ])
    ).rejects.toThrow(/users_email_unique/)

    await expect(
      pool.query(`INSERT INTO users (id, google_sub, email, role) VALUES ($1, $2, $3, 'admin')`, [
        randomUUID(),
        `admin-${id}`,
        `admin-${id}@example.com`,
      ])
    ).rejects.toThrow(/users_role_check/)

    await expect(
      pool.query(`INSERT INTO user_profiles (user_id, display_name) VALUES ($1, 'orphan')`, [
        randomUUID(),
      ])
    ).rejects.toThrow(/user_profiles_user_id_users_id_fk/)
  })

  it("cascades a user delete into owned child rows", async () => {
    const db = await getTestDb()
    const id = randomUUID()
    await db.insert(users).values({ id, googleSub: `sub-${id}`, email: `cascade-${id}@example.com` })
    await db.insert(userProfiles).values({ userId: id, displayName: "Cascade" })

    await db.delete(users).where(eq(users.id, id))

    const profiles = await db.select().from(userProfiles).where(eq(userProfiles.userId, id))
    expect(profiles).toHaveLength(0)
  })

  it("publishes exactly the schema's tables, RLS-enabled and policy-free", async () => {
    const pool = await getTestPool()
    expect(TEST_TABLE_NAMES).toHaveLength(11)

    const tables = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`
    )
    expect(tables.rows.map((row) => row.relname)).toEqual([...TEST_TABLE_NAMES].sort())
    for (const row of tables.rows) expect(row.relrowsecurity).toBe(true)

    const policies = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_policies")
    expect(policies.rows[0].n).toBe(0)
  })

  it("truncateAll clears every table and restarts identity sequences", async () => {
    const pool = await getTestPool()
    const id = randomUUID()
    await pool.query(`INSERT INTO users (id, google_sub, email) VALUES ($1, $2, $3)`, [
      id,
      `sub-${id}`,
      `trunc-${id}@example.com`,
    ])
    await pool.query(`INSERT INTO user_profiles (user_id, display_name) VALUES ($1, 'Truncate me')`, [id])
    const before = await pool.query<{ id: string }>(
      `INSERT INTO api_request_logs (method, path, status_code, duration_ms) VALUES ('GET', '/api/v1/x/rows', 200, 5) RETURNING id`
    )
    // The raw driver hands int8 back as a string; Drizzle's `mode: "number"` parses it.
    expect(Number(before.rows[0].id)).toBeGreaterThan(0)

    await truncateAll()

    for (const table of TEST_TABLE_NAMES) {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)
      expect(rows[0].n, table).toBe(0)
    }

    const after = await pool.query<{ id: string }>(
      `INSERT INTO api_request_logs (method, path, status_code, duration_ms) VALUES ('GET', '/api/v1/x/rows', 200, 5) RETURNING id`
    )
    expect(Number(after.rows[0].id)).toBe(1)
  })

  it("serves spreadsheet metadata from the sheets stub", async () => {
    const meta = await fakeSheets().getSpreadsheetMeta("any")
    expect(meta.title).toBe("Smoke Sheet")
    expect(meta.tabs).toEqual([{ id: "0", title: "Sheet1", rows: 100, columns: 26 }])
  })

  it("round-trips getValues and appendValues with 1-based A1 ranges", async () => {
    const sheets = fakeSheets()

    const header = await sheets.getValues("Sheet1!A1:C1")
    expect(header.range).toBe("Sheet1!A1:C1")
    expect(header.values).toEqual([["id", "name", "email"]])
    expect(headerKeys(header.values[0])).toEqual(["id", "name", "email"])

    // header_row = 2: the engine reads the body below the header.
    const body = await sheets.getValues("Sheet1!A2:C3")
    expect(body.values).toEqual([
      ["1", "Ada", "ada@example.com"],
      ["2", "Grace", "grace@example.com"],
    ])

    const appended = await sheets.appendValues("Sheet1!A1:C3", [["3", "Hedy", "hedy@example.com"]])
    expect(appended.updatedRows).toBe(1)
    expect(appended.updatedRange).toBe("Sheet1!A4:C4")
    expect(await sheets.getValues("Sheet1!A4:C4")).toMatchObject({
      values: [["3", "Hedy", "hedy@example.com"]],
    })

    const replaced = await sheets.updateValues("Sheet1!B4", [["Kitty"]] as [string][])
    expect(replaced.updatedRange).toBe("Sheet1!B4")
    expect(sheets.dump()[3]).toEqual(["3", "Kitty", "hedy@example.com"])
  })

  it("resolves A1 ranges relative to the requested tab", async () => {
    const sheets = fakeSheets({
      title: "Multi",
      grids: { Roster: [["id", "name"], ["1", "Ada"]], 'Billing "2026"': [["id", "total"], ["9", "10"]] },
    })

    expect((await sheets.getSpreadsheetMeta("s1")).tabs.map((tab) => tab.title)).toEqual([
      "Roster",
      'Billing "2026"',
    ])
    expect((await sheets.getValues("Roster!B2")).values).toEqual([["Ada"]])
    expect((await sheets.getValues("'Billing \"2026\"'!A1:B2")).values[1]).toEqual(["9", "10"])
    await expect(sheets.getValues("Nope!A1")).rejects.toThrow(/does not exist/)
  })

  it("throws the armed Google error on the next call only", async () => {
    const sheets = fakeSheets()
    sheets.failNextWith("429")

    const failure = await sheets.appendValues("Sheet1!A1:C3", [["4", "Late", "late@example.com"]]).catch((e) => e)
    expect(failure).toBeInstanceOf(SheetsStubError)
    expect((failure as SheetsStubError).status).toBe("429")
    expect((failure as SheetsStubError).code).toBe(429)
    expect(sheets.dump()).toHaveLength(3)

    const retried = await sheets.appendValues("Sheet1!A1:C3", [["4", "Late", "late@example.com"]])
    expect(retried.updatedRange).toBe("Sheet1!A4:C4")
    expect(sheets.dump()).toHaveLength(4)
  })

  it("drives the 401 / 403 / 404 engine paths from the constructor knob", async () => {
    const unauthorized = fakeSheets({ failNextWith: "401" })
    await expect(unauthorized.getValues("Sheet1!A1")).rejects.toMatchObject({ status: "401", code: 401 })

    const forbidden = fakeSheets({ spreadsheetId: "mine" })
    await expect(forbidden.getSpreadsheetMeta("theirs")).rejects.toMatchObject({ status: "404" })

    const missing = fakeSheets()
    await expect(missing.deleteRow("any", "Sheet1", 99)).rejects.toThrow(/out of range/)
  })
})

/*
 * Repository query modules (src/server/db/queries/**) against the same embedded PostgreSQL
 * 16: nothing is mocked, and the modules reach the database through their own pooled `db`
 * handle, so the worker's DATABASE_URL is republished to the test instance before the
 * query modules (and therefore src/lib/env.ts) are first imported.
 */

const SCHEMA_TABLE_NAMES = [
  "api_configurations",
  "api_keys",
  "api_request_logs",
  "audit_logs",
  "google_connections",
  "invitation_redemptions",
  "invitations",
  "rate_limit_buckets",
  "registered_spreadsheets",
  "user_profiles",
  "users",
] as const

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

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000)
}

describe("repository query modules", () => {
  let test: TestDb
  let repo: {
    users: typeof import("@/server/db/queries/users")
    invitations: typeof import("@/server/db/queries/invitations")
    connections: typeof import("@/server/db/queries/google-connections")
    spreadsheets: typeof import("@/server/db/queries/spreadsheets")
    apis: typeof import("@/server/db/queries/api-configurations")
    keys: typeof import("@/server/db/queries/api-keys")
    logs: typeof import("@/server/db/queries/logs")
    audit: typeof import("@/server/db/queries/audit")
    rateLimit: typeof import("@/server/db/queries/rate-limit")
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
    process.env.DATABASE_URL = url
    test = await getTestDb()
    repo = {
      users: await import("@/server/db/queries/users"),
      invitations: await import("@/server/db/queries/invitations"),
      connections: await import("@/server/db/queries/google-connections"),
      spreadsheets: await import("@/server/db/queries/spreadsheets"),
      apis: await import("@/server/db/queries/api-configurations"),
      keys: await import("@/server/db/queries/api-keys"),
      logs: await import("@/server/db/queries/logs"),
      audit: await import("@/server/db/queries/audit"),
      rateLimit: await import("@/server/db/queries/rate-limit"),
    }
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  async function seedUser(role: "user" | "owner" = "user") {
    const stamp = randomUUID()
    return repo.users.createUser({
      googleSub: `sub-${stamp}`,
      email: `repo-${stamp}@example.com`,
      role,
    })
  }

  async function seedGraph(userId: string, label: string) {
    const connection = await repo.connections.upsertConnection({
      userId,
      googleEmail: `sheets-${label}@example.com`,
      refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
      scope: "openid email https://www.googleapis.com/auth/spreadsheets",
    })
    const spreadsheet = await repo.spreadsheets.upsertSpreadsheet({
      userId,
      connectionId: connection.id,
      googleSheetId: `sheet-${label}`,
      title: "Roster",
      tabs: [{ id: 0, title: "Sheet1", rows: 100, columns: 26 }],
    })
    const api = await repo.apis.createApiConfiguration({
      userId,
      spreadsheetId: spreadsheet.id,
      name: `Roster API ${label}`,
      tabTitle: "Sheet1",
      headerRow: 1,
      permissions: "read",
      allowedOperations: ["GET"],
    })
    const key = await repo.keys.createApiKey({
      userId,
      name: `key-${label}`,
      keyHash: `kh-${randomUUID()}`,
      keyPreview: "sz_live_ab12wxyz",
      scopes: ["read"],
      allowedApiIds: null,
      expiresAt: null,
    })
    return { connection, spreadsheet, api, key }
  }

  it("writes the user, profile, invitation, redemption and audit rows the auth flow needs", async () => {
    const owner = await seedUser("owner")
    const [first, second] = await repo.invitations.insertInvitations(
      [
        { codeHash: `code-${randomUUID()}`, label: "for Rahim", maxUses: 2, expiresAt: null, createdBy: owner.id },
        { codeHash: `code-${randomUUID()}`, label: null, maxUses: 1, expiresAt: daysFromNow(1), createdBy: owner.id },
      ],
      test
    )
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    const invited = await repo.users.createUser(
      {
        googleSub: `sub-${randomUUID()}`,
        email: `invited-${randomUUID()}@example.com`,
        role: "user",
        invitationId: first.id,
      },
      test
    )
    expect(invited.invitationId).toBe(first.id)
    expect(invited.role).toBe("user")

    await repo.users.upsertUserProfile(
      { userId: invited.id, displayName: "Rahim", pictureUrl: "https://example.test/avatar.png" },
      test
    )
    await repo.invitations.recordRedemption({ invitationId: first.id, redeemedBy: invited.id }, test)
    await repo.audit.writeAudit({
      actorId: owner.id,
      action: "invitation.create",
      subjectType: "invitation",
      subjectId: first.id,
      detail: { maxUses: 2 },
    })
    await repo.audit.writeAudit({ actorId: null, action: "owner.bootstrap", subjectType: "user", subjectId: owner.id })

    const [profile] = await test.select().from(userProfiles).where(eq(userProfiles.userId, invited.id))
    expect(profile.displayName).toBe("Rahim")
    expect(profile.theme).toBe("dark")
    expect(profile.dashboardPrefs).toEqual({})

    const [invitation] = await test.select().from(invitations).where(eq(invitations.id, first.id))
    expect(invitation.uses).toBe(0)
    const [redemption] = await test.select().from(invitationRedemptions)
    expect(redemption.invitationId).toBe(first.id)
    expect(redemption.redeemedBy).toBe(invited.id)

    const listed = await repo.invitations.listInvitations()
    expect(listed).toHaveLength(2)
    for (const row of listed) {
      expect(row).not.toHaveProperty("codeHash")
    }

    expect(await repo.audit.listAudit({ actorId: owner.id, limit: 10 })).toHaveLength(1)
    const subjectRows = await repo.audit.listAudit({
      subjectType: "user",
      subjectId: owner.id,
      limit: 10,
    })
    expect(subjectRows[0].actorId).toBeNull()
    expect(subjectRows[0].detail).toEqual({})
    expect(await repo.audit.listAudit({ limit: 10 })).toHaveLength(2)

    await repo.users.upsertUserProfile({ userId: invited.id, displayName: "Rahim Uddin" })
    const [afterUpsert] = await test.select().from(userProfiles).where(eq(userProfiles.userId, invited.id))
    expect(afterUpsert.displayName).toBe("Rahim Uddin")
    expect(afterUpsert.pictureUrl).toBe("https://example.test/avatar.png")
  })

  it("records last login, status and role changes on the live row", async () => {
    const user = await seedUser()
    expect(user.lastLoginAt).toBeNull()

    await repo.users.touchLastLogin(user.id)
    const touched = await repo.users.findUserById(user.id)
    expect(touched?.lastLoginAt).toBeInstanceOf(Date)
    expect((await repo.users.findUserByGoogleSub(user.googleSub))?.id).toBe(user.id)

    const disabled = await repo.users.setUserStatus(user.id, "disabled")
    expect(disabled?.status).toBe("disabled")
    const promoted = await repo.users.setRole(user.id, "owner")
    expect(promoted?.role).toBe("owner")
    expect((await repo.users.findUserById(user.id))?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      touched?.updatedAt.getTime() ?? 0
    )

    expect(await repo.users.setUserStatus(randomUUID(), "active")).toBeUndefined()
    expect(await repo.users.setRole(randomUUID(), "user")).toBeUndefined()
    expect(await repo.users.findUserByGoogleSub(`nope-${randomUUID()}`)).toBeUndefined()
  })

  it("redeems a single-use code once and refuses revoked, expired and unknown codes", async () => {
    const owner = await seedUser("owner")
    const single = `code-${randomUUID()}`
    const [one] = await repo.invitations.insertInvitations(
      [{ codeHash: single, label: null, maxUses: 1, expiresAt: null, createdBy: owner.id }],
      test
    )

    expect(await repo.invitations.redeemInvitation(single, test)).toBe(one.id)
    expect(await repo.invitations.redeemInvitation(single, test)).toBeNull()
    const [spent] = await test.select({ uses: invitations.uses }).from(invitations).where(eq(invitations.id, one.id))
    expect(spent.uses).toBe(1)

    const expired = `code-${randomUUID()}`
    const revoked = `code-${randomUUID()}`
    const [timed, killable] = await repo.invitations.insertInvitations(
      [
        { codeHash: expired, label: null, maxUses: 5, expiresAt: daysFromNow(-1), createdBy: owner.id },
        { codeHash: revoked, label: null, maxUses: 5, expiresAt: null, createdBy: owner.id },
      ],
      test
    )
    expect(await repo.invitations.redeemInvitation(expired, test)).toBeNull()
    expect(await repo.invitations.redeemInvitation(revoked, test)).toBe(killable.id)

    await repo.invitations.revokeInvitation(killable.id)
    await repo.invitations.revokeInvitation(killable.id)
    expect(await repo.invitations.redeemInvitation(revoked, test)).toBeNull()
    expect(await repo.invitations.redeemInvitation(`code-${randomUUID()}`, test)).toBeNull()

    const [row] = await test.select().from(invitations).where(eq(invitations.id, killable.id))
    expect(row.revokedAt).toBeInstanceOf(Date)
    expect(row.uses).toBe(1)
    expect(timed.uses === undefined || timed.uses === 0).toBe(true)
  })

  it("elects exactly one winner when two redemptions race a single-use code", async () => {
    const owner = await seedUser("owner")
    const code = `code-${randomUUID()}`
    const [invitation] = await repo.invitations.insertInvitations(
      [{ codeHash: code, label: null, maxUses: 1, expiresAt: null, createdBy: owner.id }],
      test
    )

    const results = await Promise.all([
      repo.invitations.redeemInvitation(code, test),
      repo.invitations.redeemInvitation(code, test),
    ])
    expect(results.filter((id) => id === invitation.id)).toHaveLength(1)
    expect(results.filter((id) => id === null)).toHaveLength(1)

    const [row] = await test.select({ uses: invitations.uses }).from(invitations).where(eq(invitations.id, invitation.id))
    expect(row.uses).toBe(1)
  })

  it("rolls the redemption counter, the user and the audit rows back with the transaction", async () => {
    const owner = await seedUser("owner")
    const code = `code-${randomUUID()}`
    const [invitation] = await repo.invitations.insertInvitations(
      [{ codeHash: code, label: null, maxUses: 1, expiresAt: null, createdBy: owner.id }],
      test
    )

    await expect(
      test.transaction(async (tx) => {
        expect(await repo.invitations.redeemInvitation(code, tx)).toBe(invitation.id)
        const created = await repo.users.createUser(
          {
            googleSub: `sub-${randomUUID()}`,
            email: `rolledback-${randomUUID()}@example.com`,
            role: "user",
            invitationId: invitation.id,
          },
          tx
        )
        await repo.invitations.recordRedemption({ invitationId: invitation.id, redeemedBy: created.id }, tx)
        throw new Error("forced rollback")
      })
    ).rejects.toThrow("forced rollback")

    const [row] = await test.select().from(invitations).where(eq(invitations.id, invitation.id))
    expect(row.uses).toBe(0)
    expect(await test.select().from(invitationRedemptions)).toHaveLength(0)
    expect(await test.select().from(users)).toHaveLength(1)

    expect(await repo.invitations.redeemInvitation(code, test)).toBe(invitation.id)
  })

  it("fires the documented UNIQUE, CHECK and FK constraints through the modules", async () => {
    const alice = await seedUser()
    const bob = await seedUser()

    const duplicateSub = await repo.users
      .createUser({ googleSub: alice.googleSub, email: `dup-${randomUUID()}@example.com`, role: "user" })
      .catch((error: unknown) => error)
    expect(pgConstraint(duplicateSub)).toBe("users_google_sub_unique")

    const bogusRole = await repo.users
      .setRole(bob.id, "admin" as unknown as "user")
      .catch((error: unknown) => error)
    expect(pgConstraint(bogusRole)).toBe("users_role_check")
    expect((await repo.users.findUserById(bob.id))?.role).toBe("user")

    const bogusStatus = await repo.users
      .setUserStatus(bob.id, "deleted" as unknown as "active")
      .catch((error: unknown) => error)
    expect(pgConstraint(bogusStatus)).toBe("users_status_check")

    const codeHash = `code-${randomUUID()}`
    await repo.invitations.insertInvitations(
      [{ codeHash, label: null, maxUses: 1, expiresAt: null, createdBy: alice.id }],
      test
    )
    const duplicateCode = await repo.invitations
      .insertInvitations([{ codeHash, label: null, maxUses: 1, expiresAt: null, createdBy: alice.id }], test)
      .catch((error: unknown) => error)
    expect(pgConstraint(duplicateCode)).toBe("invitations_code_hash_unique")

    const bobGraph = await seedGraph(bob.id, "foreign")
    // `spreadsheet_id` is a plain FK (database-schema.md), so a row owned by another user
    // satisfies it: ownership is enforced by the app, and ON DELETE CASCADE is the result.
    const borrowed = await repo.apis.createApiConfiguration({
      userId: alice.id,
      spreadsheetId: bobGraph.spreadsheet.id,
      name: "Borrowed",
      tabTitle: "Sheet1",
      headerRow: 1,
      permissions: "read",
      allowedOperations: ["GET"],
    })
    expect(borrowed.spreadsheetId).toBe(bobGraph.spreadsheet.id)

    const dangling = await repo.apis
      .createApiConfiguration({
        userId: alice.id,
        spreadsheetId: randomUUID(),
        name: "Dangling",
        tabTitle: "Sheet1",
        headerRow: 1,
        permissions: "read",
        allowedOperations: ["GET"],
      })
      .catch((error: unknown) => error)
    expect(pgConstraint(dangling)).toBe("api_configurations_spreadsheet_id_registered_spreadsheets_id_fk")

    await repo.spreadsheets.deleteSpreadsheet(bob.id, bobGraph.spreadsheet.id)
    expect(await repo.apis.findApiConfiguration(alice.id, borrowed.id)).toBeUndefined()
  })

  it("rejects a bogus permissions value and a header row below 1", async () => {
    const alice = await seedUser()
    const graph = await seedGraph(alice.id, "checks")

    const badHeader = await repo.apis
      .createApiConfiguration({
        userId: alice.id,
        spreadsheetId: graph.spreadsheet.id,
        name: "Zero header",
        tabTitle: "Sheet1",
        headerRow: 0,
        permissions: "read",
        allowedOperations: ["GET"],
      })
      .catch((error: unknown) => error)
    expect(pgConstraint(badHeader)).toBe("api_configurations_header_row_check")

    const badPermissions = await repo.apis
      .createApiConfiguration({
        userId: alice.id,
        spreadsheetId: graph.spreadsheet.id,
        name: "Writey",
        tabTitle: "Sheet1",
        headerRow: 1,
        permissions: "read_write_delete" as unknown as "read",
        allowedOperations: ["GET"],
      })
      .catch((error: unknown) => error)
    expect(pgConstraint(badPermissions)).toBe("api_configurations_permissions_check")
  })

  it("scopes every user-facing finder and delete to its owner, and leaves the engine lookups open", async () => {
    const alice = await seedUser()
    const bob = await seedUser()
    const a = await seedGraph(alice.id, "alice")
    const b = await seedGraph(bob.id, "bob")

    expect(await repo.connections.findConnectionForUser(alice.id, b.connection.id)).toBeUndefined()
    expect(await repo.spreadsheets.findSpreadsheet(alice.id, b.spreadsheet.id)).toBeUndefined()
    expect(await repo.apis.findApiConfiguration(alice.id, b.api.id)).toBeUndefined()
    expect(await repo.apis.updateApiConfiguration(alice.id, b.api.id, { name: "hijacked" })).toBeUndefined()
    expect(await repo.connections.listConnections(alice.id)).toHaveLength(1)
    expect(await repo.spreadsheets.listSpreadsheets(alice.id)).toHaveLength(1)
    expect(await repo.apis.listApiConfigurations(alice.id)).toHaveLength(1)

    const engineApi = await repo.apis.findApiConfigurationById(b.api.id)
    const engineKey = await repo.keys.findApiKeyByHash(b.key.keyHash)
    expect(engineApi?.userId).toBe(bob.id)
    expect(engineKey?.userId).toBe(bob.id)
    const aliceKey = await repo.keys.findApiKeyByHash(a.key.keyHash)
    expect(aliceKey?.userId).toBe(alice.id)
    expect(aliceKey?.userId).not.toBe(engineApi?.userId)

    await repo.keys.revokeApiKey(alice.id, b.key.id)
    expect(await repo.keys.findApiKeyByHash(b.key.keyHash)).toBeDefined()
    await repo.keys.revokeApiKey(bob.id, b.key.id)
    expect(await repo.keys.findApiKeyByHash(b.key.keyHash)).toBeUndefined()

    await repo.connections.deleteConnection(b.connection.id, alice.id)
    await repo.spreadsheets.deleteSpreadsheet(alice.id, b.spreadsheet.id)
    await repo.apis.deleteApiConfiguration(alice.id, b.api.id)
    expect(await repo.connections.listConnections(bob.id)).toHaveLength(1)
    expect(await repo.spreadsheets.listSpreadsheets(bob.id)).toHaveLength(1)
    expect(await repo.apis.listApiConfigurations(bob.id)).toHaveLength(1)

    await repo.connections.deleteConnection(b.connection.id, bob.id)
    expect(await repo.connections.listConnections(bob.id)).toHaveLength(0)
    expect(await repo.spreadsheets.listSpreadsheets(bob.id)).toHaveLength(0)
  })

  it("upserts on the documented unique keys and keeps usage writes throttled", async () => {
    const alice = await seedUser()
    const graph = await seedGraph(alice.id, "idempotent")

    const reconnected = await repo.connections.upsertConnection({
      userId: alice.id,
      googleEmail: graph.connection.googleEmail,
      refreshTokenEnc: "bmV3LWNpcGhlcnRleHQ=",
      scope: "openid email",
    })
    expect(reconnected.id).toBe(graph.connection.id)
    expect(reconnected.refreshTokenEnc).toBe("bmV3LWNpcGhlcnRleHQ=")
    expect(reconnected.status).toBe("connected")
    expect(await repo.connections.listConnections(alice.id)).toHaveLength(1)

    const secondAccount = await repo.connections.upsertConnection({
      userId: alice.id,
      googleEmail: `second-${randomUUID()}@example.com`,
      refreshTokenEnc: "eG==",
      scope: "openid",
    })
    expect(await repo.connections.listConnections(alice.id)).toHaveLength(2)

    await repo.connections.markConnectionStatus(secondAccount.id, "reauth_required")
    expect((await repo.connections.findConnectionForUser(alice.id))?.id).toBe(graph.connection.id)
    await repo.connections.markConnectionStatus(graph.connection.id, "disconnected")
    expect(await repo.connections.findConnectionForUser(alice.id)).toBeUndefined()
    expect((await repo.connections.findConnectionForUser(alice.id, graph.connection.id))?.id).toBe(
      graph.connection.id
    )

    await repo.connections.touchConnectionUsed(graph.connection.id)
    const used = await repo.connections.findConnectionForUser(alice.id, graph.connection.id)
    expect(used?.lastUsedAt).toBeInstanceOf(Date)

    const refreshed = await repo.spreadsheets.upsertSpreadsheet({
      userId: alice.id,
      connectionId: graph.connection.id,
      googleSheetId: graph.spreadsheet.googleSheetId,
      title: "Roster 2026",
      tabs: [
        { id: 0, title: "Sheet1", rows: 200, columns: 26 },
        { id: 1, title: "Invoices", rows: 50, columns: 8 },
      ],
    })
    expect(refreshed.id).toBe(graph.spreadsheet.id)
    expect(refreshed.title).toBe("Roster 2026")
    expect(refreshed.tabs).toHaveLength(2)

    await repo.spreadsheets.setSpreadsheetStatus(graph.spreadsheet.id, "inaccessible")
    expect((await repo.spreadsheets.findSpreadsheet(alice.id, graph.spreadsheet.id))?.status).toBe("inaccessible")
    await repo.spreadsheets.updateSpreadsheetTabs(
      graph.spreadsheet.id,
      [{ id: 0, title: "Sheet1", rows: 300, columns: 26 }],
      "Roster 300"
    )
    const retabbed = await repo.spreadsheets.findSpreadsheet(alice.id, graph.spreadsheet.id)
    expect(retabbed?.tabs).toEqual([{ id: 0, title: "Sheet1", rows: 300, columns: 26 }])
    expect(retabbed?.title).toBe("Roster 300")

    await repo.keys.touchKeyUsed(graph.key.id)
    const firstUse = (await repo.keys.findApiKeyByHash(graph.key.keyHash))?.lastUsedAt
    expect(firstUse).toBeInstanceOf(Date)
    await repo.keys.touchKeyUsed(graph.key.id)
    expect((await repo.keys.findApiKeyByHash(graph.key.keyHash))?.lastUsedAt).toEqual(firstUse)
    expect(await repo.keys.listApiKeys(alice.id)).toHaveLength(1)
  })

  it("round-trips an api configuration through create, patch, enable and delete", async () => {
    const alice = await seedUser()
    const graph = await seedGraph(alice.id, "crud")

    const writable = await repo.apis.createApiConfiguration({
      userId: alice.id,
      spreadsheetId: graph.spreadsheet.id,
      name: "Writable",
      description: "all the verbs",
      tabTitle: "Sheet1",
      headerRow: 2,
      primaryKeyColumn: "id",
      permissions: "read_write",
      allowedOperations: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      rateLimitPerHour: 500,
    })
    expect(writable.enabled).toBe(true)
    expect(writable.allowedOperations).toHaveLength(5)
    expect(writable.rateLimitPerHour).toBe(500)
    expect(await repo.apis.listApiConfigurations(alice.id)).toHaveLength(2)

    const patched = await repo.apis.updateApiConfiguration(alice.id, writable.id, {
      name: "Writable v2",
      description: null,
      headerRow: 3,
      primaryKeyColumn: null,
      permissions: "read",
      allowedOperations: ["GET"],
      rateLimitPerHour: null,
    })
    expect(patched?.name).toBe("Writable v2")
    expect(patched?.description).toBeNull()
    expect(patched?.headerRow).toBe(3)
    expect(patched?.primaryKeyColumn).toBeNull()
    expect(patched?.permissions).toBe("read")
    expect(patched?.rateLimitPerHour).toBeNull()
    expect(patched!.updatedAt.getTime()).toBeGreaterThanOrEqual(writable.updatedAt.getTime())

    await repo.apis.setApiEnabled(alice.id, writable.id, false)
    expect((await repo.apis.findApiConfiguration(alice.id, writable.id))?.enabled).toBe(false)
    expect((await repo.apis.findApiConfigurationById(writable.id))?.enabled).toBe(false)

    await repo.apis.deleteApiConfiguration(alice.id, graph.api.id)
    expect(await repo.apis.listApiConfigurations(alice.id)).toHaveLength(1)
    expect(await repo.apis.findApiConfigurationById(graph.api.id)).toBeUndefined()
  })

  it("paginates and filters request logs, newest first, with a stable total", async () => {
    const alice = await seedUser()
    const graph = await seedGraph(alice.id, "logs")
    for (let index = 0; index < 5; index += 1) {
      await repo.logs.insertRequestLog({
        apiId: graph.api.id,
        userId: alice.id,
        apiKeyId: graph.key.id,
        method: index === 4 ? "POST" : "GET",
        path: `/api/v1/${graph.api.id}`,
        statusCode: index === 4 ? 500 : 200,
        durationMs: 10 + index,
        requestBytes: index === 4 ? null : 42,
        errorCategory: index === 4 ? "internal" : null,
        origin: "https://sheet.zaber.tech",
      })
    }
    await repo.logs.insertRequestLog({
      method: "GET",
      path: `/api/v1/${randomUUID()}`,
      statusCode: 404,
      durationMs: 3,
      errorCategory: "not_found",
    })

    const firstPage = await repo.logs.listRequestLogs({ userId: alice.id, page: 1, perPage: 2 })
    expect(firstPage.total).toBe(5)
    expect(firstPage.rows).toHaveLength(2)
    expect(firstPage.rows[0].id).toBeGreaterThan(firstPage.rows[1].id)
    expect(firstPage.rows[0].createdAt).toBeInstanceOf(Date)

    const pages = await Promise.all(
      [1, 2, 3, 4].map((page) => repo.logs.listRequestLogs({ userId: alice.id, page, perPage: 2 }))
    )
    expect(pages.map((page) => page.rows.length)).toEqual([2, 2, 1, 0])
    expect(new Set(pages.flatMap((page) => page.rows.map((row) => row.id))).size).toBe(5)
    expect(pages.every((page) => page.total === 5)).toBe(true)

    const posted = await repo.logs.listRequestLogs({ userId: alice.id, method: "POST", page: 1, perPage: 10 })
    expect(posted.rows).toHaveLength(1)
    expect(posted.rows[0].statusCode).toBe(500)

    const failed = await repo.logs.listRequestLogs({ userId: alice.id, status: "failed", page: 1, perPage: 10 })
    expect(failed.total).toBe(1)
    const success = await repo.logs.listRequestLogs({ userId: alice.id, status: "success", page: 1, perPage: 10 })
    expect(success.total).toBe(4)

    const scoped = await repo.logs.listRequestLogs({
      userId: alice.id,
      apiId: graph.api.id,
      status: "success",
      from: daysFromNow(-1),
      to: daysFromNow(1),
      page: 1,
      perPage: 10,
    })
    expect(scoped).toMatchObject({ total: 4 })
    expect(scoped.rows).toHaveLength(4)

    expect(
      (await repo.logs.listRequestLogs({ userId: alice.id, apiId: randomUUID(), page: 1, perPage: 10 })).total
    ).toBe(0)
    expect(
      (
        await repo.logs.listRequestLogs({
          userId: alice.id,
          from: daysFromNow(1),
          to: daysFromNow(2),
          page: 1,
          perPage: 10,
        })
      ).rows
    ).toHaveLength(0)
  })

  it("agrees between the rows written and the SQL aggregates, then prunes to retention", async () => {
    const alice = await seedUser()
    const bob = await seedUser()
    const graph = await seedGraph(alice.id, "analytics")
    for (let index = 0; index < 5; index += 1) {
      await repo.logs.insertRequestLog({
        apiId: graph.api.id,
        userId: alice.id,
        apiKeyId: graph.key.id,
        method: "GET",
        path: `/api/v1/${graph.api.id}`,
        statusCode: index === 4 ? 404 : 200,
        durationMs: 10 + index,
        errorCategory: index === 4 ? "not_found" : null,
      })
    }
    await repo.logs.insertRequestLog({
      method: "GET",
      path: `/api/v1/${randomUUID()}`,
      statusCode: 404,
      durationMs: 3,
      errorCategory: "not_found",
    })

    const overview = await repo.logs.analyticsOverview(alice.id, daysFromNow(-1), daysFromNow(1))
    expect(overview.requests).toBe(5)
    expect(overview.success).toBe(4)
    expect(overview.failed).toBe(1)
    expect(overview.success + overview.failed).toBe(overview.requests)
    expect(overview.byDay.length).toBeGreaterThan(0)
    expect(overview.byDay.reduce((sum, day) => sum + day.count, 0)).toBe(overview.requests)
    for (const day of overview.byDay) expect(day.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    expect(await repo.logs.analyticsByApi(alice.id)).toEqual([
      { apiId: graph.api.id, name: `Roster API analytics`, count: 5, errors: 1 },
    ])
    expect((await repo.logs.analyticsOverview(bob.id, daysFromNow(-1), daysFromNow(1))).requests).toBe(0)
    expect(await repo.logs.analyticsByApi(bob.id)).toEqual([])

    const pool = await getTestPool()
    await pool.query(
      `INSERT INTO api_request_logs (method, path, status_code, duration_ms, user_id, created_at)
       VALUES ('GET', '/api/v1/ancient', 200, 1, $1, now() - interval '200 days')`,
      [alice.id]
    )
    expect((await repo.logs.analyticsOverview(alice.id, daysFromNow(-30), daysFromNow(1))).requests).toBe(5)
    expect(await repo.logs.pruneOldLogs(90)).toBe(1)
    expect((await repo.logs.listRequestLogs({ userId: alice.id, page: 1, perPage: 50 })).total).toBe(5)
  })

  it("allows N requests per window, then denies with a positive retry-after and rolls over", async () => {
    const bucketKey = `key:${randomUUID()}:h`
    expect(await repo.rateLimit.consumeRateBucket(bucketKey, 60, 2)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 0,
    })
    const second = await repo.rateLimit.consumeRateBucket(bucketKey, 60, 2)
    expect(second).toMatchObject({ allowed: true, remaining: 0 })

    const third = await repo.rateLimit.consumeRateBucket(bucketKey, 60, 2)
    expect(third.allowed).toBe(false)
    expect(third.remaining).toBe(0)
    expect(third.retryAfterSeconds).toBeGreaterThan(0)
    expect(third.retryAfterSeconds).toBeLessThanOrEqual(60)

    expect((await repo.rateLimit.consumeRateBucket(`api:${randomUUID()}:d`, 60, 1)).allowed).toBe(true)

    const rolling = `key:${randomUUID()}:s`
    expect((await repo.rateLimit.consumeRateBucket(rolling, 1, 1)).allowed).toBe(true)
    expect((await repo.rateLimit.consumeRateBucket(rolling, 1, 1)).allowed).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect((await repo.rateLimit.consumeRateBucket(rolling, 1, 1)).allowed).toBe(true)
  })

  it("truncates every schema table and keeps the list aligned with schema.ts", async () => {
    const alice = await seedUser()
    await seedGraph(alice.id, "truncate")

    expect([...TEST_TABLE_NAMES]).toEqual([...SCHEMA_TABLE_NAMES].sort())

    await truncateAll()
    const pool = await getTestPool()
    for (const name of TEST_TABLE_NAMES) {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${name}"`)
      expect(rows[0].n, name).toBe(0)
    }
  })
})
