import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import type { SnippetMethod } from "@/lib/snippets"

import { TEST_DB_URL_KEY, getTestDb, getTestDbUrl, migrateTestDb, startTestDb, stopTestDb, truncateAll } from "./helpers/db"
import { fakeSheets, type SheetsStub } from "./helpers/fake-sheets"

/* A hidden column must not leak through any route, and writes must never damage it. */

const TAB = { id: 0, title: "Sheet1", rows: 100, columns: 26 }
const GRID = [
  ["id", "name", "salary"],
  ["1", "Ada", "SECRET-900"],
  ["2", "Grace", "SECRET-800"],
]

let engine: typeof import("@/server/engine")
let apis: typeof import("@/server/apis/service")
let stub: SheetsStub
let apiId: string
let token: string
let userId: string
let spreadsheetId: string

async function run(method: SnippetMethod, path: string[], query: Record<string, string> = {}, body: unknown = null) {
  const outcome = await engine.handleEngineCall(
    {
      auth: { kind: "bearer", token },
      method,
      pathSegments: [apiId, ...path],
      searchParams: new URLSearchParams(query),
      bodyText: body === null ? null : JSON.stringify(body),
      ip: "203.0.113.7",
    },
    { sheetsFor: async () => stub } as never
  )
  return { status: outcome.status, raw: outcome.body, json: JSON.parse(outcome.body) }
}

describe("exposed columns", () => {
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
    engine = await import("@/server/engine")
    apis = await import("@/server/apis/service")
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    const users = await import("@/server/db/queries/users")
    const connections = await import("@/server/db/queries/google-connections")
    const sheets = await import("@/server/db/queries/spreadsheets")
    const keys = await import("@/server/keys/service")
    const stamp = randomUUID()
    const user = await users.createUser({ googleSub: `cols-${stamp}`, email: `cols-${stamp}@example.com`, role: "user" })
    userId = user.id
    await users.setUserApiLimit(userId, 0)
    const connection = await connections.upsertConnection({
      userId,
      googleEmail: `cols-${stamp}@example.com`,
      refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
      scope: "openid",
    })
    const sheet = await sheets.upsertSpreadsheet({ userId, connectionId: connection.id, googleSheetId: `s-${stamp}`, title: "Pay", tabs: [TAB] })
    spreadsheetId = sheet.id
    const api = await apis.createApi(
      {
        spreadsheetId,
        name: "Public roster",
        tabTitle: TAB.title,
        headerRow: 1,
        primaryKeyColumn: "id",
        exposedColumns: ["id", "name"],
        permissions: "read_write",
        allowedOperations: ["GET", "POST", "PATCH", "PUT"],
      },
      userId
    )
    if (!api.ok) throw new Error(JSON.stringify(api.error))
    apiId = api.data.id
    const key = await keys.createKey({ name: "k", scopes: ["read", "write"], allowedApiIds: null }, userId)
    if (!key.ok) throw new Error(JSON.stringify(key.error))
    token = key.data.plaintext
    stub = fakeSheets({ grids: { [TAB.title]: GRID } })
  })

  afterAll(async () => {
    await stopTestDb()
  })

  it("omits hidden columns from list and single-record reads", async () => {
    const list = await run("GET", [])
    expect(list.status).toBe(200)
    expect(list.json.data).toEqual([{ id: "1", name: "Ada" }, { id: "2", name: "Grace" }])
    const one = await run("GET", ["1"])
    expect(one.json.data).toEqual({ id: "1", name: "Ada" })
    expect(list.raw + one.raw).not.toContain("SECRET")
  })

  it("gives no way to infer a hidden value through fields, filters, sort or search", async () => {
    expect((await run("GET", [], { fields: "salary" })).status).toBe(400)
    expect((await run("GET", [], { salary: "SECRET-900" })).status).toBe(400)
    expect((await run("GET", [], { sort: "salary" })).status).toBe(400)
    const search = await run("GET", ["search"], { q: "SECRET" })
    expect(search.status).toBe(200)
    expect(search.json.data).toEqual([])
  })

  it("refuses raw range reads", async () => {
    const range = await run("GET", ["range", "A1:C3"])
    expect(range.status).toBe(403)
    expect(range.raw).not.toContain("SECRET")
  })

  it("refuses writes to a hidden column without naming it in the column list", async () => {
    for (const result of [
      await run("POST", [], {}, { id: "3", name: "Alan", salary: "1" }),
      await run("PATCH", ["1"], {}, { salary: "1" }),
      await run("PUT", ["1"], {}, { id: "1", name: "Ada", salary: "1" }),
    ]) {
      expect(result.status).toBe(422)
    }
    expect(stub.dump(TAB.title)).toEqual(GRID)
  })

  it("keeps hidden cells through PUT and PATCH, and leaves them out of the answer", async () => {
    const put = await run("PUT", ["1"], {}, { id: "1", name: "Augusta" })
    expect(put.status).toBe(200)
    expect(put.raw).not.toContain("SECRET")
    const patch = await run("PATCH", ["2"], {}, { name: "Hopper" })
    expect(patch.raw).not.toContain("SECRET")
    expect(stub.dump(TAB.title)).toEqual([
      ["id", "name", "salary"],
      ["1", "Augusta", "SECRET-900"],
      ["2", "Hopper", "SECRET-800"],
    ])
  })

  it("leaves new rows' hidden cells blank", async () => {
    const post = await run("POST", [], {}, { id: "3", name: "Alan" })
    expect(post.status).toBe(201)
    const row = stub.dump(TAB.title)[3]
    expect(row[0]).toBe("3")
    expect(row[2] ?? "").toBe("")
  })

  it("rejects a primary key that is hidden, and null restores every column", async () => {
    const bad = await apis.updateApi(apiId, { exposedColumns: ["name"] }, userId)
    expect("error" in bad && bad.error.fields?.exposedColumns).toBeTruthy()
    const cleared = await apis.updateApi(apiId, { exposedColumns: null }, userId)
    expect(cleared.ok).toBe(true)
    expect((await run("GET", ["1"])).json.data).toEqual({ id: "1", name: "Ada", salary: "SECRET-900" })
  })
})
