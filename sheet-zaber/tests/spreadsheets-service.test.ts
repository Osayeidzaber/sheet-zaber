import { randomUUID } from "node:crypto"

import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import type { ActionError, ActionResult } from "@/lib/action-result"
import { registeredSpreadsheets } from "@/server/db/schema"
import type { SheetTab, SheetsClient } from "@/server/google/sheets"
import type { SheetsDeps, Spreadsheet, SpreadsheetTab, TabPreview } from "@/server/spreadsheets/service"

import { fakeSheets, type GoogleErrorStatus, type SheetsStub } from "./helpers/fake-sheets"
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
 * Phase 4.2 — the spreadsheet service, end to end.
 *
 * Real ephemeral PostgreSQL (the same shared instance the smoke contract boots) plus
 * `tests/helpers/fake-sheets.ts` injected as the `SheetsClient` factory: every row this service
 * writes is a real row, and every Google answer is the stub's. The service never sees `googleapis`,
 * so nothing here needs network, a token, or a real spreadsheet.
 *
 * `getAccessToken` is a scripted queue, which is what lets the refresh contract be asserted
 * rather than described: one forced refresh after a 401, never a third attempt.
 */

const SHEET_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
const SHEET_SCOPE = "openid email https://www.googleapis.com/auth/spreadsheets"
/** Opaque placeholder ciphertext: this layer never decrypts it, and neither does the service. */
const REFRESH_ENC = "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu"

/* ---------------------------------------------------------------- workbook fixture */

/** Gids are strings here (Google's `sheetId` arrives as a number and the client keeps the text). */
const ROSTER_TABS: SheetTab[] = [
  { id: "0", title: "Data", rows: 100, columns: 26 },
  { id: "1", title: "My Tab", rows: 50, columns: 8 },
  { id: "2", title: "Wide", rows: 200, columns: 26 },
  { id: "3", title: "Titled", rows: 100, columns: 26 },
]

/** §4.6's `SpreadsheetTab.id` is numeric, so the stored snapshot is the fixture with `Number` gids. */
const ROSTER_SNAPSHOT: SpreadsheetTab[] = ROSTER_TABS.map((tab) => ({
  id: Number(tab.id),
  title: tab.title,
  rows: tab.rows,
  columns: tab.columns,
}))

/** 1 header + 12 body rows: the 10-row preview cap and `truncated` need a row 11 to exist. */
function wideGrid(): string[][] {
  return [
    ["id", "", "email"],
    ...Array.from({ length: 12 }, (_, index) => {
      const n = String(index + 1)
      return [n, `user${n}`, `user${n}@example.com`]
    }),
  ]
}

const ROSTER_GRIDS: Record<string, string[][]> = {
  Data: [
    ["id", "name", "email"],
    ["1", "Ada", "ada@example.com"],
    ["2", "Grace", "grace@example.com"],
  ],
  "My Tab": [
    ["a b", "c"],
    ["1", "2"],
  ],
  Wide: wideGrid(),
  Titled: [
    ["Team roster"],
    ["id", "name", "email"],
    ["1", "Ada", "ada@example.com"],
    ["2", "Grace", "grace@example.com"],
  ],
}

/* ---------------------------------------------------------------- envelope helpers */

function dataOf<T>(result: ActionResult<T>): T {
  if ("error" in result) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`)
  return result.data
}

function errorOf<T>(result: ActionResult<T>): ActionError["error"] {
  if (!("error" in result)) throw new Error(`expected an error envelope, got ok ${JSON.stringify(result)}`)
  return result.error
}

/* ---------------------------------------------------------------- dependency harness */

type TokenAnswer = string | undefined

/** One Google verb the service issued, with the arguments it built (the A1 refs are the evidence). */
type ClientCall = { method: string; args: (string | number | string[][])[] }

type DepsHarness = {
  deps: SheetsDeps
  /** Scripted `getAccessToken` answers, in call order (the last one repeats once exhausted). */
  tokens: TokenAnswer[]
  /** Every `getAccessToken` call, so the one-refresh rule is assertable. */
  tokenCalls: { connectionId: string; forceRefresh: boolean | undefined }[]
  /** The token each Google call was made with. */
  clientTokens: string[]
  calls: ClientCall[]
  stub: SheetsStub
}

function makeDeps(input: { tokens?: TokenAnswer[]; fails?: GoogleErrorStatus[]; title?: string } = {}): DepsHarness {
  const stub = fakeSheets({ title: input.title ?? "Roster", tabs: ROSTER_TABS, grids: ROSTER_GRIDS })
  const tokens = input.tokens ?? ["ya29.first"]
  const fails = [...(input.fails ?? [])]
  const tokenCalls: DepsHarness["tokenCalls"] = []
  const clientTokens: string[] = []
  const calls: ClientCall[] = []
  let attempt = 0

  const deps: SheetsDeps = {
    async getAccessToken(connectionId, forceRefresh) {
      tokenCalls.push({ connectionId, forceRefresh })
      const answer = tokens[Math.min(attempt, tokens.length - 1)]
      attempt += 1
      // `undefined` models a dead grant: refreshing throws instead of producing a token.
      if (answer === undefined) throw new Error("refresh token revoked")
      return answer
    },
    client(accessToken) {
      clientTokens.push(accessToken)
      // Arm the stub for the call this client is created for, so `fails[n]` means "the n-th
      // Google call fails". One client per attempt, so the mapping is exact.
      const fail = fails.shift()
      if (fail !== undefined) stub.failNextWith(fail)
      return recording(stub, calls)
    },
  }

  return { deps, tokens, tokenCalls, clientTokens, calls, stub }
}

/** Wraps the stub so a test can read the exact refs the service built (e.g. `'My Tab'!1:1`). */
function recording(stub: SheetsStub, calls: ClientCall[]): SheetsClient {
  const record = (method: string, args: (string | number | string[][])[]) => {
    calls.push({ method, args })
  }
  return {
    async getSpreadsheetMeta(spreadsheetId) {
      record("getSpreadsheetMeta", [spreadsheetId])
      return stub.getSpreadsheetMeta(spreadsheetId)
    },
    async getValues(ref) {
      record("getValues", [ref])
      return stub.getValues(ref)
    },
    async appendValues(ref, rows) {
      record("appendValues", [ref, rows])
      return stub.appendValues(ref, rows)
    },
    async updateValues(ref, values) {
      record("updateValues", [ref, values])
      return stub.updateValues(ref, values)
    },
    async deleteRow(sheetId, tabTitle, rowIndex) {
      record("deleteRow", [sheetId, tabTitle, rowIndex])
      return stub.deleteRow(sheetId, tabTitle, rowIndex)
    },
  }
}

/* ---------------------------------------------------------------- suite */

describe("spreadsheet service", () => {
  let test: TestDb
  let repo: {
    users: typeof import("@/server/db/queries/users")
    connections: typeof import("@/server/db/queries/google-connections")
    spreadsheets: typeof import("@/server/db/queries/spreadsheets")
  }
  let service: typeof import("@/server/spreadsheets/service")

  beforeAll(async () => {
    let url: string
    try {
      url = inject(TEST_DB_URL_KEY)
    } catch {
      await startTestDb()
      await migrateTestDb()
      url = getTestDbUrl()
    }
    // The service reaches production's `db` through the query modules, and `src/lib/env.ts`
    // freezes `DATABASE_URL` at import time — so it is imported only after the instance URL
    // is published (same ordering `repo-google-sheets.test.ts` relies on).
    process.env.DATABASE_URL = url
    test = await getTestDb()
    repo = {
      users: await import("@/server/db/queries/users"),
      connections: await import("@/server/db/queries/google-connections"),
      spreadsheets: await import("@/server/db/queries/spreadsheets"),
    }
    service = await import("@/server/spreadsheets/service")
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  async function seedUser(): Promise<string> {
    const stamp = randomUUID()
    const user = await repo.users.createUser({
      googleSub: `svc-${stamp}`,
      email: `svc-${stamp}@example.com`,
      role: "user",
    })
    return user.id
  }

  async function seedConnection(userId: string, status?: "reauth_required"): Promise<string> {
    const connection = await repo.connections.upsertConnection({
      userId,
      googleEmail: `sheets-${randomUUID()}@example.com`,
      refreshTokenEnc: REFRESH_ENC,
      scope: SHEET_SCOPE,
    })
    if (status !== undefined) await repo.connections.markConnectionStatus(connection.id, status)
    return connection.id
  }

  /** A row as `registerSpreadsheet` would have written it, so preview/refresh/remove have a target. */
  async function seedSpreadsheet(
    userId: string,
    connectionId: string,
    input: { googleSheetId?: string; title?: string; tabs?: SpreadsheetTab[] } = {}
  ): Promise<string> {
    const row = await repo.spreadsheets.upsertSpreadsheet({
      userId,
      connectionId,
      googleSheetId: input.googleSheetId ?? SHEET_ID,
      title: input.title ?? "Roster",
      tabs: input.tabs ?? [{ id: 0, title: "Data", rows: 100, columns: 26 }],
    })
    return row.id
  }

  /** Whole-table count through the test client: proves no second row exists for ANY user. */
  async function spreadsheetRowCount(): Promise<number> {
    const [row] = await test
      .select({ total: sql<number>`count(*)::int` })
      .from(registeredSpreadsheets)
    return row?.total ?? 0
  }

  /* -------------------------------------------------------- URL normalization (§3 step 2) */

  describe("parseSpreadsheetId", () => {
    const accepts: [string, string][] = [
      [`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, SHEET_ID],
      [`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=1889800310`, SHEET_ID],
      [`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=drivesdk`, SHEET_ID],
      [`https://docs.google.com/spreadsheets/d/${SHEET_ID}`, SHEET_ID],
      [`  https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview  `, SHEET_ID],
      [`https://docs.google.com/spreadsheets/u/2/d/${SHEET_ID}/edit`, SHEET_ID],
      [`http://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, SHEET_ID],
      [`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`, SHEET_ID],
      [`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`, SHEET_ID],
      [SHEET_ID, SHEET_ID],
      ["Abc_-9876543210", "Abc_-9876543210"],
    ]

    it.each(accepts)("accepts %j", (input, expected) => {
      expect(service.parseSpreadsheetId(input)).toBe(expected)
    })

    const rejects: string[] = [
      "",
      "   ",
      "not a url",
      "shortid",
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}!`,
      // An attacker's host — including one that only *looks* like Google's.
      `https://evil.example/spreadsheets/d/${SHEET_ID}/edit`,
      `https://docs.google.com.evil.example/spreadsheets/d/${SHEET_ID}/edit`,
      `https://docs.google.com@evil.example/spreadsheets/d/${SHEET_ID}/edit`,
      "javascript:alert(1)",
      "mailto:someone@example.com",
      // Credentials in the URL are never acceptable, whatever the host.
      `https://user:pw@docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
      // A `/d/` segment is not a Google Sheets link.
      `https://docs.google.com/document/d/${SHEET_ID}/edit`,
      `https://docs.google.com/forms/d/${SHEET_ID}/edit`,
      `https://drive.google.com/file/d/${SHEET_ID}/view`,
      `https://docs.google.com/spreadsheets/${SHEET_ID}`,
      `https://docs.google.com/spreadsheets/o/${SHEET_ID}`,
      `https://docs.google.com/spreadsheets/d/`,
      `https://docs.google.com/spreadsheets/d/../${SHEET_ID}`,
    ]

    it.each(rejects)("rejects %j", (input) => {
      expect(service.parseSpreadsheetId(input)).toBeUndefined()
    })
  })

  /* -------------------------------------------------------- registerSpreadsheet */

  describe("registerSpreadsheet", () => {
    it("registers through spreadsheets.get, writes the tab snapshot and returns the §4.6 payload", async () => {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)
      const harness = makeDeps({ tokens: ["ya29.register"] })

      const result = await service.registerSpreadsheet(
        { url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=1` },
        userId,
        harness.deps
      )

      const spreadsheet = dataOf(result)
      expect(spreadsheet.googleSheetId).toBe(SHEET_ID)
      expect(spreadsheet.title).toBe("Roster")
      expect(spreadsheet.tabs).toEqual(ROSTER_SNAPSHOT)
      expect(spreadsheet.status).toBe("active")
      expect(spreadsheet.connectionId).toBe(connectionId)
      expect(spreadsheet.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(spreadsheet.createdAt).toBeInstanceOf(Date)
      expect(spreadsheet.updatedAt).toBeInstanceOf(Date)

      // The permission check is `spreadsheets.get` on the parsed id, with the connection's token.
      expect(harness.calls).toEqual([{ method: "getSpreadsheetMeta", args: [SHEET_ID] }])
      expect(harness.clientTokens).toEqual(["ya29.register"])
      expect(harness.tokenCalls).toEqual([{ connectionId, forceRefresh: undefined }])

      const rows = await repo.spreadsheets.listSpreadsheets(userId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.tabs).toEqual(ROSTER_SNAPSHOT)
      expect(rows[0]?.googleSheetId).toBe(SHEET_ID)
      // Usage is bumped once per Google call, never at registration only.
      const connection = await repo.connections.findConnectionForUser(userId, connectionId)
      expect(connection?.lastUsedAt).toBeInstanceOf(Date)
    })

    it("is idempotent: re-registering the same sheet updates the one row in place", async () => {
      const userId = await seedUser()
      await seedConnection(userId)

      const first = dataOf(await service.registerSpreadsheet({ url: SHEET_ID }, userId, makeDeps().deps))
      const second = dataOf(
        await service.registerSpreadsheet(
          { url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` },
          userId,
          makeDeps({ title: "Roster (renamed)" }).deps
        )
      )

      expect(second.id).toBe(first.id)
      expect(second.title).toBe("Roster (renamed)")
      expect(second.tabs).toEqual(ROSTER_SNAPSHOT)
      const rows = await repo.spreadsheets.listSpreadsheets(userId)
      expect(rows).toHaveLength(1)
      expect(await spreadsheetRowCount()).toBe(1)
    })

    it("re-points the row at the connection that just proved access", async () => {
      const userId = await seedUser()
      const firstConnection = await seedConnection(userId)
      const secondConnection = await seedConnection(userId)

      await service.registerSpreadsheet({ url: SHEET_ID, connectionId: firstConnection }, userId, makeDeps().deps)
      const row = dataOf(
        await service.registerSpreadsheet(
          { url: SHEET_ID, connectionId: secondConnection },
          userId,
          makeDeps().deps
        )
      )

      expect(row.connectionId).toBe(secondConnection)
    })

    it("rejects a non-Google host without touching Google or the database", async () => {
      const userId = await seedUser()
      await seedConnection(userId)
      const harness = makeDeps()

      const error = errorOf(
        await service.registerSpreadsheet({ url: `https://evil.example/spreadsheets/d/${SHEET_ID}/edit` }, userId, harness.deps)
      )

      expect(error).toEqual({
        code: "validation_failed",
        message: "Check the spreadsheet link and try again.",
        category: "validation",
        fields: { url: expect.stringContaining("docs.google.com/spreadsheets/d/") },
      })
      expect(harness.tokenCalls).toEqual([])
      expect(harness.calls).toEqual([])
      expect(await repo.spreadsheets.listSpreadsheets(userId)).toEqual([])
    })

    it("rejects a forged `/d/` path and an empty link with field-level validation", async () => {
      const userId = await seedUser()
      await seedConnection(userId)

      const forged = errorOf(
        await service.registerSpreadsheet({ url: `https://docs.google.com/document/d/${SHEET_ID}/edit` }, userId, makeDeps().deps)
      )
      expect(forged.code).toBe("validation_failed")
      expect(forged.category).toBe("validation")

      const empty = errorOf(await service.registerSpreadsheet({ url: "   " }, userId, makeDeps().deps))
      expect(empty.code).toBe("validation_failed")
      expect(empty.fields?.url).toEqual(expect.any(String))
    })

    it("refuses a malformed connection id as invalid input, not as a missing row", async () => {
      const userId = await seedUser()
      const error = errorOf(
        await service.registerSpreadsheet({ url: SHEET_ID, connectionId: "not-a-uuid" }, userId, makeDeps().deps)
      )
      expect(error.fields?.connectionId).toEqual(expect.any(String))
    })

    it("reads as not_found when the connection id belongs to someone else", async () => {
      const userId = await seedUser()
      const otherUserId = await seedUser()
      const otherConnection = await seedConnection(otherUserId)

      const error = errorOf(
        await service.registerSpreadsheet({ url: SHEET_ID, connectionId: otherConnection }, userId, makeDeps().deps)
      )
      expect(error).toEqual({
        code: "not_found",
        message: "No spreadsheet was found for that id.",
        category: "not_found",
      })
    })

    it("tells 'never connected' apart from 'grant is dead'", async () => {
      const neverConnected = await seedUser()
      expect(
        errorOf(await service.registerSpreadsheet({ url: SHEET_ID }, neverConnected, makeDeps().deps)).code
      ).toBe("google_not_connected")

      const dead = await seedUser()
      await seedConnection(dead, "reauth_required")
      const error = errorOf(await service.registerSpreadsheet({ url: SHEET_ID }, dead, makeDeps().deps))
      expect(error).toEqual({
        code: "google_reauth_required",
        message: expect.stringContaining("reconnect"),
        category: "google",
      })
    })

    it("refreshes exactly once after a 401 and registers on the retry", async () => {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)
      const harness = makeDeps({ tokens: ["ya29.expired", "ya29.fresh"], fails: ["401"] })

      const spreadsheet = dataOf(await service.registerSpreadsheet({ url: SHEET_ID }, userId, harness.deps))

      expect(spreadsheet.status).toBe("active")
      expect(harness.tokenCalls).toEqual([
        { connectionId, forceRefresh: undefined },
        { connectionId, forceRefresh: true },
      ])
      expect(harness.clientTokens).toEqual(["ya29.expired", "ya29.fresh"])
      expect(harness.calls).toEqual([
        { method: "getSpreadsheetMeta", args: [SHEET_ID] },
        { method: "getSpreadsheetMeta", args: [SHEET_ID] },
      ])
      const connection = await repo.connections.findConnectionForUser(userId, connectionId)
      expect(connection?.status).toBe("connected")
    })

    it("stops after one refresh: a second 401 flips the connection and writes no row", async () => {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)
      const harness = makeDeps({ tokens: ["ya29.one", "ya29.two"], fails: ["401", "401"] })

      const result = await service.registerSpreadsheet({ url: SHEET_ID }, userId, harness.deps)

      expect(errorOf(result).code).toBe("google_reauth_required")
      expect(harness.tokenCalls).toHaveLength(2)
      expect(harness.clientTokens).toHaveLength(2)
      const connection = await repo.connections.findConnectionForUser(userId, connectionId)
      expect(connection?.status).toBe("reauth_required")
      expect(await repo.spreadsheets.listSpreadsheets(userId)).toEqual([])
      expect(JSON.stringify(result)).not.toContain("ya29")
    })

    it("treats a token it cannot mint as re-auth, before calling Google at all", async () => {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)
      const harness = makeDeps({ tokens: [undefined] })

      expect(errorOf(await service.registerSpreadsheet({ url: SHEET_ID }, userId, harness.deps)).code).toBe(
        "google_reauth_required"
      )
      expect(harness.calls).toEqual([])
      expect(harness.clientTokens).toEqual([])
      const connection = await repo.connections.findConnectionForUser(userId, connectionId)
      expect(connection?.status).toBe("reauth_required")
    })

    it("maps 403 and 429 to their own codes and writes no row", async () => {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)

      const denied = errorOf(
        await service.registerSpreadsheet({ url: SHEET_ID }, userId, makeDeps({ fails: ["403"] }).deps)
      )
      expect(denied).toEqual({
        code: "google_sheet_inaccessible",
        message: expect.stringContaining("could not open that spreadsheet"),
        category: "google",
      })

      const throttled = errorOf(
        await service.registerSpreadsheet({ url: SHEET_ID }, userId, makeDeps({ fails: ["429"] }).deps)
      )
      expect(throttled).toEqual({
        code: "rate_limited",
        message: expect.stringContaining("rate-limiting"),
        category: "rate_limit",
      })

      expect(await repo.spreadsheets.listSpreadsheets(userId)).toEqual([])
      // Neither failure is the user's Google account dying, so the connection stays usable.
      const connection = await repo.connections.findConnectionForUser(userId, connectionId)
      expect(connection?.status).toBe("connected")
    })

    it("reports internal_error rather than storing a snapshot without numeric gids", async () => {
      const userId = await seedUser()
      await seedConnection(userId)
      const stub = fakeSheets({ tabs: [{ id: "not-a-gid", title: "Data", rows: 10, columns: 3 }] })
      const deps: SheetsDeps = {
        async getAccessToken() {
          return "ya29.any"
        },
        client: () => stub,
      }

      const failure = errorOf(await service.registerSpreadsheet({ url: SHEET_ID }, userId, deps))
      expect(failure.code).toBe("internal_error")
      expect(failure.category).toBe("internal")
      expect(await repo.spreadsheets.listSpreadsheets(userId)).toEqual([])
    })
  })

  /* -------------------------------------------------------- refreshSpreadsheetTabs */

  describe("refreshSpreadsheetTabs", () => {
    it("replaces the snapshot and carries a renamed title", async () => {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)
      const id = await seedSpreadsheet(userId, connectionId, {
        title: "Roster",
        tabs: [{ id: 0, title: "Data", rows: 100, columns: 26 }],
      })
      const harness = makeDeps({ tokens: ["ya29.refresh"], title: "Roster (shared)" })

      const result = await service.refreshSpreadsheetTabs(id, userId, harness.deps)

      expect(dataOf(result)).toEqual({ tabs: ROSTER_SNAPSHOT })
      expect(harness.calls).toEqual([{ method: "getSpreadsheetMeta", args: [SHEET_ID] }])
      const row = await repo.spreadsheets.findSpreadsheet(userId, id)
      expect(row?.title).toBe("Roster (shared)")
      expect(row?.tabs).toEqual(ROSTER_SNAPSHOT)
      expect(row?.status).toBe("active")
    })

    it("marks the row inaccessible when Google answers 403", async () => {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)
      const id = await seedSpreadsheet(userId, connectionId)
      const harness = makeDeps({ fails: ["403"] })

      const error = errorOf(await service.refreshSpreadsheetTabs(id, userId, harness.deps))

      expect(error.code).toBe("google_sheet_inaccessible")
      expect((await repo.spreadsheets.findSpreadsheet(userId, id))?.status).toBe("inaccessible")
      // The row survives — the owner needs to see it to fix it — and the grant is not blamed.
      expect((await repo.spreadsheets.findSpreadsheet(userId, id))?.tabs).toEqual([
        { id: 0, title: "Data", rows: 100, columns: 26 },
      ])
      expect((await repo.connections.findConnectionForUser(userId, connectionId))?.status).toBe("connected")
      expect(harness.clientTokens).toHaveLength(1)
    })

    it("keeps the row active through a 401 the refresh cannot clear", async () => {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)
      const id = await seedSpreadsheet(userId, connectionId)
      const harness = makeDeps({ tokens: ["ya29.one", "ya29.two"], fails: ["401", "401"] })

      expect(errorOf(await service.refreshSpreadsheetTabs(id, userId, harness.deps)).code).toBe(
        "google_reauth_required"
      )
      expect((await repo.spreadsheets.findSpreadsheet(userId, id))?.status).toBe("active")
      expect((await repo.connections.findConnectionForUser(userId, connectionId))?.status).toBe("reauth_required")
      expect(harness.tokenCalls).toHaveLength(2)
    })

    it("returns not_found for a foreign or missing id without calling Google", async () => {
      const userId = await seedUser()
      const otherUserId = await seedUser()
      const otherConnection = await seedConnection(otherUserId)
      const otherId = await seedSpreadsheet(otherUserId, otherConnection)
      const harness = makeDeps()

      for (const id of [otherId, randomUUID()]) {
        expect(errorOf(await service.refreshSpreadsheetTabs(id, userId, harness.deps)).code).toBe("not_found")
      }
      expect(harness.tokenCalls).toEqual([])
      expect(harness.calls).toEqual([])
      expect((await repo.spreadsheets.findSpreadsheet(otherUserId, otherId))?.status).toBe("active")
    })
  })

  /* -------------------------------------------------------- previewTab */

  describe("previewTab", () => {
    async function seeded(): Promise<{ userId: string; spreadsheetId: string }> {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)
      const spreadsheetId = await seedSpreadsheet(userId, connectionId, { tabs: ROSTER_SNAPSHOT })
      return { userId, spreadsheetId }
    }

    it("reads header row 1 and the 10 rows under it", async () => {
      const { userId, spreadsheetId } = await seeded()
      const harness = makeDeps()

      const preview = dataOf(
        await service.previewTab({ spreadsheetId, tabTitle: "Data", headerRow: 1 }, userId, harness.deps)
      )

      expect(preview).toEqual({
        headers: ["id", "name", "email"],
        records: [
          { id: "1", name: "Ada", email: "ada@example.com" },
          { id: "2", name: "Grace", email: "grace@example.com" },
        ],
        truncated: false,
      })
      expect(harness.calls).toEqual([
        { method: "getValues", args: ["Data!1:1"] },
        { method: "getValues", args: ["Data!2:12"] },
      ])
      expect(harness.tokenCalls).toHaveLength(2)
    })

    it("honours a header row below a title row", async () => {
      const { userId, spreadsheetId } = await seeded()

      const preview = dataOf(
        await service.previewTab({ spreadsheetId, tabTitle: "Titled", headerRow: 2 }, userId, makeDeps().deps)
      )

      expect(preview).toEqual({
        headers: ["id", "name", "email"],
        records: [
          { id: "1", name: "Ada", email: "ada@example.com" },
          { id: "2", name: "Grace", email: "grace@example.com" },
        ],
        truncated: false,
      })
    })

    it("keys an empty header cell as column_N", async () => {
      const { userId, spreadsheetId } = await seeded()

      const preview = dataOf(
        await service.previewTab({ spreadsheetId, tabTitle: "Wide", headerRow: 1 }, userId, makeDeps().deps)
      )

      expect(preview.headers).toEqual(["id", "column_2", "email"])
      expect(preview.records[0]).toEqual({ id: "1", column_2: "user1", email: "user1@example.com" })
    })

    it("caps the preview at 10 records and flags truncation without returning row 11", async () => {
      const { userId, spreadsheetId } = await seeded()
      const harness = makeDeps()

      const preview = dataOf(
        await service.previewTab({ spreadsheetId, tabTitle: "Wide", headerRow: 1 }, userId, harness.deps)
      )

      expect(preview.records).toHaveLength(10)
      expect(preview.records.at(-1)).toEqual({ id: "10", column_2: "user10", email: "user10@example.com" })
      expect(preview.truncated).toBe(true)
      expect(JSON.stringify(preview)).not.toContain("user11")
      // The probe row is read to answer `truncated`, never returned.
      expect(harness.calls[1]).toEqual({ method: "getValues", args: ["Wide!2:12"] })
    })

    it("quotes a tab title the way A1 requires and never writes", async () => {
      const { userId, spreadsheetId } = await seeded()
      const harness = makeDeps()

      const preview = dataOf(
        await service.previewTab({ spreadsheetId, tabTitle: "My Tab", headerRow: 1 }, userId, harness.deps)
      )

      expect(preview).toEqual({
        headers: ["a b", "c"],
        records: [{ "a b": "1", c: "2" }],
        truncated: false,
      })
      expect(harness.calls).toEqual([
        { method: "getValues", args: ["'My Tab'!1:1"] },
        { method: "getValues", args: ["'My Tab'!2:12"] },
      ])
      expect(harness.calls.every((call) => call.method === "getValues" || call.method === "getSpreadsheetMeta")).toBe(
        true
      )
      expect(harness.stub.dump("Data")).toEqual(ROSTER_GRIDS.Data)
    })

    it("checks the snapshot before asking Google about a tab that is not there", async () => {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)
      const spreadsheetId = await seedSpreadsheet(userId, connectionId)
      const harness = makeDeps()

      const error = errorOf(
        await service.previewTab({ spreadsheetId, tabTitle: "Wide", headerRow: 1 }, userId, harness.deps)
      )

      expect(error).toEqual({
        code: "tab_not_found",
        message: expect.stringContaining("Refresh the tabs"),
        category: "validation",
        fields: { tabTitle: expect.stringContaining("Wide") },
      })
      expect(harness.tokenCalls).toEqual([])
      expect(harness.calls).toEqual([])
    })

    it("validates headerRow and refuses a foreign spreadsheet id", async () => {
      const { userId, spreadsheetId } = await seeded()

      const badRow = errorOf(
        await service.previewTab({ spreadsheetId, tabTitle: "Data", headerRow: 0 }, userId, makeDeps().deps)
      )
      expect(badRow.code).toBe("validation_failed")
      expect(badRow.fields?.headerRow).toEqual(expect.any(String))

      const notYours = errorOf(
        await service.previewTab({ spreadsheetId: randomUUID(), tabTitle: "Data", headerRow: 1 }, userId, makeDeps().deps)
      )
      expect(notYours.code).toBe("not_found")
    })

    it("propagates a Google failure from the header read and stops there", async () => {
      const { userId, spreadsheetId } = await seeded()
      const harness = makeDeps({ fails: ["404"] })

      const error = errorOf(
        await service.previewTab({ spreadsheetId, tabTitle: "Data", headerRow: 1 }, userId, harness.deps)
      )

      expect(error.code).toBe("google_sheet_inaccessible")
      expect(harness.calls).toEqual([{ method: "getValues", args: ["Data!1:1"] }])
    })
  })

  /* -------------------------------------------------------- removeSpreadsheet */

  describe("removeSpreadsheet", () => {
    it("deletes the owner's row and returns its id", async () => {
      const userId = await seedUser()
      const connectionId = await seedConnection(userId)
      const id = await seedSpreadsheet(userId, connectionId)

      expect(dataOf(await service.removeSpreadsheet(id, userId))).toEqual({ id })
      expect(await repo.spreadsheets.findSpreadsheet(userId, id)).toBeUndefined()
      expect(await repo.spreadsheets.listSpreadsheets(userId)).toEqual([])
    })

    it("deletes only the caller's row: a foreign id removes nothing", async () => {
      const userId = await seedUser()
      const otherUserId = await seedUser()
      const otherConnection = await seedConnection(otherUserId)
      const otherId = await seedSpreadsheet(otherUserId, otherConnection, { googleSheetId: `other-${SHEET_ID}` })
      const mine = await seedSpreadsheet(userId, await seedConnection(userId))

      const error = errorOf(await service.removeSpreadsheet(otherId, userId))
      expect(error).toEqual({
        code: "not_found",
        message: "No spreadsheet was found for that id.",
        category: "not_found",
      })
      expect(await repo.spreadsheets.findSpreadsheet(otherUserId, otherId)).toBeDefined()
      expect(await repo.spreadsheets.findSpreadsheet(userId, mine)).toBeDefined()

      expect(dataOf(await service.removeSpreadsheet(mine, userId))).toEqual({ id: mine })
      expect(await repo.spreadsheets.findSpreadsheet(userId, mine)).toBeUndefined()
      expect(await repo.spreadsheets.findSpreadsheet(otherUserId, otherId)).toBeDefined()
    })

    it("needs no Google call — deregistration is a local row delete", async () => {
      const userId = await seedUser()
      const id = await seedSpreadsheet(userId, await seedConnection(userId))
      const harness = makeDeps()

      dataOf(await service.removeSpreadsheet(id, userId))
      expect(harness.tokenCalls).toEqual([])
      expect(harness.calls).toEqual([])
    })
  })

  /* -------------------------------------------------------- leakage guard */

  it("never returns cell data beyond the preview cap and never returns a token", async () => {
    const userId = await seedUser()
    const connectionId = await seedConnection(userId)
    const harness = makeDeps({ tokens: ["ya29.secret-registrable-token"] })

    const registered: Spreadsheet = dataOf(await service.registerSpreadsheet({ url: SHEET_ID }, userId, harness.deps))
    expect(JSON.stringify(registered)).not.toContain("ya29")
    expect(JSON.stringify(registered)).not.toContain("ada@example.com")

    const preview: TabPreview = dataOf(
      await service.previewTab(
        { spreadsheetId: registered.id, tabTitle: "Wide", headerRow: 1 },
        userId,
        makeDeps({ tokens: ["ya29.preview-token"] }).deps
      )
    )
    expect(JSON.stringify(preview)).not.toContain("ya29")
    expect(preview.records.length).toBeLessThanOrEqual(10)

    const connection = await repo.connections.findConnectionForUser(userId, connectionId)
    expect(JSON.stringify(connection)).not.toContain("ya29")
  })
})
