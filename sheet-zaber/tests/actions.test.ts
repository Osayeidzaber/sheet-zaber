import { randomUUID } from "node:crypto"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest"

import { isActionError, type ActionResult } from "@/lib/action-result"
import { apiRequestLogs } from "@/server/db/schema"
import { fakeSheets, type SheetsStub } from "./helpers/fake-sheets"

import {
  TEST_DB_URL_KEY,
  getTestDb,
  getTestDbUrl,
  getTestPool,
  migrateTestDb,
  startTestDb,
  stopTestDb,
  truncateAll,
  type TestDb,
} from "./helpers/db"

/*
 * Integration coverage for `src/server/actions/**` — the `"use server"` layer the dashboard
 * consumes (`backend-api-contract.md` §2, §4.4, §4.6, §4.7).
 *
 * REAL: embedded PostgreSQL, real `users`/`google_connections`/`registered_spreadsheets`/
 * `api_configurations`/`api_keys`/`invitations`/`audit_logs` rows, the real `readUser` guard
 * verifying a real signed `sz_session` cookie, and the real services deciding every rule. That is
 * the only way to prove the three things this layer owns: (1) every verb fails closed with
 * `unauthenticated` when the session is absent, dead or role-escalated inside the cookie; (2)
 * owner-only verbs answer `forbidden` from the guard BEFORE any service runs; (3) nothing that
 * crosses the browser boundary carries a secret.
 *
 * FAKED, deliberately and completely — no socket is ever opened to Google:
 *  - `next/headers`   → the cookie store an action gets from Next (there is no `Request` here).
 *  - `google/tokens`  → `getAccessToken` returns a fixed string; the real refresh transport, which
 *                       POSTs to Google's token endpoint, is never reachable.
 *  - `google/sheets`  → `createSheetsClient` returns `tests/helpers/fake-sheets`, so the Sheets
 *                       reads the spreadsheets verbs make are answered from an in-memory grid.
 *  - `fetch`          → replaced by a spy that THROWS, so a mock gap becomes a red test instead of
 *                       a live request.
 * The Google happy paths below are therefore MEASURED THROUGH THE FAKE: they prove the action layer
 * resolves the caller's OWN connection, delegates with the right arguments and returns the
 * service's envelope unchanged. They say nothing about live Google behaviour, and no account-level
 * operation is performed (the repo's standing validation policy).
 *
 * `src/server/db/client.ts` binds its pool to `env.DATABASE_URL` at module load, so the URL is
 * repointed at the test instance BEFORE any service, guard or action module is imported.
 */

type SessionModule = typeof import("@/server/auth/session")
type UsersRepo = typeof import("@/server/db/queries/users")
type ConnectionsRepo = typeof import("@/server/db/queries/google-connections")
type SpreadsheetsRepo = typeof import("@/server/db/queries/spreadsheets")
type ApisService = typeof import("@/server/apis/service")
type ConnectionsService = typeof import("@/server/google/connections")
type Actions = {
  session: typeof import("@/server/actions/session")
  spreadsheets: typeof import("@/server/actions/spreadsheets")
  apis: typeof import("@/server/actions/apis")
  keys: typeof import("@/server/actions/keys")
  connections: typeof import("@/server/actions/connections")
  invitations: typeof import("@/server/actions/invitations")
  admin: typeof import("@/server/actions/admin")
  logs: typeof import("@/server/actions/logs")
}

/** §4.6 frozen key sets — an accidental extra field (`keyHash`, `codeHash`) fails these. */
const CONNECTION_KEYS = ["connectedAt", "googleEmail", "id", "lastUsedAt", "scope", "status"]
const SPREADSHEET_KEYS = [
  "connectionId",
  "createdAt",
  "googleSheetId",
  "id",
  "status",
  "tabs",
  "title",
  "updatedAt",
]
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
  "shortId",
  "spreadsheetId",
  "tabTitle",
  "updatedAt",
]
const KEY_LIST_ITEM_KEYS = [
  "allowedApiIds",
  "createdAt",
  "expiresAt",
  "id",
  "keyPreview",
  "lastUsedAt",
  "name",
  "revokedAt",
  "scopes",
]
const INVITATION_LIST_ITEM_KEYS = [
  "createdAt",
  "createdBy",
  "expiresAt",
  "id",
  "label",
  "maxUses",
  "revokedAt",
  "uses",
]
const ADMIN_USER_ROW_KEYS = [
  "apiCount",
  "apiLimitPerDay",
  "createdAt",
  "email",
  "id",
  "invitationId",
  "invitationLabel",
  "lastLoginAt",
  "requestTotal",
  "role",
  "status",
]

/** §4.4 bodies this layer owes, byte-identical to `src/server/http/internal-route.ts:45`. */
const UNAUTHENTICATED = {
  error: { code: "unauthenticated", message: "Sign in to continue.", category: "auth" },
} as const
const FORBIDDEN = {
  error: { code: "forbidden", message: "This area is for platform owners.", category: "auth" },
} as const
const INTERNAL_ERROR = {
  error: { code: "internal_error", message: "The request could not be completed.", category: "internal" },
} as const
const NOT_FOUND = {
  error: { code: "not_found", message: expect.any(String), category: "not_found" },
} as const

/** A `url` the service's parser accepts: 20 characters of its `[A-Za-z0-9_-]{10,120}` id grammar. */
const SHEET_ID = "1BxiMVs0XRA5nFMdKvBZ"
const FAKE_ACCESS_TOKEN = "ya29.action-layer-fake"
const CIPHERTEXT_MARKER = "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu"

/** Mutable seams the `vi.doMock` factories close over — plumbing only, never a rule. */
const seams = {
  cookie: null as string | null,
  tokenRequests: [] as string[],
  clientCreations: 0,
  revokes: [] as string[],
  breakSheetsClient: false,
}

let test: TestDb
let session: SessionModule
let users: UsersRepo
let connections: ConnectionsRepo
let sheets: SpreadsheetsRepo
let apisService: ApisService
let connectionsService: ConnectionsService
let actions: Actions
let stub: SheetsStub
let cookieName = "sz_session"
let startupError: unknown = null
let restoreFetch: (() => void) | undefined

async function raw(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const pool = await getTestPool()
  return (await pool.query(sql, params)).rows
}

/** The workbook the fake answers for: one tab, one header row, two records. */
function fakeSheetsFor(): SheetsStub {
  return fakeSheets({
    title: "Action Layer Sheet",
    grids: {
      Sheet1: [
        ["id", "name", "email"],
        ["1", "Ada", "ada@example.com"],
        ["2", "Grace", "grace@example.com"],
      ],
    },
  })
}

/** The bare `sz_session` VALUE; the cookie store is handed a value, never a `name=value` pair. */
function tokenFor(uid: string, role: "user" | "owner", expOffsetSeconds = 3600): string {
  return session.signSession({ uid, role, exp: Math.floor(Date.now() / 1000) + expOffsetSeconds })
}

/** The only way a server action has a session: Next's cookie store, stood in for by this test. */
function signIn(uid: string, role: "user" | "owner" = "user"): void {
  seams.cookie = tokenFor(uid, role)
}

function dataOf<T>(result: ActionResult<T>): T {
  if (isActionError(result)) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)} ${result.error.fields ? JSON.stringify(result.error.fields) : ""}`)
  }
  return result.data
}

function errorOf<T>(result: ActionResult<T>) {
  if (!isActionError(result)) throw new Error(`expected an error, got ${JSON.stringify(result.data)}`)
  return result.error
}

function keysOf(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort()
}

/**
 * The browser trust boundary, asserted as text: no key hash, no invitation hash, no token material,
 * no ciphertext, no `userId`/`googleSub` on a projected payload. `allow` lists the strings a given
 * verb is sanctioned to return (§4.6/§4.5), so this check cannot pass by accident.
 */
function expectNoSecrets(result: unknown, allow: string[] = []): void {
  const wire = JSON.stringify(result, (_key, value) => (value instanceof Date ? value.toISOString() : value))
  for (const banned of [
    "keyHash",
    "key_hash",
    "codeHash",
    "code_hash",
    "refreshTokenEnc",
    "refresh_token",
    "accessToken",
    "googleSub",
    "google_sub",
    "userId",
    "user_id",
    "plaintext",
    FAKE_ACCESS_TOKEN,
    CIPHERTEXT_MARKER,
  ]) {
    if (allow.includes(banned)) continue
    expect(wire, `wire must not contain ${banned}: ${wire}`).not.toContain(banned)
  }
}

async function seedUser(label: string, role: "user" | "owner" = "user") {
  const stamp = randomUUID()
  return users.createUser({
    googleSub: `sub-${stamp}`,
    email: `actions-${label}-${stamp}@example.com`,
    role,
  })
}

async function seedConnection(userId: string, label: string) {
  return connections.upsertConnection({
    userId,
    googleEmail: `${label}-${randomUUID()}@example.com`,
    refreshTokenEnc: CIPHERTEXT_MARKER,
    scope: "openid email https://www.googleapis.com/auth/spreadsheets",
  })
}

/** `googleSheetId` is the workbook the fake answers for, so the service's §3 boundary can resolve it. */
async function seedSpreadsheet(userId: string, connectionId: string, label: string) {
  return sheets.upsertSpreadsheet({
    userId,
    connectionId,
    googleSheetId: SHEET_ID,
    title: `Roster ${label}`,
    tabs: [{ id: 0, title: "Sheet1", rows: 100, columns: 26 }],
  })
}

/** Seeded through the SERVICE: an action needs a session, and `beforeEach` has none yet. */
async function seedApi(userId: string, spreadsheetId: string, name: string) {
  const result = await apisService.createApi(
    {
      spreadsheetId,
      name,
      tabTitle: "Sheet1",
      headerRow: 1,
      permissions: "read",
      allowedOperations: ["GET"],
    },
    userId
  )
  if (isActionError(result)) {
    throw new Error(`seed api failed: ${result.error.code} ${JSON.stringify(result.error.fields ?? {})}`)
  }
  return result.data
}

type World = {
  ownerId: string
  aliceId: string
  aliceConnId: string
  aliceSheetId: string
  aliceApiId: string
  bobId: string
  bobConnId: string
  bobSheetId: string
  bobApiId: string
}

let world: World

async function buildWorld(): Promise<World> {
  const owner = await seedUser("owner", "owner")
  const alice = await seedUser("alice")
  const bob = await seedUser("bob")
  const aliceConn = await seedConnection(alice.id, "alice")
  const bobConn = await seedConnection(bob.id, "bob")
  const aliceSheet = await seedSpreadsheet(alice.id, aliceConn.id, "alice")
  const bobSheet = await seedSpreadsheet(bob.id, bobConn.id, "bob")
  const aliceApi = await seedApi(alice.id, aliceSheet.id, "Alice roster")
  const bobApi = await seedApi(bob.id, bobSheet.id, "Bob roster")
  return {
    ownerId: owner.id,
    aliceId: alice.id,
    aliceConnId: aliceConn.id,
    aliceSheetId: aliceSheet.id,
    aliceApiId: aliceApi.id,
    bobId: bob.id,
    bobConnId: bobConn.id,
    bobSheetId: bobSheet.id,
    bobApiId: bobApi.id,
  }
}

/** Every exported verb of every action module, callable while signed out. */
function allVerbs(): [string, () => Promise<unknown>][] {
  const uuid = () => randomUUID()
  return [
    ["getSessionUser", () => actions.session.getSessionUser()],
    ["getSessionRole", () => actions.session.getSessionRole()],
    ["registerSpreadsheetAction", () => actions.spreadsheets.registerSpreadsheetAction({ url: SHEET_ID })],
    ["refreshSpreadsheetTabsAction", () => actions.spreadsheets.refreshSpreadsheetTabsAction(uuid())],
    [
      "previewSpreadsheetTabAction",
      () =>
        actions.spreadsheets.previewSpreadsheetTabAction({
          spreadsheetId: uuid(),
          tabTitle: "Sheet1",
          headerRow: 1,
        }),
    ],
    ["removeSpreadsheetAction", () => actions.spreadsheets.removeSpreadsheetAction(uuid())],
    ["listSpreadsheetsAction", () => actions.spreadsheets.listSpreadsheetsAction()],
    ["createApiAction", () => actions.apis.createApiAction({})],
    ["updateApiAction", () => actions.apis.updateApiAction(uuid(), {})],
    ["deleteApiAction", () => actions.apis.deleteApiAction(uuid())],
    ["toggleApiAction", () => actions.apis.toggleApiAction(uuid(), true)],
    ["getApiAction", () => actions.apis.getApiAction(uuid())],
    ["listApisAction", () => actions.apis.listApisAction()],
    ["createKeyAction", () => actions.keys.createKeyAction({ name: "sweep", scopes: ["read"] })],
    ["revokeKeyAction", () => actions.keys.revokeKeyAction(uuid())],
    ["regenerateKeyAction", () => actions.keys.regenerateKeyAction(uuid())],
    ["listKeysAction", () => actions.keys.listKeysAction()],
    ["listConnectionsAction", () => actions.connections.listConnectionsAction()],
    ["pickerTokenAction", () => actions.connections.pickerTokenAction("00000000-0000-4000-8000-000000000000")],
    ["disconnectGoogleAction", () => actions.connections.disconnectGoogleAction(uuid())],
    ["createInvitationsAction", () => actions.invitations.createInvitationsAction({ count: 1 })],
    ["inviteUsersAction", () => actions.invitations.inviteUsersAction(["a@example.com"], {})],
    ["revokeInvitationAction", () => actions.invitations.revokeInvitationAction(uuid())],
    ["listInvitationsAction", () => actions.invitations.listInvitationsAction()],
    ["listAdminInvitationsAction", () => actions.invitations.listAdminInvitationsAction()],
    ["listAdminUsersAction", () => actions.admin.listAdminUsersAction()],
    ["setUserStatusAction", () => actions.admin.setUserStatusAction(uuid(), "disabled")],
    ["setUserApiLimitAction", () => actions.admin.setUserApiLimitAction(uuid(), 10)],
    ["promoteUserAction", () => actions.admin.promoteUserAction(uuid())],
    ["demoteUserAction", () => actions.admin.demoteUserAction(uuid())],
    ["deleteUserAction", () => actions.admin.deleteUserAction(uuid())],
    ["listLogsAction", () => actions.logs.listLogsAction({})],
    ["analyticsOverviewAction", () => actions.logs.analyticsOverviewAction({})],
    ["analyticsUsageByApiAction", () => actions.logs.analyticsUsageByApiAction()],
  ]
}

const OWNER_ONLY_VERBS: [string, () => Promise<unknown>][] = [
  ["createInvitationsAction", () => actions.invitations.createInvitationsAction({ count: 1 })],
  ["inviteUsersAction", () => actions.invitations.inviteUsersAction(["a@example.com"], {})],
  ["revokeInvitationAction", () => actions.invitations.revokeInvitationAction(randomUUID())],
  ["listInvitationsAction", () => actions.invitations.listInvitationsAction()],
  ["listAdminInvitationsAction", () => actions.invitations.listAdminInvitationsAction()],
  ["listAdminUsersAction", () => actions.admin.listAdminUsersAction()],
  ["setUserStatusAction", () => actions.admin.setUserStatusAction(randomUUID(), "disabled")],
  ["setUserApiLimitAction", () => actions.admin.setUserApiLimitAction(randomUUID(), 10)],
  ["promoteUserAction", () => actions.admin.promoteUserAction(randomUUID())],
  ["demoteUserAction", () => actions.admin.demoteUserAction(randomUUID())],
  ["deleteUserAction", () => actions.admin.deleteUserAction(randomUUID())],
]

beforeAll(async () => {
  try {
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

    // Last line of defence: gaxios, the OAuth refresh transport and `revokeToken()` all reach
    // `fetch`. Throwing turns a mock gap into a failed test, never into a request to Google.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("the action layer attempted a real network call")
    })
    restoreFetch = () => spy.mockRestore()

    // Registered before the first dynamic import, so no module in the graph sees a real version.
    vi.doMock("next/headers", async () => {
      const { SESSION_COOKIE } = await import("@/server/auth/session")
      return {
        cookies: async () => ({
          get: (name: string) =>
            name === SESSION_COOKIE && seams.cookie !== null ? { name, value: seams.cookie } : undefined,
        }),
      }
    })

    vi.doMock("@/server/google/tokens", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/server/google/tokens")>()
      return {
        ...actual,
        evictAccessToken: (connectionId: string) => {
          seams.tokenRequests.push(`evict:${connectionId}`)
        },
        getAccessToken: async (row: { id: string }) => {
          seams.tokenRequests.push(row.id)
          return FAKE_ACCESS_TOKEN
        },
        clearAccessTokenCache: () => {},
      }
    })

    vi.doMock("@/server/google/sheets", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/server/google/sheets")>()
      return {
        ...actual,
        createSheetsClient: () => {
          seams.clientCreations += 1
          if (seams.breakSheetsClient) throw new Error("cause text must never reach the wire")
          return stub
        },
      }
    })

    session = await import("@/server/auth/session")
    cookieName = session.SESSION_COOKIE
    users = await import("@/server/db/queries/users")
    connections = await import("@/server/db/queries/google-connections")
    sheets = await import("@/server/db/queries/spreadsheets")
    apisService = await import("@/server/apis/service")
    connectionsService = await import("@/server/google/connections")
    actions = {
      session: await import("@/server/actions/session"),
      spreadsheets: await import("@/server/actions/spreadsheets"),
      apis: await import("@/server/actions/apis"),
      keys: await import("@/server/actions/keys"),
      connections: await import("@/server/actions/connections"),
      invitations: await import("@/server/actions/invitations"),
      admin: await import("@/server/actions/admin"),
      logs: await import("@/server/actions/logs"),
    }
  } catch (error) {
    startupError = error
    console.error("[actions.test] setup failed:", error)
  }
}, 300_000)

beforeEach(async (ctx) => {
  if (startupError) ctx.skip()
  // Best-effort Google revoke is injected too (§2), so even a configured client cannot reach it.
  connectionsService.setRevokeTransport(async (token) => {
    seams.revokes.push(token)
  })
  stub = fakeSheetsFor()
  await truncateAll()
  world = await buildWorld()
})

afterEach(() => {
  seams.cookie = null
  seams.tokenRequests.length = 0
  seams.clientCreations = 0
  seams.revokes.length = 0
  seams.breakSheetsClient = false
})

afterAll(async () => {
  restoreFetch?.()
  vi.doUnmock("next/headers")
  vi.doUnmock("@/server/google/tokens")
  vi.doUnmock("@/server/google/sheets")
  connectionsService.setRevokeTransport(null)
  await stopTestDb().catch(() => {})
})

describe("the layer is thin and complete", () => {
  it("exports exactly the verbs this file drives, and only async functions", () => {
    const exported = Object.entries(actions).flatMap(([file, mod]) =>
      Object.entries(mod).map(([name, fn]) => [`${file}.${name}`, fn] as const)
    )
    expect(exported.length).toBe(allVerbs().length)
    for (const [name, fn] of exported) {
      // A `"use server"` module may export nothing but async functions.
      expect(typeof fn, name).toBe("function")
    }
  })

  it("delegates without adding a rule: the same foreign id answers exactly as the service does", async () => {
    const { getApi } = await import("@/server/apis/service")
    signIn(world.bobId)
    const viaAction = await actions.apis.getApiAction(world.aliceApiId)
    const viaService = await getApi(world.aliceApiId, world.bobId)
    expect(viaAction).toEqual(viaService)
    expect(viaAction).toEqual(NOT_FOUND)
  })

  it("adds no row when a verb is refused: an owner-only call from a user changes nothing", async () => {
    signIn(world.aliceId)
    expect(await actions.admin.setUserStatusAction(world.bobId, "disabled")).toEqual(FORBIDDEN)
    const rows = await raw("SELECT status FROM users WHERE id=$1", [world.bobId])
    expect(rows[0]?.status).toBe("active")
  })

  it("runs no query at all while signed out", async () => {
    const before = await raw("SELECT count(*)::int AS n FROM invitations")
    await actions.invitations.createInvitationsAction({ count: 5 })
    expect(await raw("SELECT count(*)::int AS n FROM invitations")).toEqual(before)
  })

  it("takes the session from Next's cookie store, which is all a server action has", async () => {
    const guards = await import("@/server/auth/guards")
    // Outside production the cookie is `sz_session`; the store is keyed by exactly that name.
    expect(cookieName).toBe("sz_session")
    expect(seams.cookie).toBeNull()
    expect(await guards.readUser()).toBeNull()
    signIn(world.aliceId)
    expect(await guards.readUser()).toEqual({
      id: world.aliceId,
      email: expect.any(String),
      role: "user",
    })
  })
})

describe("every verb fails closed with no session", () => {
  it("answers the §4.4 unauthenticated envelope on all 31 verbs", async () => {
    for (const [name, call] of allVerbs()) {
      expect(await call(), name).toEqual(UNAUTHENTICATED)
    }
  })

  it("answers it for a forged signature, a tampered one and an expired cookie", async () => {
    const genuine = tokenFor(world.aliceId, "user")
    const tokens = [
      `${world.aliceId}.forged`,
      `${genuine.slice(0, -2)}xy`,
      tokenFor(world.aliceId, "user", -60),
    ]
    for (const token of tokens) {
      seams.cookie = token
      for (const [name, call] of allVerbs()) {
        expect(await call(), `${name} @ ${token.slice(0, 12)}`).toEqual(UNAUTHENTICATED)
      }
    }
  })

  it("answers it for a disabled account still holding a valid cookie (the guard re-reads users.status)", async () => {
    signIn(world.aliceId)
    expect(dataOf(await actions.apis.listApisAction())).toHaveLength(1)

    await users.setUserStatus(world.aliceId, "disabled")
    expect(await actions.apis.listApisAction()).toEqual(UNAUTHENTICATED)
    expect(await actions.admin.listAdminUsersAction()).toEqual(UNAUTHENTICATED)
  })

  it("reads the role from the database, never from the cookie claim: a user cannot open an owner door", async () => {
    seams.cookie = tokenFor(world.aliceId, "owner")
    expect(dataOf(await actions.session.getSessionUser()).role).toBe("user")
    for (const [name, call] of OWNER_ONLY_VERBS) {
      expect(await call(), name).toEqual(FORBIDDEN)
    }
  })
})

describe("owner-only doors", () => {
  it("answer forbidden to a valid non-owner session, before the service runs", async () => {
    signIn(world.aliceId)
    for (const [name, call] of OWNER_ONLY_VERBS) {
      expect(await call(), name).toEqual(FORBIDDEN)
    }
  })

  it("stay open to a user's own verbs and to the owner's admin verbs", async () => {
    signIn(world.aliceId)
    expect(dataOf(await actions.session.getSessionRole())).toEqual({ role: "user" })
    expect(dataOf(await actions.apis.listApisAction())).toHaveLength(1)
    expect(dataOf(await actions.connections.listConnectionsAction())).toHaveLength(1)

    signIn(world.ownerId, "owner")
    expect(await actions.admin.listAdminUsersAction()).toMatchObject({ ok: true })
    expect(await actions.invitations.listInvitationsAction()).toMatchObject({ ok: true })
  })
})

describe("session reads", () => {
  it("getSessionUser returns exactly {id, email, role}", async () => {
    signIn(world.aliceId)
    const result = await actions.session.getSessionUser()
    expect(keysOf(dataOf(result))).toEqual(["email", "id", "role"])
    expectNoSecrets(result)
  })
})

describe("spreadsheets actions", () => {
  it("registers through the caller's OWN connection and returns the §4.6 Spreadsheet", async () => {
    signIn(world.aliceId)
    const result = await actions.spreadsheets.registerSpreadsheetAction({ url: SHEET_ID })
    const row = dataOf(result)
    expect(keysOf(row)).toEqual(SPREADSHEET_KEYS)
    expect(row.googleSheetId).toBe(SHEET_ID)
    expect(row.title).toBe("Action Layer Sheet")
    expect(row.tabs.map((tab) => tab.title)).toEqual(["Sheet1"])
    expectNoSecrets(result)
    // MEASURED THROUGH THE FAKE: the deps resolved the caller's own connection, never another's.
    expect([...new Set(seams.tokenRequests)]).toEqual([world.aliceConnId])
    expect(seams.clientCreations).toBeGreaterThan(0)
  })

  it("names a foreign connection instead of minting from it", async () => {
    signIn(world.aliceId)
    const error = errorOf(await actions.spreadsheets.registerSpreadsheetAction({ url: SHEET_ID, connectionId: world.bobConnId }))
    expect(error.code).toBe("not_found")
    expect(seams.tokenRequests).toEqual([])
    expect(seams.clientCreations).toBe(0)
  })

  it("lists what is registered without touching Google", async () => {
    signIn(world.aliceId)
    const rows = dataOf(await actions.spreadsheets.listSpreadsheetsAction())
    expect(rows).toHaveLength(1)
    expect(keysOf(rows[0])).toEqual(SPREADSHEET_KEYS)
    expect(seams.clientCreations).toBe(0)
    expectNoSecrets(await actions.spreadsheets.listSpreadsheetsAction(world.aliceConnId))
    expect(dataOf(await actions.spreadsheets.listSpreadsheetsAction(world.bobConnId))).toHaveLength(0)
  })

  it("refreshes the tab snapshot of the caller's own spreadsheet", async () => {
    signIn(world.aliceId)
    const result = await actions.spreadsheets.refreshSpreadsheetTabsAction(world.aliceSheetId)
    expect(keysOf(dataOf(result))).toEqual(["tabs"])
    expect([...new Set(seams.tokenRequests)]).toEqual([world.aliceConnId])
  })

  it("previews a tab and keeps the service's cap on cell data", async () => {
    signIn(world.aliceId)
    const preview = dataOf(
      await actions.spreadsheets.previewSpreadsheetTabAction({
        spreadsheetId: world.aliceSheetId,
        tabTitle: "Sheet1",
        headerRow: 1,
      })
    )
    expect(keysOf(preview)).toEqual(["headers", "records", "truncated"])
    expect(preview.headers).toEqual(["id", "name", "email"])
    expect(preview.records).toHaveLength(2)
    expect(preview.records[0]).toEqual({ id: "1", name: "Ada", email: "ada@example.com" })
    expect(preview.truncated).toBe(false)
  })

  it("refuses a non-numeric header row with the service's field error, not a coercion", async () => {
    signIn(world.aliceId)
    const error = errorOf(
      await actions.spreadsheets.previewSpreadsheetTabAction({
        spreadsheetId: world.aliceSheetId,
        tabTitle: "Sheet1",
        // @ts-expect-error a client-shaped value is never trusted; `z.coerce.number()` decides.
        headerRow: "2; DROP TABLE users",
      })
    )
    expect(error.code).toBe("validation_failed")
    expect(keysOf(error.fields ?? {})).toEqual(["headerRow"])
  })

  it("answers not_found identically for an absent, a foreign and a malformed id (no existence oracle)", async () => {
    signIn(world.bobId)
    for (const id of [world.aliceSheetId, randomUUID(), "not-a-uuid"]) {
      expect(await actions.spreadsheets.removeSpreadsheetAction(id), id).toEqual(NOT_FOUND)
    }
    expect(await raw("SELECT id FROM registered_spreadsheets WHERE id=$1", [world.aliceSheetId])).toHaveLength(1)
  })

  it("removes the caller's spreadsheet and the schema cascades its APIs", async () => {
    signIn(world.aliceId)
    expect(dataOf(await actions.spreadsheets.removeSpreadsheetAction(world.aliceSheetId))).toEqual({
      id: world.aliceSheetId,
    })
    expect(dataOf(await actions.spreadsheets.listSpreadsheetsAction())).toHaveLength(0)
    expect(dataOf(await actions.apis.listApisAction())).toHaveLength(0)
  })

  it("turns a throw inside the delegated work into internal_error and never echoes the cause", async () => {
    signIn(world.aliceId)
    seams.breakSheetsClient = true
    const result = await actions.spreadsheets.refreshSpreadsheetTabsAction(world.aliceSheetId)
    expect(result).toEqual(INTERNAL_ERROR)
    expect(JSON.stringify(result)).not.toContain("cause text")
  })

  it("refuses to register at all when the caller has never connected", async () => {
    signIn(world.ownerId, "owner")
    const error = errorOf(await actions.spreadsheets.registerSpreadsheetAction({ url: SHEET_ID }))
    expect(["validation_failed", "google_not_connected", "google_reauth_required"]).toContain(error.code)
    expect(seams.clientCreations).toBe(0)
  })
})

describe("apis actions", () => {
  it("creates and returns the §4.6 ApiConfig; a bad body gets the service's field errors", async () => {
    signIn(world.aliceId)
    const created = dataOf(
      await actions.apis.createApiAction({
        spreadsheetId: world.aliceSheetId,
        name: "People",
        tabTitle: "Sheet1",
        headerRow: 1,
        permissions: "read_write",
        allowedOperations: ["GET", "POST"],
      })
    )
    expect(keysOf(created)).toEqual(API_CONFIG_KEYS)
    expect(created.enabled).toBe(true)
    expectNoSecrets(await actions.apis.listApisAction())

    const error = errorOf(await actions.apis.createApiAction({ spreadsheetId: world.aliceSheetId }))
    expect(error.code).toBe("validation_failed")
    expect(keysOf(error.fields ?? {})).toEqual(expect.arrayContaining(["name", "tabTitle"]))
  })

  it("does not invent a row: the created api is exactly what the service persisted", async () => {
    signIn(world.aliceId)
    const created = dataOf(
      await actions.apis.createApiAction({
        spreadsheetId: world.aliceSheetId,
        name: "Thin",
        tabTitle: "Sheet1",
        permissions: "read",
        allowedOperations: ["GET"],
        rateLimitPerHour: 60,
        primaryKeyColumn: "id",
        description: "no logic here",
      })
    )
    expect(await raw("SELECT name, description, primary_key_column, rate_limit_per_hour, enabled FROM api_configurations WHERE id=$1", [created.id])).toEqual([
      { name: "Thin", description: "no logic here", primary_key_column: "id", rate_limit_per_hour: 60, enabled: true },
    ])
  })

  it("refuses an api over someone else's spreadsheet", async () => {
    signIn(world.bobId)
    expect(
      errorOf(
        await actions.apis.createApiAction({
          spreadsheetId: world.aliceSheetId,
          name: "Stolen",
          tabTitle: "Sheet1",
          headerRow: 1,
          permissions: "read",
          allowedOperations: ["GET"],
        })
      ).code
    ).toBe("not_found")
  })

  it("updates its own api and refuses another owner's", async () => {
    signIn(world.aliceId)
    expect(dataOf(await actions.apis.updateApiAction(world.aliceApiId, { description: "via action" })).description).toBe("via action")

    signIn(world.bobId)
    expect(errorOf(await actions.apis.updateApiAction(world.aliceApiId, { description: "nope" })).code).toBe("not_found")
    expect(errorOf(await actions.apis.deleteApiAction(world.aliceApiId)).code).toBe("not_found")
    expect(errorOf(await actions.apis.getApiAction(world.aliceApiId)).code).toBe("not_found")
    expect(dataOf(await actions.apis.listApisAction())).toHaveLength(1)
  })

  it("toggles with a boolean or the text a hidden input sends, and refuses anything else", async () => {
    signIn(world.aliceId)
    expect(await actions.apis.toggleApiAction(world.aliceApiId, "false")).toMatchObject({ ok: true })
    expect(dataOf(await actions.apis.getApiAction(world.aliceApiId)).enabled).toBe(false)
    expect(await actions.apis.toggleApiAction(world.aliceApiId, true)).toMatchObject({ ok: true })
    expect(dataOf(await actions.apis.getApiAction(world.aliceApiId)).enabled).toBe(true)

    for (const bad of ["yes", 1, {}, [], null, undefined, "TRUE", "0"]) {
      const error = errorOf(await actions.apis.toggleApiAction(world.aliceApiId, bad))
      expect(error.code, String(bad)).toBe("validation_failed")
      expect(error.fields, String(bad)).toEqual({ enabled: "must be true or false" })
    }
    expect(dataOf(await actions.apis.getApiAction(world.aliceApiId)).enabled).toBe(true)
  })

  it("deletes its own api and answers not_found for anyone else's", async () => {
    signIn(world.aliceId)
    expect(await actions.apis.deleteApiAction(world.aliceApiId)).toMatchObject({ ok: true })
    expect(dataOf(await actions.apis.listApisAction())).toHaveLength(0)
    expect(await actions.apis.deleteApiAction(world.aliceApiId)).toEqual(NOT_FOUND)
  })
})

describe("keys actions", () => {
  it("reveals the plaintext once, on create and regenerate only", async () => {
    signIn(world.aliceId)
    const created = dataOf(await actions.keys.createKeyAction({ name: "ci", scopes: ["read"] }))
    expect(keysOf(created)).toEqual([...KEY_LIST_ITEM_KEYS, "plaintext", "userId"].sort())
    expect(created.userId).toBe(world.aliceId)
    expect(created.plaintext).toBeTypeOf("string")
    expect(created.plaintext.length).toBeGreaterThan(20)

    const listed = dataOf(await actions.keys.listKeysAction())
    expect(listed).toHaveLength(1)
    expect(keysOf(listed[0])).toEqual(KEY_LIST_ITEM_KEYS)
    expect(listed[0].keyPreview).toBeTypeOf("string")
    expectNoSecrets(await actions.keys.listKeysAction())

    const regenerated = dataOf(await actions.keys.regenerateKeyAction(created.id))
    expect(regenerated.plaintext).not.toBe(created.plaintext)
    expect(await actions.keys.revokeKeyAction(regenerated.id)).toMatchObject({ ok: true })
  })

  it("stores a hash, never the plaintext, so no verb can read the reveal back", async () => {
    signIn(world.aliceId)
    const created = dataOf(await actions.keys.createKeyAction({ name: "hash-only", scopes: ["read"] }))
    const [stored] = await raw("SELECT key_hash, key_preview FROM api_keys WHERE id=$1", [created.id])
    expect(stored?.key_hash).not.toBe(created.plaintext)
    expect(String(stored?.key_hash).length).toBeGreaterThanOrEqual(32)
    expect(JSON.stringify(dataOf(await actions.keys.listKeysAction()))).not.toContain(created.plaintext)
  })

  it("revokes idempotently and keeps another owner's key out of reach", async () => {
    signIn(world.aliceId)
    const created = dataOf(await actions.keys.createKeyAction({ name: "revokeme", scopes: ["read"] }))
    expect(await actions.keys.revokeKeyAction(created.id)).toMatchObject({ ok: true })
    expect(await actions.keys.revokeKeyAction(created.id)).toMatchObject({ ok: true })
    expect(dataOf(await actions.keys.listKeysAction())).toHaveLength(0)

    signIn(world.bobId)
    expect(errorOf(await actions.keys.revokeKeyAction(created.id)).code).toBe("not_found")
    expect(errorOf(await actions.keys.regenerateKeyAction(created.id)).code).toBe("not_found")
    expect(dataOf(await actions.keys.listKeysAction())).toHaveLength(0)
  })

  it("leaves key validation to the service", async () => {
    signIn(world.aliceId)
    const error = errorOf(await actions.keys.createKeyAction({ scopes: ["read"] }))
    expect(error.code).toBe("validation_failed")
    expect(keysOf(error.fields ?? {})).toEqual(["name"])
  })
})

describe("connections actions", () => {
  it("lists the caller's connections in the §4.6 shape — no userId, no ciphertext", async () => {
    signIn(world.aliceId)
    const rows = dataOf(await actions.connections.listConnectionsAction())
    expect(rows).toHaveLength(1)
    expect(keysOf(rows[0])).toEqual(CONNECTION_KEYS)
    expectNoSecrets(await actions.connections.listConnectionsAction())
  })

  it("deletes the caller's own row, which is what enforces access", async () => {
    signIn(world.aliceId)
    expect(dataOf(await actions.connections.disconnectGoogleAction(world.aliceConnId))).toEqual({
      id: world.aliceConnId,
    })
    expect(dataOf(await actions.connections.listConnectionsAction())).toHaveLength(0)
    expect(await raw("SELECT id FROM google_connections WHERE id=$1", [world.aliceConnId])).toHaveLength(0)
    // Without Google client credentials the best-effort revoke is skipped by the service
    // (`google/connections.ts:169`); with them it would go through the injected transport.
    expect(seams.revokes).toHaveLength(0)
  })

  it("answers not_found for a foreign connection and leaves the row alive", async () => {
    signIn(world.bobId)
    expect(await actions.connections.disconnectGoogleAction(world.aliceConnId)).toEqual(NOT_FOUND)
    expect(await raw("SELECT id FROM google_connections WHERE id=$1", [world.aliceConnId])).toHaveLength(1)
    expect(seams.revokes).toHaveLength(0)
  })
})

describe("invitations actions (owner only)", () => {
  it("mints plaintext codes once and lists hash-free rows", async () => {
    signIn(world.ownerId, "owner")
    const created = dataOf(
      await actions.invitations.createInvitationsAction({ count: 2, label: "onboarding wave", maxUses: 1 })
    )
    expect(keysOf(created)).toEqual(["codes", "invitations", "plaintext"])
    expect(created.codes).toHaveLength(2)
    expect(created.codes).toEqual(created.plaintext)
    for (const invitation of created.invitations) expect(keysOf(invitation)).toEqual(INVITATION_LIST_ITEM_KEYS)

    const listed = dataOf(await actions.invitations.listInvitationsAction())
    expect(listed).toHaveLength(2)
    const wire = JSON.stringify(listed)
    expect(wire).not.toContain("codeHash")
    expect(wire).not.toContain("code_hash")
    for (const code of created.codes) expect(wire).not.toContain(code)
  })

  it("forwards an ISO expiresAt as a Date the service decides, and refuses a garbage one", async () => {
    signIn(world.ownerId, "owner")
    const future = new Date(Date.now() + 86_400_000).toISOString()
    expect(await actions.invitations.createInvitationsAction({ count: 1, expiresAt: future })).toMatchObject({ ok: true })
    expect(dataOf(await actions.invitations.listInvitationsAction())[0].expiresAt).toBeInstanceOf(Date)

    const error = errorOf(await actions.invitations.createInvitationsAction({ count: 1, expiresAt: "tomorrow-ish" }))
    expect(error.code).toBe("validation_failed")
    expect(keysOf(error.fields ?? {})).toContain("expiresAt")
  })

  it("revokes idempotently and the admin list derives status and redemptions", async () => {
    signIn(world.ownerId, "owner")
    const created = dataOf(await actions.invitations.createInvitationsAction({ count: 1, label: "revoke me" }))
    const id = created.invitations[0].id
    expect(await actions.invitations.revokeInvitationAction(id)).toEqual({ ok: true, data: { id } })
    expect(await actions.invitations.revokeInvitationAction(id)).toMatchObject({ ok: true })

    const admin = dataOf(await actions.invitations.listAdminInvitationsAction())
    expect(keysOf(admin[0])).toEqual([...INVITATION_LIST_ITEM_KEYS, "redemptions", "status"].sort())
    expect(admin.find((row) => row.id === id)?.status).toBe("revoked")
    expect(admin[0].redemptions).toEqual([])
    // §4.5 line 361 sanctions the redemption rows; a code hash still never appears.
    expect(JSON.stringify(admin)).not.toContain("codeHash")
  })

  it("refuses a malformed invitation id with the service's own validation_failed", async () => {
    signIn(world.ownerId, "owner")
    const error = errorOf(await actions.invitations.revokeInvitationAction("not-a-uuid"))
    expect(error.code).toBe("validation_failed")
    expect(error.fields).toEqual({ id: "must be a uuid" })
  })

  it("audits a minting and a revoking through the service", async () => {
    signIn(world.ownerId, "owner")
    const created = dataOf(await actions.invitations.createInvitationsAction({ count: 1 }))
    await actions.invitations.revokeInvitationAction(created.invitations[0].id)
    const logged = (await raw("SELECT action FROM audit_logs WHERE actor_id=$1 ORDER BY created_at", [world.ownerId])).map(
      (row) => String(row.action)
    )
    expect(logged).toContain("invitation.create")
    expect(logged).toContain("invitation.revoke")
  })
})

describe("admin actions (owner only)", () => {
  it("lists the §4.6 ten-key rows, paged, with no googleSub and no code hash", async () => {
    signIn(world.ownerId, "owner")
    const page = dataOf(await actions.admin.listAdminUsersAction(1, "10"))
    expect(keysOf(page)).toEqual(["page", "perPage", "rows", "total"])
    expect(page.total).toBe(3)
    for (const row of page.rows) expect(keysOf(row)).toEqual(ADMIN_USER_ROW_KEYS)
    expectNoSecrets(await actions.admin.listAdminUsersAction())

    expect(errorOf(await actions.admin.listAdminUsersAction(1, 9999)).fields).toEqual({
      per_page: expect.any(String),
    })
  })

  it("disables an account, and that account's next action is unauthenticated", async () => {
    signIn(world.ownerId, "owner")
    expect(dataOf(await actions.admin.setUserStatusAction(world.aliceId, "disabled")).status).toBe("disabled")

    signIn(world.aliceId)
    expect(await actions.keys.listKeysAction()).toEqual(UNAUTHENTICATED)
    expect(await actions.apis.listApisAction()).toEqual(UNAUTHENTICATED)

    signIn(world.ownerId, "owner")
    expect(dataOf(await actions.admin.setUserStatusAction(world.aliceId, "active")).status).toBe("active")
    signIn(world.aliceId)
    expect(await actions.apis.listApisAction()).toMatchObject({ ok: true })
  })

  it("refuses a status outside the enum with the service's field error and changes nothing", async () => {
    signIn(world.ownerId, "owner")
    for (const status of ["banned", "", 7, null, {}, "ACTIVE"]) {
      const error = errorOf(await actions.admin.setUserStatusAction(world.aliceId, status))
      expect(error.code, String(status)).toBe("validation_failed")
      expect(error.fields, String(status)).toEqual({ status: "must be 'active' or 'disabled'" })
    }
    expect((await raw("SELECT status FROM users WHERE id=$1", [world.aliceId]))[0]?.status).toBe("active")
  })

  it("promotes and demotes, audited, and refuses to let the actor cut their own access", async () => {
    signIn(world.ownerId, "owner")
    expect(dataOf(await actions.admin.promoteUserAction(world.bobId)).role).toBe("owner")
    expect(dataOf(await actions.admin.demoteUserAction(world.bobId)).role).toBe("user")

    const self = errorOf(await actions.admin.demoteUserAction(world.ownerId))
    expect(self.code).toBe("validation_failed")
    expect(JSON.stringify(self)).toContain("you cannot revoke your own access")

    expect(errorOf(await actions.admin.promoteUserAction(randomUUID())).code).toBe("not_found")

    const logged = (await raw("SELECT action FROM audit_logs WHERE actor_id=$1", [world.ownerId])).map((row) =>
      String(row.action)
    )
    expect(logged).toContain("user.promote")
    expect(logged).toContain("user.demote")
  })

  it("deletes an account and the schema cascades its rows", async () => {
    signIn(world.ownerId, "owner")
    expect(dataOf(await actions.admin.deleteUserAction(world.bobId))).toEqual({ id: world.bobId })
    expect(await raw("SELECT id FROM users WHERE id=$1", [world.bobId])).toHaveLength(0)
    expect(await raw("SELECT id FROM google_connections WHERE user_id=$1", [world.bobId])).toHaveLength(0)
    expect(await raw("SELECT id FROM registered_spreadsheets WHERE user_id=$1", [world.bobId])).toHaveLength(0)
    expect(await raw("SELECT id FROM api_configurations WHERE user_id=$1", [world.bobId])).toHaveLength(0)
    expect(errorOf(await actions.admin.deleteUserAction(world.bobId)).code).toBe("not_found")
    // The delete itself is audited against the actor who made it.
    const logged = (await raw("SELECT action, actor_id FROM audit_logs WHERE subject_id=$1", [world.bobId])).map(
      (row) => `${String(row.action)}:${String(row.actor_id)}`
    )
    expect(logged).toContain(`user.delete:${world.ownerId}`)
  })

  it("refuses a non-owner before any query runs", async () => {
    signIn(world.aliceId)
    expect(await actions.admin.deleteUserAction(world.bobId)).toEqual(FORBIDDEN)
    expect(await raw("SELECT id FROM users WHERE id=$1", [world.bobId])).toHaveLength(1)
  })
})

describe("logs and analytics reads", () => {
  async function seedLog(userId: string, apiId: string, statusCode: number) {
    await test.insert(apiRequestLogs).values({
      userId,
      apiId,
      method: "GET",
      path: `/api/v1/${apiId}`,
      statusCode,
      durationMs: 12,
      errorCategory: statusCode >= 400 ? "internal" : null,
      createdAt: new Date(),
    })
  }

  it("scopes a user to their own rows and gives the owner the platform", async () => {
    await seedLog(world.aliceId, world.aliceApiId, 200)
    await seedLog(world.bobId, world.bobApiId, 500)

    signIn(world.aliceId)
    expect(dataOf(await actions.logs.listLogsAction({})).total).toBe(1)
    expect(dataOf(await actions.logs.analyticsOverviewAction({}))).toBeTypeOf("object")
    expect(dataOf(await actions.logs.analyticsUsageByApiAction()).length).toBeGreaterThanOrEqual(1)

    signIn(world.ownerId, "owner")
    expect(dataOf(await actions.logs.listLogsAction({})).total).toBe(2)
  })

  it("cannot be widened by a user_id in a client query record", async () => {
    await seedLog(world.aliceId, world.aliceApiId, 200)
    await seedLog(world.bobId, world.bobApiId, 200)

    signIn(world.aliceId)
    expect(dataOf(await actions.logs.listLogsAction({ user_id: world.bobId })).total).toBe(1)

    signIn(world.ownerId, "owner")
    expect(dataOf(await actions.logs.listLogsAction({ user_id: world.aliceId })).total).toBe(1)
  })

  it("answers the service's validation_failed for a malformed filter, never a 500", async () => {
    signIn(world.aliceId)
    const error = errorOf(await actions.logs.listLogsAction({ page: "many" }))
    expect(error.code).toBe("validation_failed")
    expect(error.fields).toEqual({ page: "must be a whole page number of 1 or greater" })
  })
})
