import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import type { SnippetMethod } from "@/lib/snippets"
import { apiConfigurations } from "@/server/db/schema"

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
 * Integration coverage for the owner-facing API-configuration service and the engine's
 * `resolveEngineApi` resolver (`backend-api-contract.md` §4.6/§4.7, `database-schema.md` D9).
 * Real ephemeral PostgreSQL 16 through the shared harness; seeding uses ONLY the green query
 * modules, so a broken fixture can never masquerade as a broken service.
 */

type ApisService = typeof import("@/server/apis/service")
type ConnectionsModule = typeof import("@/server/db/queries/google-connections")
type SpreadsheetsModule = typeof import("@/server/db/queries/spreadsheets")
type UsersModule = typeof import("@/server/db/queries/users")
/** The JSONB tab snapshot, read off the repository's own return type. */
type SpreadsheetTab = Awaited<ReturnType<SpreadsheetsModule["upsertSpreadsheet"]>>["tabs"][number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** §4.6 `ApiConfig` — the exact dashboard payload, no more and no less. */
const API_CONFIG_KEYS = [
  "allowedOperations",
  "createdAt",
  "description",
  "enabled",
  "exposedColumns",
  "headerRow",
  "id",
  "name",
  "permissions",
  "primaryKeyColumn",
  "rateLimitPerHour",
  "spreadsheetId",
  "tabTitle",
  "updatedAt",
]

/** `EngineApi` — what the public data path may see. */
const ENGINE_API_KEYS = [
  "allowedOperations",
  "connectionId",
  "exposedColumns",
  "googleSheetId",
  "headerRow",
  "id",
  "permissions",
  "primaryKeyColumn",
  "spreadsheetId",
  "tabTitle",
  "userId",
]

const SHEET1 = { id: 0, title: "Sheet1", rows: 100, columns: 26 }
const PEOPLE = { id: 1, title: "People", rows: 50, columns: 8 }

/** The smallest legal create input; every test spreads it and overrides what it is about. */
const baseInput = {
  name: "Roster API",
  tabTitle: "Sheet1",
  headerRow: 1,
  permissions: "read" as const,
  allowedOperations: ["GET"] as SnippetMethod[],
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000)
}

function isFail(result: object): result is { error: { code: string; message: string; category: string; fields?: Record<string, string> } } {
  return "error" in result
}

let test: TestDb
let service: ApisService
let users: UsersModule
let connections: ConnectionsModule
let sheets: SpreadsheetsModule

describe("api configuration service", () => {
  beforeAll(async () => {
    let url: string
    try {
      url = inject(TEST_DB_URL_KEY)
    } catch {
      await startTestDb()
      await migrateTestDb()
      url = getTestDbUrl()
    }
    // Before the service loads, so production's `db` client binds the ephemeral instance.
    process.env.DATABASE_URL = url
    test = await getTestDb()
    service = await import("@/server/apis/service")
    users = await import("@/server/db/queries/users")
    connections = await import("@/server/db/queries/google-connections")
    sheets = await import("@/server/db/queries/spreadsheets")
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  async function seedUser(label: string) {
    const stamp = randomUUID()
    return users.createUser({
      googleSub: `sub-${stamp}`,
      email: `apis-${label}-${stamp}@example.com`,
      role: "user",
    })
  }

  async function seedSpreadsheet(
    userId: string,
    label: string,
    tabs: SpreadsheetTab[] = [SHEET1, PEOPLE]
  ) {
    const connection = await connections.upsertConnection({
      userId,
      googleEmail: `sheets-${label}-${randomUUID()}@example.com`,
      refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
      scope: "openid email https://www.googleapis.com/auth/spreadsheets",
    })
    const spreadsheet = await sheets.upsertSpreadsheet({
      userId,
      connectionId: connection.id,
      googleSheetId: `sheet-${label}-${randomUUID()}`,
      title: `Roster ${label}`,
      tabs,
    })
    return { connection, spreadsheet }
  }

  /** A legal config for `userId`, created straight through the service. */
  async function seedApi(userId: string, label: string, overrides: Record<string, unknown> = {}) {
    const { connection, spreadsheet } = await seedSpreadsheet(userId, label)
    const result = await service.createApi(
      { ...baseInput, spreadsheetId: spreadsheet.id, ...overrides },
      userId
    )
    if (!result.ok) throw new Error(`seed api failed: ${result.error.code} ${JSON.stringify(result.error.fields ?? {})}`)
    return { connection, spreadsheet, api: result.data }
  }

  describe("createApi", () => {
    it("creates the row whose uuid PK is the public api_id and returns exactly the §4.6 payload", async () => {
      const alice = await seedUser("create")
      const { spreadsheet } = await seedSpreadsheet(alice.id, "create")

      const result = await service.createApi(
        {
          ...baseInput,
          spreadsheetId: spreadsheet.id,
          name: "Roster v2",
          description: "team roster",
          headerRow: 2,
          primaryKeyColumn: "id",
          permissions: "read_write",
          allowedOperations: ["GET", "POST", "PATCH"],
          rateLimitPerHour: 500,
        },
        alice.id
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(Object.keys(result.data).sort()).toEqual(API_CONFIG_KEYS)
      expect(result.data.id).toMatch(UUID_RE)
      expect(result.data).toMatchObject({
        spreadsheetId: spreadsheet.id,
        name: "Roster v2",
        description: "team roster",
        tabTitle: "Sheet1",
        headerRow: 2,
        primaryKeyColumn: "id",
        permissions: "read_write",
        allowedOperations: ["GET", "POST", "PATCH"],
        enabled: true,
        rateLimitPerHour: 500,
      })
      // The id is the public api_id: the engine resolver finds it.
      expect((await service.resolveEngineApi(result.data.id))?.id).toBe(result.data.id)
      expect((await service.getApi(result.data.id, alice.id)).ok).toBe(true)
      expect(await service.listApis(alice.id)).toMatchObject({ ok: true, data: [result.data] })
    })

    it("applies the schema defaults so a minimal config is legal", async () => {
      const alice = await seedUser("defaults")
      const { spreadsheet } = await seedSpreadsheet(alice.id, "defaults")

      const result = await service.createApi(
        { spreadsheetId: spreadsheet.id, name: "Minimal", tabTitle: "Sheet1" },
        alice.id
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data).toMatchObject({
        headerRow: 1,
        permissions: "read",
        allowedOperations: ["GET"],
        description: null,
        primaryKeyColumn: null,
        rateLimitPerHour: null,
      })
    })

    it("rejects a tabTitle absent from the snapshot, case-sensitively, and writes nothing", async () => {
      const alice = await seedUser("tab")
      const { spreadsheet } = await seedSpreadsheet(alice.id, "tab")

      for (const tabTitle of ["Missing", "sheet1", "SHEET1", "Sheet 1", "Sheet1s"]) {
        const result = await service.createApi(
          { ...baseInput, spreadsheetId: spreadsheet.id, tabTitle },
          alice.id
        )
        expect(isFail(result) && result.error.code).toBe("validation_failed")
        if (isFail(result)) {
          expect(result.error.category).toBe("validation")
          expect(Object.keys(result.error.fields ?? {})).toContain("tabTitle")
        }
      }

      // The snapshot's own title is accepted, and the second tab too.
      for (const tabTitle of ["Sheet1", "People"]) {
        const result = await service.createApi(
          { ...baseInput, spreadsheetId: spreadsheet.id, tabTitle },
          alice.id
        )
        expect(result.ok).toBe(true)
      }

      // `apiConfigSchema` trims tabTitle, so surrounding spaces are the SAME title, not a new one.
      const trimmed = await service.createApi(
        { ...baseInput, spreadsheetId: spreadsheet.id, tabTitle: "  Sheet1  " },
        alice.id
      )
      expect(trimmed.ok).toBe(true)
    })

    it("refuses a read-only config that advertises a write verb, and accepts the same verbs as read_write", async () => {
      const alice = await seedUser("coherence")
      const { spreadsheet } = await seedSpreadsheet(alice.id, "coherence")

      for (const allowedOperations of [["POST"], ["GET", "PATCH"], ["GET", "PUT", "DELETE"]]) {
        const result = await service.createApi(
          {
            ...baseInput,
            spreadsheetId: spreadsheet.id,
            primaryKeyColumn: "id",
            allowedOperations: allowedOperations as SnippetMethod[],
          },
          alice.id
        )
        expect(isFail(result) && result.error.code).toBe("validation_failed")
        if (isFail(result)) expect(Object.keys(result.error.fields ?? {})).toContain("allowedOperations")
      }
      expect(await service.listApis(alice.id)).toMatchObject({ ok: true, data: [] })

      // Positive counterpart: the identical verb list is legal once permissions say read_write.
      const writable = await service.createApi(
        {
          ...baseInput,
          spreadsheetId: spreadsheet.id,
          primaryKeyColumn: "id",
          permissions: "read_write",
          allowedOperations: ["GET", "POST", "PATCH", "PUT", "DELETE"],
        },
        alice.id
      )
      expect(writable.ok).toBe(true)
    })

    it("refuses read_write that advertises no write verb", async () => {
      const alice = await seedUser("rw")
      const { spreadsheet } = await seedSpreadsheet(alice.id, "rw")

      const result = await service.createApi(
        { ...baseInput, spreadsheetId: spreadsheet.id, permissions: "read_write" },
        alice.id
      )
      expect(isFail(result) && result.error.code).toBe("validation_failed")
      if (isFail(result)) expect(Object.keys(result.error.fields ?? {})).toContain("permissions")

      // POST (which needs no primary key) is enough to make read_write coherent.
      const okResult = await service.createApi(
        {
          ...baseInput,
          spreadsheetId: spreadsheet.id,
          permissions: "read_write",
          allowedOperations: ["POST"],
        },
        alice.id
      )
      expect(okResult.ok).toBe(true)
    })

    it("requires a non-empty primaryKeyColumn for PATCH, PUT and DELETE (D9)", async () => {
      const alice = await seedUser("d9")
      const { spreadsheet } = await seedSpreadsheet(alice.id, "d9")

      for (const verb of ["PATCH", "PUT", "DELETE"]) {
        const result = await service.createApi(
          {
            ...baseInput,
            spreadsheetId: spreadsheet.id,
            permissions: "read_write",
            allowedOperations: ["GET", verb as SnippetMethod],
          },
          alice.id
        )
        expect(isFail(result) && result.error.code).toBe("validation_failed")
        if (isFail(result)) expect(Object.keys(result.error.fields ?? {})).toContain("primaryKeyColumn")

        const blank = await service.createApi(
          {
            ...baseInput,
            spreadsheetId: spreadsheet.id,
            primaryKeyColumn: "   ",
            permissions: "read_write",
            allowedOperations: ["GET", verb as SnippetMethod],
          },
          alice.id
        )
        expect(isFail(blank) && blank.error.code).toBe("validation_failed")

        const fixed = await service.createApi(
          {
            ...baseInput,
            spreadsheetId: spreadsheet.id,
            primaryKeyColumn: "record_id",
            permissions: "read_write",
            allowedOperations: ["GET", verb as SnippetMethod],
          },
          alice.id
        )
        expect(fixed.ok).toBe(true)
      }
    })

    it("reports zod failures with the per-field messages §4.4 requires", async () => {
      const alice = await seedUser("zod")
      const { spreadsheet } = await seedSpreadsheet(alice.id, "zod")

      const cases: { patch: Record<string, unknown>; field: string }[] = [
        { patch: { name: "" }, field: "name" },
        { patch: { headerRow: 0 }, field: "headerRow" },
        { patch: { headerRow: 1.5 }, field: "headerRow" },
        { patch: { allowedOperations: [] }, field: "allowedOperations" },
        { patch: { allowedOperations: ["GET", "OPTIONS"] }, field: "allowedOperations" },
        { patch: { permissions: "delete_me" }, field: "permissions" },
        { patch: { spreadsheetId: "not-a-uuid" }, field: "spreadsheetId" },
        { patch: { tabTitle: "" }, field: "tabTitle" },
      ]
      for (const { patch, field } of cases) {
        const result = await service.createApi(
          { ...baseInput, spreadsheetId: spreadsheet.id, ...patch },
          alice.id
        )
        expect(isFail(result) && result.error.code).toBe("validation_failed")
        if (isFail(result)) expect(Object.keys(result.error.fields ?? {})).toContain(field)
      }

      // Non-object input cannot reach the DB at all.
      for (const junk of [null, undefined, "string", 42, ["GET"]]) {
        const result = await service.createApi(junk, alice.id)
        expect(isFail(result) && result.error.code).toBe("validation_failed")
      }
      // Nothing half-written: every rejection above left no row behind.
      expect(await service.listApis(alice.id)).toMatchObject({ ok: true, data: [] })
    })

    it("treats another user's spreadsheet id as not_found and writes nothing", async () => {
      const alice = await seedUser("owner-a")
      const bob = await seedUser("owner-b")
      const bobSheet = await seedSpreadsheet(bob.id, "foreign")

      const result = await service.createApi(
        { ...baseInput, spreadsheetId: bobSheet.spreadsheet.id },
        alice.id
      )
      expect(result).toEqual({
        error: { code: "not_found", message: "No API was found with that id.", category: "not_found" },
      })
      expect(await service.listApis(alice.id)).toMatchObject({ ok: true, data: [] })

      // An unknown spreadsheet id reads exactly the same way — no existence oracle.
      const missing = await service.createApi(
        { ...baseInput, spreadsheetId: randomUUID() },
        alice.id
      )
      expect(missing).toEqual(result)
    })
  })

  describe("updateApi", () => {
    it("patches only what was sent: a name-only update cannot replay the schema defaults", async () => {
      const alice = await seedUser("patch")
      const { api } = await seedApi(alice.id, "patch", {
        description: "keep me",
        headerRow: 3,
        primaryKeyColumn: "id",
        permissions: "read_write",
        allowedOperations: ["GET", "POST"],
        rateLimitPerHour: 500,
      })

      const result = await service.updateApi(
        api.id,
        { name: "Renamed", spreadsheetId: api.spreadsheetId, tabTitle: "Sheet1" },
        alice.id
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.name).toBe("Renamed")
      expect(result.data).toMatchObject({
        description: "keep me",
        headerRow: 3,
        permissions: "read_write",
        allowedOperations: ["GET", "POST"],
        primaryKeyColumn: "id",
        rateLimitPerHour: 500,
        enabled: true,
      })
      // Persisted, not merely returned.
      expect(await service.getApi(api.id, alice.id)).toMatchObject({ ok: true, data: result.data })
    })

    it("validates the MERGED shape, so a patch that breaks an invariant is refused and nothing is written", async () => {
      const alice = await seedUser("merged")
      const { api } = await seedApi(alice.id, "merged")

      const writePatch = { spreadsheetId: api.spreadsheetId, tabTitle: "Sheet1" }

      // Stored permissions=read + allowedOperations=[GET] gains read_write WITHOUT a write verb.
      const incoherent = await service.updateApi(
        api.id,
        { ...writePatch, permissions: "read_write" },
        alice.id
      )
      expect(isFail(incoherent) && incoherent.error.code).toBe("validation_failed")
      if (isFail(incoherent)) expect(Object.keys(incoherent.error.fields ?? {})).toContain("permissions")

      // Merged [GET, PATCH] while the stored primaryKeyColumn is NULL (D9 across the merge).
      const noPk = await service.updateApi(
        api.id,
        { ...writePatch, allowedOperations: ["GET", "PATCH"] },
        alice.id
      )
      expect(isFail(noPk) && noPk.error.code).toBe("validation_failed")
      if (isFail(noPk)) expect(Object.keys(noPk.error.fields ?? {})).toContain("primaryKeyColumn")

      // read-only merged with a write verb.
      const stillWriteable = await service.updateApi(
        api.id,
        { ...writePatch, permissions: "read", allowedOperations: ["GET", "POST"] },
        alice.id
      )
      expect(isFail(stillWriteable) && stillWriteable.error.code).toBe("validation_failed")
      if (isFail(stillWriteable)) expect(Object.keys(stillWriteable.error.fields ?? {})).toContain("allowedOperations")

      // Every refusal left the row untouched.
      expect(await service.getApi(api.id, alice.id)).toMatchObject({
        ok: true,
        data: { permissions: "read", allowedOperations: ["GET"], primaryKeyColumn: null },
      })

      // The same patches become legal once the merge is coherent.
      const coherent = await service.updateApi(
        api.id,
        {
          ...writePatch,
          permissions: "read_write",
          allowedOperations: ["GET", "PATCH"],
          primaryKeyColumn: "id",
        },
        alice.id
      )
      expect(coherent.ok).toBe(true)
      if (!coherent.ok) return
      expect(coherent.data).toMatchObject({
        permissions: "read_write",
        allowedOperations: ["GET", "PATCH"],
        primaryKeyColumn: "id",
      })

      // ...and dropping write ops again while dropping back to read is coherent too.
      const backToRead = await service.updateApi(
        api.id,
        { ...writePatch, permissions: "read", allowedOperations: ["GET"] },
        alice.id
      )
      expect(backToRead.ok).toBe(true)
    })

    it("re-validates tabTitle only when the (spreadsheet, tab) pair moves", async () => {
      const alice = await seedUser("tabmove")
      const { spreadsheet, api } = await seedApi(alice.id, "tabmove")
      const other = await seedSpreadsheet(alice.id, "tabmove-2", [PEOPLE])

      // Drift the snapshot so the stored "Sheet1" no longer exists upstream.
      await sheets.updateSpreadsheetTabs(spreadsheet.id, [PEOPLE], "Roster renamed")

      // Unchanged pair: the stale title is NOT re-validated, so the config stays editable.
      const renamedOnly = await service.updateApi(
        api.id,
        { name: "Still editable", spreadsheetId: spreadsheet.id, tabTitle: "Sheet1" },
        alice.id
      )
      expect(renamedOnly.ok).toBe(true)

      // Changing the tab now has to match the (new) snapshot.
      const badTab = await service.updateApi(
        api.id,
        { spreadsheetId: spreadsheet.id, tabTitle: "Sheet1 v2" },
        alice.id
      )
      expect(isFail(badTab) && badTab.error.code).toBe("validation_failed")
      if (isFail(badTab)) expect(Object.keys(badTab.error.fields ?? {})).toContain("tabTitle")

      // Moving to a second spreadsheet validates against THAT snapshot.
      const movedWrongTab = await service.updateApi(
        api.id,
        { spreadsheetId: other.spreadsheet.id, tabTitle: "Sheet1" },
        alice.id
      )
      expect(isFail(movedWrongTab) && movedWrongTab.error.code).toBe("validation_failed")

      const movedRightTab = await service.updateApi(
        api.id,
        { spreadsheetId: other.spreadsheet.id, tabTitle: "People" },
        alice.id
      )
      expect(movedRightTab.ok).toBe(true)
      if (!movedRightTab.ok) return
      expect(movedRightTab.data).toMatchObject({
        spreadsheetId: other.spreadsheet.id,
        tabTitle: "People",
      })
    })

    it("refuses a foreign id, a missing id and a foreign spreadsheet with one identical envelope", async () => {
      const alice = await seedUser("u-a")
      const bob = await seedUser("u-b")
      const bobs = await seedApi(bob.id, "u-b")

      const patch = { name: "hijacked", spreadsheetId: bobs.spreadsheet.id, tabTitle: "Sheet1" }
      const foreign = await service.updateApi(bobs.api.id, patch, alice.id)
      const absent = await service.updateApi(randomUUID(), patch, alice.id)
      expect(foreign).toEqual(absent)
      expect(foreign).toEqual({
        error: { code: "not_found", message: "No API was found with that id.", category: "not_found" },
      })
      expect((await service.getApi(bobs.api.id, bob.id)).ok).toBe(true)

      // Own row, but the patch points at another user's spreadsheet → not_found again, unchanged.
      const aliceApi = await seedApi(alice.id, "u-a")
      const toBobsSheet = await service.updateApi(
        aliceApi.api.id,
        { spreadsheetId: bobs.spreadsheet.id, tabTitle: "Sheet1" },
        alice.id
      )
      expect(isFail(toBobsSheet) && toBobsSheet.error.code).toBe("not_found")
      expect(await service.getApi(aliceApi.api.id, alice.id)).toMatchObject({
        ok: true,
        data: { spreadsheetId: aliceApi.spreadsheet.id },
      })

      // A patch names only what changes: absent keys are left alone.
      const nameOnly = await service.updateApi(aliceApi.api.id, { name: "x" }, alice.id)
      expect(nameOnly).toMatchObject({ ok: true, data: { name: "x", spreadsheetId: aliceApi.spreadsheet.id } })
    })
  })

  describe("toggle, read and delete", () => {
    it("toggles: hidden from the engine resolver, still visible to the owner", async () => {
      const alice = await seedUser("toggle")
      const { api } = await seedApi(alice.id, "toggle")

      expect(await service.toggleApi(api.id, false, alice.id)).toMatchObject({ ok: true })
      expect(await service.getApi(api.id, alice.id)).toMatchObject({ ok: true, data: { enabled: false } })
      expect(await service.resolveEngineApi(api.id)).toBeNull()

      expect(await service.toggleApi(api.id, true, alice.id)).toMatchObject({ ok: true })
      expect(await service.resolveEngineApi(api.id)).toMatchObject({ id: api.id })
      expect(Object.keys((await service.resolveEngineApi(api.id)) ?? {}).sort()).toEqual(ENGINE_API_KEYS)
    })

    it("scopes toggle, read and delete to the owner with the not_found envelope", async () => {
      const alice = await seedUser("s-a")
      const bob = await seedUser("s-b")
      const bobs = await seedApi(bob.id, "s-b")

      const missing = randomUUID()
      const results = await Promise.all([
        service.toggleApi(bobs.api.id, false, alice.id),
        service.getApi(bobs.api.id, alice.id),
        service.deleteApi(bobs.api.id, alice.id),
        service.toggleApi(missing, false, alice.id),
        service.getApi(missing, alice.id),
        service.deleteApi(missing, alice.id),
      ])
      for (const result of results) {
        expect(result).toEqual({
          error: { code: "not_found", message: "No API was found with that id.", category: "not_found" },
        })
      }

      // Still bob's, still enabled, still engine-resolvable.
      expect((await service.getApi(bobs.api.id, bob.id)).ok).toBe(true)
      expect(await service.resolveEngineApi(bobs.api.id)).toMatchObject({ userId: bob.id })

      // A read of bob's id by alice and a list by alice show nothing of bob's.
      expect(await service.listApis(alice.id)).toMatchObject({ ok: true, data: [] })
    })

    it("deletes the config for its owner and takes it out of the engine path", async () => {
      const alice = await seedUser("delete")
      const { api } = await seedApi(alice.id, "delete")
      expect(await service.resolveEngineApi(api.id)).toMatchObject({ id: api.id })

      expect(await service.deleteApi(api.id, alice.id)).toMatchObject({ ok: true })
      expect(await service.resolveEngineApi(api.id)).toBeNull()
      expect(await service.getApi(api.id, alice.id)).toMatchObject({ error: { code: "not_found" } })
      expect(await service.listApis(alice.id)).toMatchObject({ ok: true, data: [] })
      // A hard delete, not a soft flag (`database-schema.md`: hard deletes where cascade is correct).
      expect(await test.select().from(apiConfigurations).where(eq(apiConfigurations.id, api.id))).toHaveLength(0)
      // Second delete is not_found, not an error.
      expect(await service.deleteApi(api.id, alice.id)).toMatchObject({ error: { code: "not_found" } })
    })

    it("keeps a disabled API visible to its owner with the §4.6 payload", async () => {
      const alice = await seedUser("disabled")
      const { api } = await seedApi(alice.id, "disabled")
      await service.toggleApi(api.id, false, alice.id)

      const listed = await service.listApis(alice.id)
      expect(listed.ok).toBe(true)
      if (!listed.ok) return
      expect(listed.data).toHaveLength(1)
      expect(Object.keys(listed.data[0] ?? {}).sort()).toEqual(API_CONFIG_KEYS)
      expect(listed.data[0]?.enabled).toBe(false)
    })
  })

  describe("resolveEngineApi", () => {
    it("exposes only the engine fields, sourced through the parent spreadsheet row", async () => {
      const alice = await seedUser("engine")
      const { connection, spreadsheet, api } = await seedApi(alice.id, "engine", {
        primaryKeyColumn: "id",
        permissions: "read_write",
        allowedOperations: ["GET", "PATCH"],
        description: "not for the engine",
        rateLimitPerHour: 250,
      })

      const resolved = await service.resolveEngineApi(api.id)
      expect(Object.keys(resolved ?? {}).sort()).toEqual(ENGINE_API_KEYS)
      expect(resolved).toMatchObject({
        id: api.id,
        userId: alice.id,
        spreadsheetId: spreadsheet.id,
        googleSheetId: spreadsheet.googleSheetId,
        connectionId: connection.id,
        tabTitle: "Sheet1",
        headerRow: 1,
        primaryKeyColumn: "id",
        permissions: "read_write",
        allowedOperations: ["GET", "PATCH"],
      })
      const json = JSON.stringify(resolved)
      for (const secret of ["not for the engine", "Roster", "createdAt", "enabled", "keyHash"]) {
        expect(json).not.toContain(secret)
      }
    })

    it("excludes a disabled API, an inaccessible parent spreadsheet and a malformed id alike", async () => {
      const alice = await seedUser("excluded")
      const { spreadsheet, api } = await seedApi(alice.id, "excluded")

      await service.toggleApi(api.id, false, alice.id)
      expect(await service.resolveEngineApi(api.id)).toBeNull()
      await service.toggleApi(api.id, true, alice.id)

      await sheets.setSpreadsheetStatus(spreadsheet.id, "inaccessible")
      expect(await service.resolveEngineApi(api.id)).toBeNull()
      // The owner still sees it — the exclusion is the engine's, not the dashboard's.
      expect((await service.getApi(api.id, alice.id)).ok).toBe(true)

      await sheets.setSpreadsheetStatus(spreadsheet.id, "active")
      expect(await service.resolveEngineApi(api.id)).toMatchObject({ id: api.id })

      for (const junk of ["", "not-a-uuid", randomUUID(), `${api.id} `]) {
        expect(await service.resolveEngineApi(junk)).toBeNull()
      }
    })

    it("follows the documented cascade: deleting the parent spreadsheet removes the engine path", async () => {
      const alice = await seedUser("cascade")
      const { spreadsheet, api } = await seedApi(alice.id, "cascade")
      expect(await service.resolveEngineApi(api.id)).toMatchObject({ id: api.id })

      await sheets.deleteSpreadsheet(alice.id, spreadsheet.id)
      expect(await service.resolveEngineApi(api.id)).toBeNull()
      expect(await service.listApis(alice.id)).toMatchObject({ ok: true, data: [] })
    })

    it("lets a temporarily inaccessible sheet still be configured, but never served", async () => {
      const alice = await seedUser("inaccessible")
      const { spreadsheet, api } = await seedApi(alice.id, "inaccessible")
      await sheets.setSpreadsheetStatus(spreadsheet.id, "inaccessible")

      // Configuring against a broken sheet must stay possible (that is how it gets fixed).
      expect(
        await service.updateApi(
          api.id,
          { name: "Patched while broken", spreadsheetId: spreadsheet.id, tabTitle: "Sheet1" },
          alice.id
        )
      ).toMatchObject({ ok: true, data: { name: "Patched while broken" } })
      expect(await service.resolveEngineApi(api.id)).toBeNull()
    })
  })

  it("reports every violated invariant at once, in the §4.4 envelope, with client-safe text", async () => {
    const alice = await seedUser("envelope")
    const { spreadsheet } = await seedSpreadsheet(alice.id, "envelope")

    // read-only + a write verb + no primary key + a tab that does not exist: four rules, one pass.
    const result = await service.createApi(
      {
        ...baseInput,
        spreadsheetId: spreadsheet.id,
        tabTitle: "Nope",
        allowedOperations: ["GET", "PATCH"] as SnippetMethod[],
      },
      alice.id
    )
    expect(isFail(result)).toBe(true)
    if (!isFail(result)) return
    expect(Object.keys(result.error).sort()).toEqual(["category", "code", "fields", "message"])
    expect(result.error.code).toBe("validation_failed")
    expect(result.error.category).toBe("validation")
    expect(Object.keys(result.error.fields ?? {}).sort()).toEqual([
      "allowedOperations",
      "primaryKeyColumn",
      "tabTitle",
    ])
    const json = JSON.stringify(result)
    expect(json).not.toMatch(/select|insert into|api_configurations|\bat\b|undefined\b/i)

    // zod runs first, so a malformed field reports only its own path.
    const zodOnly = await service.createApi(
      { ...baseInput, spreadsheetId: spreadsheet.id, name: "", tabTitle: "Nope" },
      alice.id
    )
    expect(isFail(zodOnly) && Object.keys(zodOnly.error.fields ?? {})).toEqual(["name"])
  })

  it("rejects a value zod coerces to NaN instead of writing it", async () => {
    const alice = await seedUser("coerce")
    const { spreadsheet } = await seedSpreadsheet(alice.id, "coerce")

    const result = await service.createApi(
      { ...baseInput, spreadsheetId: spreadsheet.id, rateLimitPerHour: daysFromNow(1) },
      alice.id
    )
    expect(isFail(result) && result.error.code).toBe("validation_failed")
    if (isFail(result)) expect(Object.keys(result.error.fields ?? {})).toContain("rateLimitPerHour")
    expect(await service.listApis(alice.id)).toMatchObject({ ok: true, data: [] })
  })
})
