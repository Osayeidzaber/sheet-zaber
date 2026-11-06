import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { sha256 } from "@/lib/crypto"
import type { SnippetMethod } from "@/lib/snippets"
import type { ApiKeyScope } from "@/server/db/queries/api-keys"
import { apiKeys } from "@/server/db/schema"

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
 * Integration coverage for the key service (`backend-api-contract.md` §2, §4.6/§4.7;
 * `security.md` "hashed API keys"): the plaintext exists exactly once, every read path is
 * hash-free, and `authorizeKeyCall` is exhaustively pinned — it IS the engine's authorization
 * surface, so each row of its decision table carries an asserted code.
 */

type KeysService = typeof import("@/server/keys/service")
type UsersModule = typeof import("@/server/db/queries/users")
type EngineKey = NonNullable<Awaited<ReturnType<KeysService["authenticateKey"]>>>
type AuthorizeApi = Parameters<KeysService["authorizeKeyCall"]>[1]

const PLAINTEXT_RE = /^sz_live_[0-9a-f]{32}$/

/** `CreatedApiKey` = the §4.6 meta plus the one-time plaintext; nothing else may ever appear. */
const CREATED_KEYS = [
  "allowedApiIds",
  "createdAt",
  "expiresAt",
  "id",
  "keyPreview",
  "lastUsedAt",
  "name",
  "plaintext",
  "revokedAt",
  "scopes",
  "userId",
]

/** The engine's entire principal view — no hash, no preview, no timestamps. */
const ENGINE_KEY_KEYS = ["allowedApiIds", "id", "name", "scopes", "userId"]

const NOT_FOUND = {
  error: { code: "not_found", message: "No API key was found with that id.", category: "not_found" },
} as const

const API_ID = randomUUID()
const OTHER_API_ID = randomUUID()
const OWNER = "user-owner"
const STRANGER = "user-stranger"

function isFail(result: object): result is {
  error: { code: string; message: string; category: string; fields?: Record<string, string> }
} {
  return "error" in result
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000)
}

function engineKey(overrides: Partial<EngineKey> = {}): EngineKey {
  return { id: "key-1", userId: OWNER, scopes: ["read"], allowedApiIds: null, name: "ci", ...overrides }
}

function engineApi(overrides: Partial<AuthorizeApi> = {}): AuthorizeApi {
  return {
    id: API_ID,
    userId: OWNER,
    permissions: "read",
    allowedOperations: ["GET"],
    ...overrides,
  }
}

/**
 * The documented rule, restated independently of the implementation: the FIRST failing rule in
 * this order names the code. The exhaustive test below proves `authorizeKeyCall` cannot drift
 * from it.
 */
function expectedCode(key: EngineKey, api: AuthorizeApi, method: SnippetMethod): string | null {
  if (key.userId !== api.userId) return "api_not_found"
  if (key.allowedApiIds !== null && !key.allowedApiIds.includes(api.id)) return "key_restricted"
  if (!api.allowedOperations.includes(method)) return "operation_not_allowed"
  if (method !== "GET" && api.permissions !== "read_write") return "operation_not_allowed"
  if (!key.scopes.includes(method === "GET" ? "read" : "write")) return "key_scope_insufficient"
  return null
}

let test: TestDb
let service: KeysService
let users: UsersModule

describe("api key service", () => {
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
    service = await import("@/server/keys/service")
    users = await import("@/server/db/queries/users")
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
      email: `keys-${label}-${stamp}@example.com`,
      role: "user",
    })
  }

  async function seedKey(label: string, overrides: Record<string, unknown> = {}) {
    const alice = await seedUser(label)
    const result = await service.createKey({ name: `key-${label}`, ...overrides }, alice.id)
    if (!result.ok) throw new Error(`seed key failed: ${result.error.code}`)
    return { alice, created: result.data }
  }

  /** The stored row, read raw — the only way to prove what the database actually holds. */
  async function rawRow(id: string) {
    const [row] = await test.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1)
    return row
  }

  describe("createKey", () => {
    it("mints a sz_live_ key, returns the plaintext exactly once and stores only hash + preview", async () => {
      const alice = await seedUser("create")
      const expiresAt = hoursFromNow(24)

      const result = await service.createKey(
        { name: "ci runner", scopes: ["read", "write"], allowedApiIds: [API_ID], expiresAt },
        alice.id
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(Object.keys(result.data).sort()).toEqual(CREATED_KEYS)
      expect(result.data.plaintext).toMatch(PLAINTEXT_RE)
      expect(result.data).toMatchObject({
        name: "ci runner",
        scopes: ["read", "write"],
        allowedApiIds: [API_ID],
        userId: alice.id,
        revokedAt: null,
        lastUsedAt: null,
      })
      expect(result.data.keyPreview).toContain("sz_live_")
      expect(result.data.expiresAt).toBeInstanceOf(Date)

      // The database holds the SHA-256 of the plaintext and the preview — nothing more.
      const row = await rawRow(result.data.id)
      expect(row?.keyHash).toBe(sha256(result.data.plaintext))
      expect(row?.keyPreview).toBe(result.data.keyPreview)
      expect(JSON.stringify(row ?? {})).not.toContain(result.data.plaintext)

      // The engine can authenticate the plaintext; the hash itself cannot be used as a bearer token.
      expect(await service.authenticateKey(result.data.plaintext)).toMatchObject({
        id: result.data.id,
        userId: alice.id,
        scopes: ["read", "write"],
        allowedApiIds: [API_ID],
        name: "ci runner",
      })
      expect(await service.authenticateKey(row?.keyHash ?? "")).toBeNull()
    })

    it("applies the documented defaults and rejects malformed input with per-field messages", async () => {
      const alice = await seedUser("defaults")

      const minimal = await service.createKey({ name: "just a name" }, alice.id)
      expect(minimal.ok).toBe(true)
      if (!minimal.ok) return
      expect(minimal.data).toMatchObject({ scopes: ["read"], allowedApiIds: null, expiresAt: null })

      for (const [input, field] of [
        [{ name: "" }, "name"],
        [{ name: "x", scopes: [] }, "scopes"],
        [{ name: "x", scopes: ["read", "delete"] }, "scopes"],
        [{ name: "x", allowedApiIds: ["not-a-uuid"] }, "allowedApiIds"],
        [{ name: "x", expiresAt: "yesterday" }, "expiresAt"],
        [{ scopes: ["read"] }, "name"],
      ] as [Record<string, unknown>, string][]) {
        const result = await service.createKey(input, alice.id)
        expect(isFail(result) && result.error.code).toBe("validation_failed")
        if (isFail(result)) expect(Object.keys(result.error.fields ?? {})).toContain(field)
      }

      for (const junk of [null, undefined, 7, "sz_live_deadbeef", []]) {
        expect(isFail(await service.createKey(junk, alice.id))).toBe(true)
      }
      expect(await service.listKeys(alice.id)).toMatchObject({ ok: true, data: [expect.objectContaining({ name: "just a name" })] })
    })

    it("keeps key material out of every read path the dashboard and the engine expose", async () => {
      const { alice, created } = await seedKey("leak")
      const hash = sha256(created.plaintext)

      const listed = await service.listKeys(alice.id)
      expect(listed.ok).toBe(true)
      if (!listed.ok) return
      expect(listed.data).toHaveLength(1)
      for (const meta of listed.data) {
        expect(Object.keys(meta)).not.toContain("keyHash")
        expect(Object.keys(meta)).not.toContain("plaintext")
        expect(JSON.stringify(meta)).not.toContain(hash)
      }
      // `Object.keys` of every meta payload: exactly the §4.6 shape (minus the one-time plaintext).
      expect(Object.keys(listed.data[0] ?? {}).sort()).toEqual(CREATED_KEYS.filter((k) => k !== "plaintext"))

      const authenticated = await service.authenticateKey(created.plaintext)
      expect(Object.keys(authenticated ?? {}).sort()).toEqual(ENGINE_KEY_KEYS)
      expect(JSON.stringify(authenticated ?? {})).not.toContain(hash)
      expect(JSON.stringify(authenticated ?? {})).not.toContain(created.plaintext)

      // Regenerate is the only other producer of a plaintext, and its meta is hash-free too.
      const again = await service.regenerateKey(created.id, alice.id)
      expect(again.ok).toBe(true)
      if (!again.ok) return
      expect(Object.keys(again.data).sort()).toEqual(CREATED_KEYS)
      expect(again.data.plaintext).not.toBe(created.plaintext)
      const secondList = await service.listKeys(alice.id)
      expect(secondList.ok).toBe(true)
      if (!secondList.ok) return
      for (const meta of secondList.data) expect(JSON.stringify(meta)).not.toContain(hash)
    })
  })

  describe("revokeKey and regenerateKey", () => {
    it("revokes for the owner only, idempotently, and takes the plaintext out of the engine path", async () => {
      const alice = await seedUser("revoke")
      const bob = await seedUser("revoke-b")
      const created = await service.createKey({ name: "to-revoke" }, alice.id)
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const bobCreated = await service.createKey({ name: "bob's own" }, bob.id)
      expect(bobCreated.ok).toBe(true)
      if (!bobCreated.ok) return

      // A foreign id and a missing id are one envelope.
      const foreign = await service.revokeKey(created.data.id, bob.id)
      const absent = await service.revokeKey(randomUUID(), bob.id)
      expect(foreign).toEqual(absent)
      expect(foreign).toEqual(NOT_FOUND)
      expect(await service.authenticateKey(created.data.plaintext)).toMatchObject({ id: created.data.id })

      expect(await service.revokeKey(created.data.id, alice.id)).toMatchObject({ ok: true })
      expect(await service.authenticateKey(created.data.plaintext)).toBeNull()
      // Bob's own key is untouched by alice's revoke.
      expect(await service.authenticateKey(bobCreated.data.plaintext)).toMatchObject({ userId: bob.id })

      // Idempotent, and the first timestamp survives — the repository's UPDATE is once-only.
      const firstRevokedAt = (await rawRow(created.data.id))?.revokedAt
      expect(firstRevokedAt).toBeInstanceOf(Date)
      expect(await service.revokeKey(created.data.id, alice.id)).toMatchObject({ ok: true })
      expect((await rawRow(created.data.id))?.revokedAt).toEqual(firstRevokedAt)

      // The revoked row leaves the inventory (it is history, not a choice).
      expect(await service.listKeys(alice.id)).toMatchObject({ ok: true, data: [] })
    })

    it("regenerates as revoke + insert with the same name, scopes and allowedApiIds", async () => {
      const alice = await seedUser("regen")
      const created = await service.createKey(
        { name: "rotation", scopes: ["read", "write"], allowedApiIds: [API_ID, OTHER_API_ID], expiresAt: hoursFromNow(6) },
        alice.id
      )
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const old = created.data
      const oldPlaintext = old.plaintext

      const result = await service.regenerateKey(old.id, alice.id)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const fresh = result.data
      const freshPlaintext = fresh.plaintext

      expect(freshPlaintext).toMatch(PLAINTEXT_RE)
      expect(freshPlaintext).not.toBe(oldPlaintext)
      expect(fresh.id).not.toBe(old.id)
      expect(fresh).toMatchObject({
        name: old.name,
        scopes: old.scopes,
        allowedApiIds: old.allowedApiIds,
        userId: alice.id,
      })
      expect(fresh.expiresAt?.getTime()).toBe(old.expiresAt?.getTime())

      // The old credential is dead, the new one lives, and history is preserved on the old row.
      expect(await service.authenticateKey(oldPlaintext)).toBeNull()
      expect(await service.authenticateKey(freshPlaintext)).toMatchObject({ id: fresh.id, userId: alice.id })
      expect((await rawRow(old.id))?.revokedAt).toBeInstanceOf(Date)
      expect((await rawRow(fresh.id))?.revokedAt).toBeNull()
      expect(await service.listKeys(alice.id)).toMatchObject({
        ok: true,
        data: [expect.objectContaining({ id: fresh.id, name: "rotation" })],
      })
    })

    it("drops a lapsed expiry instead of minting a dead replacement, and can rotate a revoked key", async () => {
      const alice = await seedUser("regen-lapsed")
      const created = await service.createKey({ name: "lapsed", expiresAt: hoursFromNow(-2) }, alice.id)
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const dead = await service.authenticateKey(created.data.plaintext)
      expect(dead).toBeNull()

      const result = await service.regenerateKey(created.data.id, alice.id)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.expiresAt).toBeNull()
      expect(await service.authenticateKey(result.data.plaintext)).toMatchObject({ id: result.data.id })

      // A revoked row is still the caller's: rotating it again produces a live key.
      const second = await service.regenerateKey(result.data.id, alice.id)
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(await service.authenticateKey(second.data.plaintext)).toMatchObject({ id: second.data.id })
      expect(await service.listKeys(alice.id)).toMatchObject({ ok: true, data: [expect.objectContaining({ id: second.data.id })] })
    })

    it("refuses to regenerate a key it does not own, leaving the real row untouched", async () => {
      const alice = await seedUser("regen-a")
      const bob = await seedUser("regen-b")
      const created = await service.createKey({ name: "bob's" }, bob.id)
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const foreign = await service.regenerateKey(created.data.id, alice.id)
      const absent = await service.regenerateKey(randomUUID(), alice.id)
      expect(foreign).toEqual(absent)
      expect(foreign).toEqual(NOT_FOUND)

      expect(await service.authenticateKey(created.data.plaintext)).toMatchObject({ userId: bob.id })
      expect(await rawRow(created.data.id)).toMatchObject({ revokedAt: null, name: "bob's" })
      expect(await service.listKeys(alice.id)).toMatchObject({ ok: true, data: [] })
    })

    it("hides revoked, expired and unknown credentials behind one indistinguishable null", async () => {
      const alice = await seedUser("auth-shape")
      const expired = await service.createKey({ name: "expired", expiresAt: hoursFromNow(-1) }, alice.id)
      const revoked = await service.createKey({ name: "revoked" }, alice.id)
      if (!expired.ok || !revoked.ok) throw new Error("seed keys failed")
      await service.revokeKey(revoked.data.id, alice.id)

      const outcomes = [
        await service.authenticateKey(expired.data.plaintext),
        await service.authenticateKey(revoked.data.plaintext),
        await service.authenticateKey(`sz_live_${"0".repeat(32)}`),
        await service.authenticateKey(""),
        await service.authenticateKey("not a key at all"),
      ]
      for (const outcome of outcomes) expect(outcome).toBeNull()

      // The expired-but-unrevoked row stays in the inventory so the dashboard can label it;
      // the revoked row is history and leaves it.
      const listed = await service.listKeys(alice.id)
      if (!listed.ok) throw new Error("listKeys failed")
      expect(listed.data.map((meta) => meta.name)).toEqual(["expired"])
    })
  })

  describe("authorizeKeyCall", () => {
    const TABLE: {
      title: string
      key: Partial<EngineKey>
      api: Partial<AuthorizeApi>
      method: SnippetMethod
      expected: { ok: true } | { ok: false; code: string }
    }[] = [
      // legal: unrestricted read key on a read API
      { title: "read key + GET on a read API", key: { scopes: ["read"] }, api: {}, method: "GET", expected: { ok: true } },
      { title: "read key + POST is not an advertised operation", key: { scopes: ["read"] }, api: {}, method: "POST", expected: { ok: false, code: "operation_not_allowed" } },
      { title: "read+write key + GET on a read API", key: { scopes: ["read", "write"] }, api: {}, method: "GET", expected: { ok: true } },
      // scope coherence
      { title: "read-only key + POST on a writable API", key: { scopes: ["read"] }, api: { permissions: "read_write", allowedOperations: ["GET", "POST"] }, method: "POST", expected: { ok: false, code: "key_scope_insufficient" } },
      { title: "read+write key + POST on a writable API", key: { scopes: ["read", "write"] }, api: { permissions: "read_write", allowedOperations: ["GET", "POST"] }, method: "POST", expected: { ok: true } },
      { title: "write-only key + GET needs the read scope", key: { scopes: ["write"] }, api: {}, method: "GET", expected: { ok: false, code: "key_scope_insufficient" } },
      { title: "write-only key + PATCH on a writable API", key: { scopes: ["write"] }, api: { permissions: "read_write", allowedOperations: ["GET", "PATCH"] }, method: "PATCH", expected: { ok: true } },
      { title: "no scopes at all", key: { scopes: [] }, api: {}, method: "GET", expected: { ok: false, code: "key_scope_insufficient" } },
      // the API's own permission flag outranks the key's scope
      { title: "write scope + POST on a READ-only API that advertises POST", key: { scopes: ["read", "write"] }, api: { permissions: "read", allowedOperations: ["GET", "POST"] }, method: "POST", expected: { ok: false, code: "operation_not_allowed" } },
      { title: "write scope + PUT on a read-only API", key: { scopes: ["read", "write"] }, api: { permissions: "read", allowedOperations: ["GET", "PUT", "DELETE"] }, method: "PUT", expected: { ok: false, code: "operation_not_allowed" } },
      { title: "DELETE on a read_write API that only advertises GET", key: { scopes: ["read", "write"] }, api: { permissions: "read_write", allowedOperations: ["GET"] }, method: "DELETE", expected: { ok: false, code: "operation_not_allowed" } },
      { title: "PATCH/PUT/DELETE allowed once the API advertises them", key: { scopes: ["read", "write"] }, api: { permissions: "read_write", allowedOperations: ["GET", "POST", "PATCH", "PUT", "DELETE"] }, method: "PATCH", expected: { ok: true } },
      { title: "PUT, same legal shape", key: { scopes: ["read", "write"] }, api: { permissions: "read_write", allowedOperations: ["GET", "POST", "PATCH", "PUT", "DELETE"] }, method: "PUT", expected: { ok: true } },
      { title: "DELETE, same legal shape", key: { scopes: ["read", "write"] }, api: { permissions: "read_write", allowedOperations: ["GET", "POST", "PATCH", "PUT", "DELETE"] }, method: "DELETE", expected: { ok: true } },
      // key restriction (checked FIRST, even before ownership)
      { title: "restricted key on a listed API", key: { scopes: ["read"], allowedApiIds: [API_ID] }, api: {}, method: "GET", expected: { ok: true } },
      { title: "restricted key on an unlisted API", key: { scopes: ["read"], allowedApiIds: [OTHER_API_ID] }, api: {}, method: "GET", expected: { ok: false, code: "key_restricted" } },
      { title: "empty allow-list restricts everything", key: { scopes: ["read", "write"], allowedApiIds: [] }, api: { permissions: "read_write", allowedOperations: ["GET", "POST"] }, method: "POST", expected: { ok: false, code: "key_restricted" } },
      { title: "restriction outranks the operation check", key: { scopes: ["read"], allowedApiIds: [OTHER_API_ID] }, api: {}, method: "DELETE", expected: { ok: false, code: "key_restricted" } },
      // ownership (never an existence oracle)
      { title: "cross-user key + API reads as not found", key: { scopes: ["read"], userId: STRANGER }, api: {}, method: "GET", expected: { ok: false, code: "api_not_found" } },
      { title: "cross-user write", key: { scopes: ["read", "write"], userId: STRANGER }, api: { permissions: "read_write", allowedOperations: ["GET", "POST"] }, method: "POST", expected: { ok: false, code: "api_not_found" } },
      { title: "a restricted key naming ANOTHER user's api id still ends at api_not_found", key: { scopes: ["read"], userId: STRANGER, allowedApiIds: [API_ID] }, api: {}, method: "GET", expected: { ok: false, code: "api_not_found" } },
      { title: "the api owner alone differs: api_not_found, not key_restricted", key: { scopes: ["read"] }, api: { userId: STRANGER }, method: "GET", expected: { ok: false, code: "api_not_found" } },
    ]

    for (const row of TABLE) {
      it(row.title, () => {
        const key = engineKey(row.key)
        const api = engineApi(row.api)
        expect(service.authorizeKeyCall(key, api, row.method)).toEqual(row.expected)
      })
    }

    it("is pure, total and side-effect-free", () => {
      const key = engineKey({ scopes: ["read", "write"] })
      const api = engineApi({ permissions: "read_write", allowedOperations: ["GET", "POST", "PATCH", "PUT", "DELETE"] })
      const keySnapshot = JSON.stringify(key)
      const apiSnapshot = JSON.stringify(api)

      for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"] as SnippetMethod[]) {
        const first = service.authorizeKeyCall(key, api, method)
        const second = service.authorizeKeyCall(key, api, method)
        expect(second).toEqual(first)
        expect(first).toEqual({ ok: true })
      }
      expect(JSON.stringify(key)).toBe(keySnapshot)
      expect(JSON.stringify(api)).toBe(apiSnapshot)
    })

    it("matches the documented decision table on every combination", () => {
      const scopeSets: ApiKeyScope[][] = [[], ["read"], ["write"], ["read", "write"]]
      const restrictions: (string[] | null)[] = [null, [API_ID], [OTHER_API_ID], []]
      const methods: SnippetMethod[] = ["GET", "POST", "PATCH", "PUT", "DELETE"]
      const apiShapes: Pick<AuthorizeApi, "permissions" | "allowedOperations">[] = [
        { permissions: "read", allowedOperations: ["GET"] },
        // an illegal config (read-only advertising writes) must still be refused by the engine
        { permissions: "read", allowedOperations: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
        { permissions: "read_write", allowedOperations: ["GET"] },
        { permissions: "read_write", allowedOperations: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
      ]
      const owners = [OWNER, STRANGER]

      let cases = 0
      const seenCodes = new Set<string>()
      for (const scopes of scopeSets) {
        for (const allowedApiIds of restrictions) {
          for (const apiShape of apiShapes) {
            for (const method of methods) {
              for (const keyOwner of owners) {
                const key = engineKey({ scopes, allowedApiIds, userId: keyOwner })
                const api = engineApi({ ...apiShape, userId: OWNER })
                const decision = service.authorizeKeyCall(key, api, method)
                const code = expectedCode(key, api, method)
                expect(decision).toEqual(code === null ? { ok: true } : { ok: false, code })
                if (code !== null) seenCodes.add(code)
                cases += 1
              }
            }
          }
        }
      }

      expect(cases).toBe(640)
      expect([...seenCodes].sort()).toEqual([
        "api_not_found",
        "key_restricted",
        "key_scope_insufficient",
        "operation_not_allowed",
      ])
    })
  })

  describe("markKeyUsed", () => {
    async function metas(userId: string) {
      const listed = await service.listKeys(userId)
      if (!listed.ok) throw new Error("listKeys failed")
      return listed.data
    }

    it("exposes the repository's one-write-per-minute throttle through the service", async () => {
      const { alice, created } = await seedKey("used")

      expect((await metas(alice.id))[0]?.lastUsedAt).toBeNull()

      await service.markKeyUsed(created.id)
      const firstUse = (await metas(alice.id))[0]?.lastUsedAt
      expect(firstUse).toBeInstanceOf(Date)

      // A second use inside the window does not touch the row.
      await service.markKeyUsed(created.id)
      expect((await metas(alice.id))[0]?.lastUsedAt).toEqual(firstUse)

      // Age it past the window and the next use writes again.
      await test.update(apiKeys).set({ lastUsedAt: hoursFromNow(-2) }).where(eq(apiKeys.id, created.id))
      await service.markKeyUsed(created.id)
      const secondUse = (await metas(alice.id))[0]?.lastUsedAt
      expect(secondUse).toBeInstanceOf(Date)
      expect(secondUse?.getTime()).toBeGreaterThan(firstUse?.getTime() ?? 0)

      // An unknown id is a no-op, not an error.
      await expect(service.markKeyUsed(randomUUID())).resolves.toBeUndefined()
    })
  })
})
