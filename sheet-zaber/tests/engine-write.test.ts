import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import type { SnippetMethod } from "@/lib/snippets"

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
import { fakeSheets, type SheetsStub } from "./helpers/fake-sheets"

/*
 * The engine's WRITE plane (`backend-api-contract.md` §1.3 Create/Update/Replace/Delete, §1.5).
 *
 * Proven here: `POST` append row math (single and array, ≤500), `422 header_mismatch` for unknown
 * keys with NOTHING written, missing keys landing as empty cells, `PATCH` merging only the columns
 * it was given, `PUT` clearing every omitted column including the primary key (the documented
 * divergence), `DELETE` removing exactly the resolved row, body-bearing deletes rejected with 400,
 * PK resolution before any write (404/409 with no cell touched), the 1 MB `413`, and the primary-key
 * gate's `403 write_requires_primary_key`.
 */

type EngineModule = typeof import("@/server/engine")
type UsersModule = typeof import("@/server/db/queries/users")
type ConnectionsModule = typeof import("@/server/db/queries/google-connections")
type SpreadsheetsModule = typeof import("@/server/db/queries/spreadsheets")
type ApisService = typeof import("@/server/apis/service")
type KeysService = typeof import("@/server/keys/service")
type EngineCall = Parameters<EngineModule["handleEngineCall"]>[0]

type Envelope = {
  data?: unknown
  meta?: { api_id: string; count: number; limit: number | null; offset: number; duration_ms: number }
  error?: { code: string; message: string; category: string; fields?: Record<string, string> }
}

const TAB = { id: 0, title: "Sheet1", rows: 100, columns: 26 }
const WRITE_METHODS: SnippetMethod[] = ["GET", "POST", "PATCH", "PUT", "DELETE"]

function grid(): string[][] {
  return [
    ["id", "name", "email", "score"],
    ["1", "Ada", "ada@example.com", "10"],
    ["2", "Grace", "grace@example.com", "9"],
    ["3", "Alan", "alan@example.com", "100"],
  ]
}

let test: TestDb
let engine: EngineModule
let users: UsersModule
let connections: ConnectionsModule
let sheets: SpreadsheetsModule
let apis: ApisService
let keys: KeysService

let world: {
  userId: string
  writeApiId: string
  postOnlyApiId: string
  writeKey: string
  stub: SheetsStub
}

async function seedUser(): Promise<string> {
  const stamp = randomUUID()
  const row = await users.createUser({
    googleSub: `engine-write-${stamp}`,
    email: `engine-write-${stamp}@example.com`,
    role: "user",
  })
  // Unlimited per-OWNER day quota (`§1.4`'s `users.api_limit_per_day`, `0` = unlimited), so a write
  // test measures the row math rather than an owner quota window.
  await users.setUserApiLimit(row.id, 0)
  return row.id
}

async function seedSpreadsheet(userId: string): Promise<string> {
  const connection = await connections.upsertConnection({
    userId,
    googleEmail: `engine-write-${randomUUID()}@example.com`,
    refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
    scope: "openid email https://www.googleapis.com/auth/spreadsheets",
  })
  const sheet = await sheets.upsertSpreadsheet({
    userId,
    connectionId: connection.id,
    googleSheetId: `sheet-${randomUUID()}`,
    title: "Roster",
    tabs: [TAB],
  })
  return sheet.id
}

async function seedApi(
  userId: string,
  spreadsheetId: string,
  input: {
    name: string
    permissions: "read" | "read_write"
    allowedOperations: SnippetMethod[]
    primaryKeyColumn?: string | null
  }
): Promise<string> {
  const result = await apis.createApi(
    { spreadsheetId, tabTitle: TAB.title, headerRow: 1, primaryKeyColumn: null, ...input },
    userId
  )
  if (!result.ok) throw new Error(`seed api failed: ${JSON.stringify(result.error)}`)
  return result.data.id
}

async function seedKey(userId: string, scopes: ("read" | "write")[]): Promise<string> {
  const result = await keys.createKey({ name: "engine write key", scopes, allowedApiIds: null }, userId)
  if (!result.ok) throw new Error(`seed key failed: ${JSON.stringify(result.error)}`)
  return result.data.plaintext
}

function makeCall(input: {
  path: string[]
  method?: SnippetMethod
  body?: string | null
  token?: string
}): EngineCall {
  return {
    auth: { kind: "bearer", token: input.token ?? world.writeKey },
    method: input.method ?? "POST",
    pathSegments: input.path,
    searchParams: new URLSearchParams(),
    bodyText: input.body ?? null,
    ip: "203.0.113.9",
  }
}

function depsFor(stub: SheetsStub) {
  return { sheetsFor: async () => stub }
}

async function call(input: Parameters<typeof makeCall>[0]) {
  const outcome = await engine.handleEngineCall(makeCall(input), depsFor(world.stub))
  return { status: outcome.status, body: JSON.parse(outcome.body) as Envelope, raw: outcome.body, headers: outcome.headers }
}

/** The whole tab as the stub holds it — the only proof of the row math a test can trust. */
function cells(): string[][] {
  return world.stub.dump(TAB.title)
}

describe("engine write plane", () => {
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
    engine = await import("@/server/engine")
    users = await import("@/server/db/queries/users")
    connections = await import("@/server/db/queries/google-connections")
    sheets = await import("@/server/db/queries/spreadsheets")
    apis = await import("@/server/apis/service")
    keys = await import("@/server/keys/service")
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    const userId = await seedUser()
    const spreadsheetId = await seedSpreadsheet(userId)
    world = {
      userId,
      writeApiId: await seedApi(userId, spreadsheetId, {
        name: "Roster writable",
        permissions: "read_write",
        allowedOperations: WRITE_METHODS,
        primaryKeyColumn: "id",
      }),
      postOnlyApiId: await seedApi(userId, spreadsheetId, {
        name: "Roster append-only",
        permissions: "read_write",
        allowedOperations: ["POST"],
      }),
      writeKey: await seedKey(userId, ["read", "write"]),
      stub: fakeSheets({ grids: { [TAB.title]: grid() } }),
    }
  })

  afterAll(async () => {
    await stopTestDb()
  })

  describe("create — POST /{api}", () => {
    it("appends one row after the table and answers 201 with the echoed records", async () => {
      const { status, body, raw } = await call({
        method: "POST",
        path: [world.writeApiId],
        body: JSON.stringify({ id: "4", name: "Linus", email: "linus@example.com", score: 7 }),
      })

      expect(status).toBe(201)
      expect(body.data).toEqual({
        created: 1,
        records: [{ id: "4", name: "Linus", email: "linus@example.com", score: 7 }],
      })
      expect(body.meta).toMatchObject({ api_id: world.writeApiId, count: 1, limit: null, offset: 0 })
      // The row landed BELOW the last data row, not against the grid's bottom edge (§1.3).
      expect(cells()).toEqual([...grid(), ["4", "Linus", "linus@example.com", "7"]])
      expect(raw).not.toContain("gridRow")
    })

    it("appends an array in order (§1.3 allows up to 500 records per request)", async () => {
      const { status, body } = await call({
        method: "POST",
        path: [world.writeApiId],
        body: JSON.stringify([
          { id: "4", name: "One" },
          { id: "5", name: "Two" },
        ]),
      })

      expect(status).toBe(201)
      expect(body.data).toMatchObject({ created: 2 })
      expect(cells()).toEqual([...grid(), ["4", "One", "", ""], ["5", "Two", "", ""]])
    })

    it("writes a 500-record array, which is the §1.3 ceiling", async () => {
      const records = Array.from({ length: 500 }, (_, index) => ({ id: `x${index}` }))
      const { status, body } = await call({ method: "POST", path: [world.postOnlyApiId], body: JSON.stringify(records) })
      expect(status).toBe(201)
      expect(body.data).toMatchObject({ created: 500 })
      expect(cells()).toHaveLength(grid().length + 500)
    })

    it("refuses a 501-record array and an empty array with 400 validation_failed", async () => {
      const tooMany = await call({
        method: "POST",
        path: [world.writeApiId],
        body: JSON.stringify(Array.from({ length: 501 }, (_, index) => ({ id: `x${index}` }))),
      })
      expect(tooMany.status).toBe(400)
      expect(tooMany.body.error?.code).toBe("validation_failed")

      const empty = await call({ method: "POST", path: [world.writeApiId], body: "[]" })
      expect(empty.status).toBe(400)
      expect(empty.body.error?.code).toBe("validation_failed")
      expect(cells()).toEqual(grid())
    })

    it("rejects an unknown column with 422 header_mismatch and writes nothing", async () => {
      const { status, body } = await call({
        method: "POST",
        path: [world.writeApiId],
        body: JSON.stringify({ id: "4", name: "Ada", nope: "x", "also nope": "y" }),
      })
      expect(status).toBe(422)
      expect(body.error?.code).toBe("header_mismatch")
      expect(body.error?.category).toBe("validation")
      expect(body.error?.fields).toMatchObject({ fields: "also nope, nope", available: "id, name, email, score" })
      expect(cells()).toEqual(grid())
    })

    it("treats a missing key as an empty cell (§1.3)", async () => {
      const { status } = await call({
        method: "POST",
        path: [world.writeApiId],
        body: JSON.stringify({ id: "9", name: "Only two columns" }),
      })
      expect(status).toBe(201)
      expect(cells()[4]).toEqual(["9", "Only two columns", "", ""])
    })

    it("answers 400 invalid_json for an unparsable body and 413 above 1 MB (§1.2)", async () => {
      const broken = await call({ method: "POST", path: [world.writeApiId], body: "{not json" })
      expect(broken.status).toBe(400)
      expect(broken.body.error?.code).toBe("invalid_json")

      const huge = await call({
        method: "POST",
        path: [world.writeApiId],
        body: `{"id":"${"a".repeat(1_100_000)}"}`,
      })
      expect(huge.status).toBe(413)
      expect(huge.body.error).toMatchObject({ code: "body_too_large", category: "validation" })

      const empty = await call({ method: "POST", path: [world.writeApiId], body: null })
      expect(empty.status).toBe(400)
      expect(empty.body.error?.code).toBe("invalid_json")
    })

    it("rejects a non-object record with 400 validation_failed", async () => {
      const { status, body } = await call({ method: "POST", path: [world.writeApiId], body: "[1,2]" })
      expect(status).toBe(400)
      expect(body.error?.code).toBe("validation_failed")
    })
  })

  describe("update — PATCH /{api}/{record}", () => {
    it("merges only the columns it was given and leaves the rest of the row alone", async () => {
      const { status, body } = await call({
        method: "PATCH",
        path: [world.writeApiId, "2"],
        body: JSON.stringify({ name: "Grace Hopper", score: "11" }),
      })

      expect(status).toBe(200)
      expect(body.data).toMatchObject({ updated: 1 })
      expect(body.data).toHaveProperty("record", {
        id: "2",
        name: "Grace Hopper",
        email: "grace@example.com",
        score: "11",
      })
      expect(cells()).toEqual([
        grid()[0],
        grid()[1],
        ["2", "Grace Hopper", "grace@example.com", "11"],
        grid()[3],
      ])
    })

    it("ignores the primary key in the body — rewriting it would move the record", async () => {
      const { status } = await call({
        method: "PATCH",
        path: [world.writeApiId, "1"],
        body: JSON.stringify({ id: "999", name: "Ada Lovelace" }),
      })
      expect(status).toBe(200)
      expect(cells()[1]).toEqual(["1", "Ada Lovelace", "ada@example.com", "10"])
    })

    it("coalesces adjacent columns and still writes a split set correctly", async () => {
      const { status } = await call({
        method: "PATCH",
        path: [world.writeApiId, "3"],
        body: JSON.stringify({ name: "Alan", email: "alan@example.org", score: "101" }),
      })
      expect(status).toBe(200)
      expect(cells()[3]).toEqual(["3", "Alan", "alan@example.org", "101"])
    })

    it("succeeds without a Google write when the body carries only the primary key", async () => {
      const before = cells()
      const { status, body } = await call({ method: "PATCH", path: [world.writeApiId, "2"], body: JSON.stringify({ id: "2" }) })
      expect(status).toBe(200)
      expect(body.data).toMatchObject({ updated: 1 })
      expect(cells()).toEqual(before)
    })

    it("rejects an unknown column with 422 and writes nothing", async () => {
      const { status, body } = await call({ method: "PATCH", path: [world.writeApiId, "2"], body: JSON.stringify({ nope: "x" }) })
      expect(status).toBe(422)
      expect(body.error?.code).toBe("header_mismatch")
      expect(cells()).toEqual(grid())
    })

    it("resolves the row before writing: 404 for no match, 409 for two, with the sheet untouched", async () => {
      const missing = await call({ method: "PATCH", path: [world.writeApiId, "42"], body: JSON.stringify({ name: "x" }) })
      expect(missing.status).toBe(404)
      expect(missing.body.error?.code).toBe("record_not_found")
      expect(cells()).toEqual(grid())

      world.stub = fakeSheets({
        grids: { [TAB.title]: [["id", "name"], ["7", "Ada"], ["7", "Grace"]] },
      })
      const ambiguous = await call({ method: "PATCH", path: [world.writeApiId, "7"], body: JSON.stringify({ name: "x" }) })
      expect(ambiguous.status).toBe(409)
      expect(ambiguous.body.error?.code).toBe("ambiguous_record")
      expect(world.stub.dump()).toEqual([
        ["id", "name"],
        ["7", "Ada"],
        ["7", "Grace"],
      ])
    })
  })

  describe("replace — PUT /{api}/{record}", () => {
    it("clears every omitted column, including the primary key (§1.3 divergence from PATCH)", async () => {
      const { status, body } = await call({ method: "PUT", path: [world.writeApiId, "1"], body: JSON.stringify({ name: "Ada" }) })

      expect(status).toBe(200)
      expect(body.data).toMatchObject({ updated: 1 })
      expect(cells()[1]).toEqual(["", "Ada", "", ""])
    })

    it("writes a header-width row when every column is given", async () => {
      const { status } = await call({
        method: "PUT",
        path: [world.writeApiId, "2"],
        body: JSON.stringify({ id: "2", name: "Grace H.", email: "grace@navy.mil", score: "12" }),
      })
      expect(status).toBe(200)
      expect(cells()[2]).toEqual(["2", "Grace H.", "grace@navy.mil", "12"])
      expect(cells()[1]).toEqual(grid()[1])
    })

    it("rejects an array body and an unknown column", async () => {
      const array = await call({ method: "PUT", path: [world.writeApiId, "1"], body: '[{"id":"1"}]' })
      expect(array.status).toBe(400)
      expect(array.body.error?.code).toBe("validation_failed")

      const unknown = await call({ method: "PUT", path: [world.writeApiId, "1"], body: JSON.stringify({ nope: "1" }) })
      expect(unknown.status).toBe(422)
      expect(unknown.body.error?.code).toBe("header_mismatch")
    })
  })

  describe("delete — DELETE /{api}/{record}", () => {
    it("removes exactly the resolved row and answers data.deleted = 1", async () => {
      const { status, body } = await call({ method: "DELETE", path: [world.writeApiId, "2"], body: null })

      expect(status).toBe(200)
      expect(body.data).toEqual({ deleted: 1 })
      expect(body.meta).toMatchObject({ count: 1 })
      expect(cells()).toEqual([grid()[0], grid()[1], grid()[3]])
    })

    it("rejects a body-bearing delete with 400 and deletes nothing (§1.3)", async () => {
      const { status, body } = await call({ method: "DELETE", path: [world.writeApiId, "2"], body: JSON.stringify({ name: "x" }) })
      expect(status).toBe(400)
      expect(body.error?.code).toBe("validation_failed")
      expect(cells()).toEqual(grid())
    })

    it("answers 404 for an unknown id and 409 for a duplicated key", async () => {
      const missing = await call({ method: "DELETE", path: [world.writeApiId, "42"] })
      expect(missing.status).toBe(404)

      world.stub = fakeSheets({ grids: { [TAB.title]: [["id", "name"], ["7", "Ada"], ["7", "Grace"]] } })
      const ambiguous = await call({ method: "DELETE", path: [world.writeApiId, "7"] })
      expect(ambiguous.status).toBe(409)
      expect(world.stub.dump()).toHaveLength(3)
    })

    it("refuses to address a record on an API with no primary key column", async () => {
      // `createApi` cannot save such a config (`apis/service.ts`'s D9 invariant), so the column is
      // cleared the way a rename would: straight at the row, to prove the ENGINE's gate.
      const { apiConfigurations } = await import("@/server/db/schema")
      const { eq } = await import("drizzle-orm")
      await test.update(apiConfigurations).set({ primaryKeyColumn: null }).where(eq(apiConfigurations.id, world.writeApiId))

      const { status, body } = await call({ method: "DELETE", path: [world.writeApiId, "1"] })
      expect(status).toBe(403)
      expect(body.error?.code).toBe("write_requires_primary_key")
      expect(body.error?.category).toBe("auth")
      expect(cells()).toEqual(grid())
    })
  })
})
