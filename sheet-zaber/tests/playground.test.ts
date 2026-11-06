import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { isActionError } from "@/lib/action-result"
import { apiRequestLogs } from "@/server/db/schema"
import type { EngineCall } from "@/server/engine/types"

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
 * `POST /api/internal/playground` — the playground proxy (`backend-api-contract.md` §4.8,
 * `security.md` §4).
 *
 * Three blocks, and each test says what it was measured against:
 *
 *   1. the PROXY'S OWN rules, against an injected engine (`PlaygroundDeps.callEngine`, mirroring
 *      `RedeemDeps`/`productionDeps` in `src/server/invitations/service.ts`). A proxy is tested by
 *      recording what it hands over and what it forwards back, so the stub is the instrument, not
 *      a shortcut — and only a stub can be made to throw or to answer with nothing, which is what
 *      `playground_unreachable` exists to describe (§4.8 rule 3).
 *   2. the ROUTE's HTTP rules (session guard, raw-byte ceiling, method switch). None of them reach
 *      an engine at all.
 *   3. the REAL in-process engine (`handleEngineCall`) for what only the engine can settle: the
 *      `keyId`-arm no-oracle 401, status-verbatim over the wire, the 429 verdict and the log row.
 *      Its Google seam is `tests/helpers/fake-sheets.ts`, so no socket is opened anywhere.
 */

const TAB = { id: 0, title: "Sheet1", rows: 100, columns: 26 }

/** The route's raw-text ceiling (`src/app/api/internal/playground/route.ts`). */
const MAX_BODY_BYTES = 1_100_000

const UNAUTHENTICATED_BODY = {
  error: { code: "unauthenticated", message: "Sign in to continue.", category: "auth" },
} as const

const VALID_ANSWER = { status: 200, body: "{}", headers: {} }

describe("playground proxy", () => {
  let test: TestDb
  let session: typeof import("@/server/auth/session")
  let users: typeof import("@/server/db/queries/users")
  let connections: typeof import("@/server/db/queries/google-connections")
  let spreadsheets: typeof import("@/server/db/queries/spreadsheets")
  let engineSupport: typeof import("@/server/db/queries/engine-support")
  let apis: typeof import("@/server/apis/service")
  let keys: typeof import("@/server/keys/service")
  let playground: typeof import("@/server/playground/service")
  let route: typeof import("@/app/api/internal/playground/route")
  let cookieName = "sz_session"

  type RunResult = Awaited<ReturnType<typeof playground.runPlaygroundRequest>>

  async function seedWorld(label: string) {
    const stamp = randomUUID()
    const user = await users.createUser({
      googleSub: `sub-${label}-${stamp}`,
      email: `playground-${label}-${stamp}@example.com`,
      role: "user",
    })
    const connection = await connections.upsertConnection({
      userId: user.id,
      googleEmail: `${label}-${stamp}@example.com`,
      refreshTokenEnc: "c29tZS1jaXBoZXJ0ZXh0LW5vdC1hLXRva2Vu",
      scope: "openid email https://www.googleapis.com/auth/spreadsheets",
    })
    const sheet = await spreadsheets.upsertSpreadsheet({
      userId: user.id,
      connectionId: connection.id,
      googleSheetId: `sheet-${label}-${stamp}`,
      title: `Roster ${label}`,
      tabs: [TAB],
    })
    const api = await apis.createApi(
      {
        spreadsheetId: sheet.id,
        name: `Roster ${label} API`,
        tabTitle: TAB.title,
        headerRow: 1,
        primaryKeyColumn: "id",
        permissions: "read",
        allowedOperations: ["GET"],
      },
      user.id
    )
    if (!api.ok) throw new Error(`seed api failed: ${api.error.code}`)
    const key = await keys.createKey({ name: `${label} key`, scopes: ["read"] }, user.id)
    if (!key.ok) throw new Error(`seed key failed: ${key.error.code}`)

    return { user, connection, sheet, api: api.data, key: key.data }
  }

  type World = Awaited<ReturnType<typeof seedWorld>>
  let alice: World
  let bob: World

  beforeAll(async () => {
    let url: string
    try {
      url = inject(TEST_DB_URL_KEY)
    } catch {
      await startTestDb()
      await migrateTestDb()
      url = getTestDbUrl()
    }
    // Before any module that binds the pool or freezes `env`.
    process.env.DATABASE_URL = url
    test = await getTestDb()

    session = await import("@/server/auth/session")
    cookieName = session.SESSION_COOKIE
    users = await import("@/server/db/queries/users")
    connections = await import("@/server/db/queries/google-connections")
    spreadsheets = await import("@/server/db/queries/spreadsheets")
    engineSupport = await import("@/server/db/queries/engine-support")
    apis = await import("@/server/apis/service")
    keys = await import("@/server/keys/service")
    playground = await import("@/server/playground/service")
    route = await import("@/app/api/internal/playground/route")
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
    alice = await seedWorld("alice")
    bob = await seedWorld("bob")
  })

  afterAll(async () => {
    await stopTestDb()
  })

  /* ---------------------------------------------------------------- helpers */

  function cookieFor(userId: string): string {
    const token = session.signSession({
      uid: userId,
      role: "user",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    return `${cookieName}=${token}`
  }

  function postRequest(body: string, cookie?: string): Request {
    return new Request("http://localhost:3001/api/internal/playground", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body,
    })
  }

  /**
   * The recording stub. `answer` may return a value or THROW — the two arms §4.8's third rule
   * separates ("the engine threw" vs. "the engine answered something that is not an outcome").
   */
  function stubEngine(answer: (call: EngineCall) => unknown = () => VALID_ANSWER) {
    const calls: EngineCall[] = []
    return {
      calls,
      last: () => calls[calls.length - 1] as EngineCall,
      deps: {
        callEngine: async (call: EngineCall) => {
          calls.push(call)
          return answer(call)
        },
      },
    }
  }

  /**
   * Every byte of a call that could carry a secret, as one string. `URLSearchParams` hides its
   * pairs from `JSON.stringify`, so they are spelled out instead of trusted to survive a serialise.
   */
  function wireText(call: EngineCall): string {
    return [
      JSON.stringify(call.auth),
      call.method,
      JSON.stringify(call.pathSegments),
      call.searchParams.toString(),
      JSON.stringify(Object.fromEntries(call.searchParams.entries())),
      call.bodyText ?? "",
      String(call.ip),
    ].join("\n")
  }

  /** The engine's own 401 bytes for a `keyId` arm that matched no row (handle.ts's INVALID_KEY). */
  function invalidKeyBody(): string {
    return JSON.stringify({
      error: { code: "invalid_key", message: "That API key is not valid.", category: "auth" },
    })
  }

  /** Narrowing helper: an error envelope fails the test loudly instead of silently passing it. */
  function expectData(result: RunResult) {
    if (!result.ok) throw new Error(`expected ok:true, got ${result.error.code}`)
    return result.data
  }

  /**
   * The authoritative error test (`action-result.ts`'s own note: `ok` is a TYPE-only discriminant
   * and `fail()` never assigns it, so a failure envelope has no `ok` key at all).
   */
  function expectError(result: RunResult, label?: string) {
    if (!isActionError(result)) {
      throw new Error(`expected an error envelope${label ? ` for ${label}` : ""}, got a success`)
    }
    return result.error
  }

  /** One run against the stub, returning the answer plus the recorded calls. */
  async function runStubbed(
    input: unknown,
    answer?: (call: EngineCall) => unknown,
    userId: string = alice.user.id,
    ip: string | null = "203.0.113.9"
  ) {
    const engine = stubEngine(answer)
    const result = await playground.runPlaygroundRequest(input, userId, ip, { deps: engine.deps })
    return { result, engine }
  }

  const request = (path: string, extra: Record<string, unknown> = {}) => ({
    apiKeyId: alice.key.id,
    method: "GET",
    path,
    ...extra,
  })

  /* ---------------------------------------------------------------- 1. proxy rules */

  describe("proxy rules (engine stub)", () => {
    it("authenticates with {kind: keyId} + the SESSION owner and sends no key material", async () => {
      const { result, engine } = await runStubbed(request(alice.api.id))

      expect(result.ok).toBe(true)
      expect(engine.calls).toHaveLength(1)
      expect(engine.last().auth).toEqual({
        kind: "keyId",
        apiKeyId: alice.key.id,
        ownerId: alice.user.id,
      })
      expect(engine.last().ip).toBe("203.0.113.9")

      // The plaintext from the create-key response appears nowhere in what the proxy hands over.
      const text = wireText(engine.last())
      expect(text).not.toContain(alice.key.plaintext)
      expect(text).not.toContain("sz_live_")
      expect(JSON.stringify(result)).not.toContain(alice.key.plaintext)
    })

    it("forwards null (not a guess) when the proxy chain said nothing about the IP", async () => {
      const { engine } = await runStubbed(request(alice.api.id), undefined, alice.user.id, null)
      expect(engine.last().ip).toBeNull()
    })

    it("drops a client-supplied Authorization header instead of forwarding it", async () => {
      const injected = `Bearer ${alice.key.plaintext}`
      const { engine } = await runStubbed(
        request(alice.api.id, { headers: { Authorization: injected, "content-type": "application/json" } }),
        () => VALID_ANSWER
      )

      expect(engine.calls).toHaveLength(1)
      const call = engine.last()
      // Structural, not a filter: `EngineCall` has no header slot, so there is nothing to inject into.
      expect("headers" in call).toBe(false)
      const text = wireText(call)
      expect(text).not.toContain("Bearer")
      expect(text).not.toContain(alice.key.plaintext)
      expect(call.bodyText).toBeNull()
    })

    it("expands a string[] query value into repeated params and passes bodyJson as bodyText", async () => {
      const body = JSON.stringify({ name: "Ada" })
      const { engine } = await runStubbed(
        request(`${alice.api.id}/search`, {
          method: "POST",
          query: { limit: "5", tag: ["ada", "grace"], "weird key": "a b&c" },
          bodyJson: body,
        })
      )

      const call = engine.last()
      expect(call.method).toBe("POST")
      expect(call.pathSegments).toEqual([alice.api.id, "search"])
      expect(call.searchParams.getAll("tag")).toEqual(["ada", "grace"])
      expect(call.searchParams.get("limit")).toBe("5")
      expect(call.searchParams.get("weird key")).toBe("a b&c")
      expect(call.bodyText).toBe(body)
    })

    it("percent-decodes each path segment, drops empty ones and keeps an undecodable escape literal", async () => {
      const { engine } = await runStubbed(request(`${alice.api.id}/range/A1%3AD20//`))
      expect(engine.last().pathSegments).toEqual([alice.api.id, "range", "A1:D20"])

      const spaced = await runStubbed(request(`${alice.api.id}/Ada%20Lovelace`))
      expect(spaced.engine.last().pathSegments).toEqual([alice.api.id, "Ada Lovelace"])

      // A malformed escape must not crash the proxy and must not be dropped: it reaches the engine
      // verbatim, whose path grammar answers 404 — a real status, never a 500.
      const bad = await runStubbed(request(`${alice.api.id}/100%`), () => ({ status: 404, body: "{}", headers: {} }))
      expect(bad.engine.last().pathSegments).toEqual([alice.api.id, "100%"])
      expect(expectData(bad.result).status).toBe(404)
    })

    it("forwards an engine body that is already a string byte-for-byte", async () => {
      const text =
        '{"error":{"code":"api_not_found","message":"No API was found with that id.","category":"not_found"}}'
      const { result } = await runStubbed(request(randomUUID()), () => ({
        status: 404,
        body: text,
        headers: { "X-RateLimit-Remaining": "99" },
      }))

      const data = expectData(result)
      expect(data.body).toBe(text)
      expect(data.headers).toEqual({ "X-RateLimit-Remaining": "99" })
    })

    it("serialises an un-serialised engine envelope instead of re-formatting it", async () => {
      // The engine currently returns the envelope OBJECT while `EngineOutcome` publishes a string:
      // the adaptation lives in the service, so `src/server/engine/**` stays untouched.
      const envelope = {
        data: [{ id: "1", name: "Ada" }],
        meta: { api_id: "a", count: 1, limit: null, offset: 0, duration_ms: 7 },
      }
      const { result } = await runStubbed(request(alice.api.id), () => ({
        status: 200,
        body: envelope,
        headers: {},
        durationMs: 7,
      }))

      const data = expectData(result)
      expect(data.body).toBe(JSON.stringify(envelope))
      expect(JSON.parse(data.body)).toEqual(envelope)
    })

    it("carries every engine status verbatim inside data as an ok:true result", async () => {
      for (const status of [200, 401, 404, 409, 422, 429, 503]) {
        const body = JSON.stringify({
          error: { code: "engine_code", message: "engine message", category: "validation" },
        })
        const { result } = await runStubbed(request(alice.api.id), () => ({
          status,
          body,
          headers: { "content-type": "application/json; charset=utf-8", "Retry-After": "30" },
          durationMs: 12,
        }))

        // Rule 1: the playground call SUCCEEDED, so the envelope is `{ok: true}` whatever the engine said.
        expect(result.ok, String(status)).toBe(true)
        const data = expectData(result)
        expect(data.status, String(status)).toBe(status)
        expect(data.body).toBe(body)
        expect(data.durationMs).toBe(12)
        // §4.8: headers are the engine's minus `content-type`, which the route sets itself. Nothing added.
        expect(data.headers).toEqual({ "Retry-After": "30" })
      }
    })

    it("reports the engine's own duration, then meta.duration_ms, and only then the measured clock", async () => {
      const withField = expectData(
        (await runStubbed(request(alice.api.id), () => ({ status: 200, body: "{}", headers: {}, durationMs: 41 })))
          .result
      )
      expect(withField.durationMs).toBe(41)

      const withMeta = expectData(
        (
          await runStubbed(request(alice.api.id), () => ({
            status: 200,
            body: { data: [], meta: { api_id: "a", count: 0, limit: null, offset: 0, duration_ms: 23 } },
            headers: {},
          }))
        ).result
      )
      expect(withMeta.durationMs).toBe(23)

      // §4.8 names `meta.duration_ms` as the figure the log row carries, so the envelope wins even
      // when the answer also carries a top-level number — and it is found inside a serialised body.
      const withBoth = expectData(
        (
          await runStubbed(request(alice.api.id), () => ({
            status: 200,
            body: JSON.stringify({
              data: [],
              meta: { api_id: "a", count: 0, limit: null, offset: 0, duration_ms: 9 },
            }),
            headers: {},
            durationMs: 41,
          }))
        ).result
      )
      expect(withBoth.durationMs).toBe(9)

      // An error envelope carries no `meta`, so the measured clock is the only honest number left.
      const measured = expectData(
        (await runStubbed(request(alice.api.id), () => ({ status: 422, body: "{}", headers: {} }))).result
      )
      expect(measured.durationMs).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(measured.durationMs)).toBe(true)
    })

    it("turns an engine that THROWS into playground_unreachable, never a fabricated status", async () => {
      const { result, engine } = await runStubbed(request(alice.api.id), () => {
        throw new Error("socket hang up")
      })

      expect(result).toEqual({
        error: { code: "playground_unreachable", message: expect.any(String), category: "internal" },
      })
      expect(engine.calls).toHaveLength(1)
      // No `data`, therefore no invented status: `PlaygroundResponse` exists only if the engine answered.
      expect("data" in result).toBe(false)
      expect("status" in result).toBe(false)
      // And the cause is never echoed (§1.2).
      expect(JSON.stringify(result)).not.toContain("socket hang up")
    })

    it("treats an engine answer that is not an outcome as unreachable, not as a response", async () => {
      const notAnOutcome: [string, unknown][] = [
        ["undefined — the promise resolved to nothing", undefined],
        ["null", null],
        ["an empty object", {}],
        ["a bare status with no body", { status: 200 }],
        ["a body with no status", { body: "{}" }],
        ["a status outside the HTTP range", { status: 1999, body: "{}" }],
        ["a status that is a string", { status: "200", body: "{}" }],
        ["a body that cannot be serialised", { status: 200, body: undefined }],
        ["an array", []],
        ["a bare string", "not an outcome"],
      ]

      for (const [label, answer] of notAnOutcome) {
        const result = await playground.runPlaygroundRequest(
          request(alice.api.id),
          alice.user.id,
          null,
          { deps: stubEngine(() => answer).deps }
        )
        const unreachable = expectError(result, label)
        expect(unreachable.code, label).toBe("playground_unreachable")
        expect(unreachable.category, label).toBe("internal")
      }
    })

    it("refuses schema-invalid input with validation_failed and never calls the engine", async () => {
      const id = randomUUID()
      const invalidInput: [string, unknown][] = [
        ["a missing apiKeyId", { method: "GET", path: "abc" }],
        ["an apiKeyId that is not a uuid", { apiKeyId: "not-a-uuid", method: "GET", path: "abc" }],
        ["a numeric apiKeyId", { apiKeyId: 7, method: "GET", path: "abc" }],
        [
          "an apiKeyId carrying a plaintext key instead of a row id",
          { apiKeyId: "sz_live_0123456789abcdef0123456789abcdef", method: "GET", path: "abc" },
        ],
        ["a method the engine does not speak", { apiKeyId: id, method: "OPTIONS", path: "abc" }],
        ["a lowercase method", { apiKeyId: id, method: "get", path: "abc" }],
        ["a missing method", { apiKeyId: id, path: "abc" }],
        ["an empty path", { apiKeyId: id, method: "GET", path: "" }],
        ["a whitespace-only path", { apiKeyId: id, method: "GET", path: "   " }],
        ["a path over 512 characters", { apiKeyId: id, method: "GET", path: "a".repeat(513) }],
        [
          "a bodyJson over the 1 MB ceiling",
          { apiKeyId: id, method: "POST", path: "abc", bodyJson: "x".repeat(1_000_001) },
        ],
        ["a query value that is a number", { apiKeyId: id, method: "GET", path: "abc", query: { limit: 5 } }],
        ["headers whose value is not a string", { apiKeyId: id, method: "GET", path: "abc", headers: { "X-N": 1 } }],
        ["a non-object payload", "just a string"],
        ["an array payload", []],
        ["a null payload", null],
      ]

      for (const [label, input] of invalidInput) {
        const { result, engine } = await runStubbed(input, () => VALID_ANSWER)
        const failure = expectError(result, label)
        expect(failure.code, label).toBe("validation_failed")
        expect(failure.category, label).toBe("validation")
        expect(Object.keys(failure.fields ?? {}), label).not.toHaveLength(0)
        expect(engine.calls, label).toHaveLength(0)
      }
    })

    it("does not invent a path rule the engine owns: a slash-only path is forwarded and answered 404", async () => {
      // `"///"` satisfies the schema (1..512 chars) and yields NO segments, which is exactly what
      // `GET /api/v1` means to the engine — its own 404, verbatim (§4.8 rule 1). The proxy adds no
      // second path grammar of its own.
      const { result, engine } = await runStubbed({ apiKeyId: alice.key.id, method: "GET", path: "///" }, () => ({
        status: 404,
        body: '{"error":{"code":"api_not_found","message":"No API was found with that id.","category":"not_found"}}',
        headers: {},
      }))

      expect(engine.last().pathSegments).toEqual([])
      const data = expectData(result)
      expect(data.status).toBe(404)
      expect(JSON.parse(data.body).error.code).toBe("api_not_found")
    })

    it("refuses an oversized body before the engine sees a byte of it", async () => {
      const { result, engine } = await runStubbed(
        request(alice.api.id, { method: "POST", bodyJson: `{"blob":"${"y".repeat(1_000_001)}"}` }),
        () => VALID_ANSWER
      )

      expect(expectError(result).fields?.bodyJson).toBeDefined()
      expect(engine.calls).toHaveLength(0)
    })

    it("cannot be aimed at another user's key: the proxy supplies only the SESSION owner", async () => {
      // Two facts make a foreign `apiKeyId` unusable, and both are measured here:
      //   (a) the engine's arm matches (id, owner) in ONE statement — checked against the PRODUCTION
      //       lookup `findEngineKeyByIdAndOwner`, the query the engine's `keyId` arm runs;
      //   (b) the proxy fills `ownerId` from the session and nothing else, so a browser cannot name
      //       someone else's owner (the stub below asserts the arm it was handed).
      const own = await engineSupport.findEngineKeyByIdAndOwner(alice.key.id, alice.user.id)
      const foreign = await engineSupport.findEngineKeyByIdAndOwner(alice.key.id, bob.user.id)
      const missing = await engineSupport.findEngineKeyByIdAndOwner(randomUUID(), bob.user.id)

      expect(own?.id).toBe(alice.key.id)
      expect(foreign).toBeUndefined()
      expect(missing).toBeUndefined()

      const arm = (apiKeyId: string, ownerId: string) =>
        playground.runPlaygroundRequest({ apiKeyId, method: "GET", path: alice.api.id }, ownerId, null, {
          deps: {
            callEngine: async (call) => {
              const auth = call.auth as { kind: string; apiKeyId: string; ownerId: string }
              expect(auth.kind).toBe("keyId")
              expect(auth.ownerId).toBe(ownerId)
              const key = await engineSupport.findEngineKeyByIdAndOwner(auth.apiKeyId, auth.ownerId)
              if (key === undefined) return { status: 401, body: invalidKeyBody(), headers: {}, durationMs: 1 }
              return { status: 200, body: '{"data":[],"meta":{}}', headers: {}, durationMs: 1 }
            },
          },
        })

      const stolen = expectData(await arm(alice.key.id, bob.user.id))
      const unknown = expectData(await arm(randomUUID(), bob.user.id))

      expect(stolen.status).toBe(401)
      expect(stolen.body).toBe(unknown.body)
      expect(JSON.parse(stolen.body).error.code).toBe("invalid_key")
    })

    it("publishes exactly the §4.8 PlaygroundResponse keys", async () => {
      const { result } = await runStubbed(request(alice.api.id), () => ({
        status: 201,
        body: "{}",
        headers: { A: "b" },
        durationMs: 3,
        keyId: alice.key.plaintext,
      }))

      const data = expectData(result)
      expect(Object.keys(data).sort()).toEqual(["body", "durationMs", "headers", "status"])
      expect(JSON.stringify(result)).not.toContain(alice.key.plaintext)
    })
  })

  /* ---------------------------------------------------------------- 2. route rules */

  describe("route rules (engine never reached)", () => {
    it("405 with Allow: POST on every other verb", async () => {
      for (const verb of ["GET", "PUT", "PATCH", "DELETE"] as const) {
        const response = route[verb]()
        expect(response.status, verb).toBe(405)
        expect(response.headers.get("allow"), verb).toBe("POST")
        expect((await response.json()).error.code).toBe("method_not_allowed")
      }
    })

    it("401 with no cookie, before the body is read", async () => {
      const response = await route.POST(postRequest(JSON.stringify(request(alice.api.id))))
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual(UNAUTHENTICATED_BODY)
    })

    it("401 for a disabled account holding a previously valid cookie", async () => {
      await users.setUserStatus(alice.user.id, "disabled")
      const response = await route.POST(
        postRequest(JSON.stringify(request(alice.api.id)), cookieFor(alice.user.id))
      )
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual(UNAUTHENTICATED_BODY)
    })

    it("refuses a raw body over the byte ceiling before parsing it", async () => {
      const oversized = JSON.stringify({
        apiKeyId: alice.key.id,
        method: "POST",
        path: alice.api.id,
        // One byte past the ceiling on purpose, so the ROUTE refuses it, not the schema.
        bodyJson: `{"blob":"${"z".repeat(MAX_BODY_BYTES)}"}`,
      })
      expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_BODY_BYTES)

      const response = await route.POST(postRequest(oversized, cookieFor(alice.user.id)))
      expect(response.status).toBe(400)
      const payload = await response.json()
      expect(payload.error.code).toBe("validation_failed")
      // This message can only come from the route's ceiling — proof the text was refused before
      // `JSON.parse`, and therefore before the service and before any engine call.
      expect(payload.error.fields.body).toBe(`must be at most ${MAX_BODY_BYTES} bytes`)
    })

    it("400 on a body that is not JSON", async () => {
      const response = await route.POST(postRequest("{ not json", cookieFor(alice.user.id)))
      expect(response.status).toBe(400)
      expect((await response.json()).error.fields.body).toBe("must be JSON")
    })

    it("400 when the parsed body fails playgroundRequestSchema", async () => {
      const response = await route.POST(
        postRequest(
          JSON.stringify({ apiKeyId: alice.key.id, method: "FETCH", path: alice.api.id }),
          cookieFor(alice.user.id)
        )
      )
      expect(response.status).toBe(400)
      const payload = await response.json()
      expect(payload.error.code).toBe("validation_failed")
      expect(payload.error.fields.method).toBeDefined()
    })
  })

  /* ---------------------------------------------------------------- 3. the real engine */

  describe("in-process engine (§4.8 mechanism)", () => {
    let handle: typeof import("@/server/engine/handle")
    let fakeSheets: typeof import("./helpers/fake-sheets")["fakeSheets"]

    beforeAll(async () => {
      // Loaded only for this block, so the proxy's own tests never depend on the engine compiling.
      handle = await import("@/server/engine/handle")
      fakeSheets = (await import("./helpers/fake-sheets")).fakeSheets
    })

    /** The engine's Google seam (`EngineDeps.sheetsFor`): a stub client, so no socket opens. */
    function realEngine(values?: string[][]) {
      return {
        callEngine: (call: EngineCall) =>
          handle.handleEngineCall(call, {
            sheetsFor: async () => fakeSheets(values ? { values } : {}) as never,
          }),
      }
    }

    const GRID: string[][] = [["id", "name"], ["1", "Ada"], ["2", "Grace"]]

    it("lists the owner's records with status 200 and the engine's own meta", async () => {
      const data = expectData(
        await playground.runPlaygroundRequest(request(alice.api.id), alice.user.id, "198.51.100.7", {
          deps: realEngine(GRID),
        })
      )

      expect(data.status).toBe(200)
      const envelope = JSON.parse(data.body)
      expect(envelope.data).toEqual([
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ])
      expect(envelope.meta.count).toBe(2)
      expect(envelope.meta.api_id).toBe(alice.api.id)
      // §4.8: the playground reports the number the engine measured and the log row carries.
      expect(data.durationMs).toBe(envelope.meta.duration_ms)
      expect("content-type" in data.headers).toBe(false)
    })

    it("answers a foreign apiKeyId with the SAME 401 bytes as an unknown one (no oracle)", async () => {
      const stolen = await playground.runPlaygroundRequest(
        { apiKeyId: alice.key.id, method: "GET", path: alice.api.id },
        bob.user.id,
        null,
        { deps: realEngine(GRID) }
      )
      const unknown = await playground.runPlaygroundRequest(
        { apiKeyId: randomUUID(), method: "GET", path: alice.api.id },
        bob.user.id,
        null,
        { deps: realEngine(GRID) }
      )

      // Rule 1 at the playground layer: a 401 out of /api/v1 is a SUCCESSFUL playground call.
      expect(stolen.ok).toBe(true)
      expect(unknown.ok).toBe(true)
      expect(expectData(stolen).status).toBe(401)
      expect(expectData(unknown).status).toBe(401)
      expect(expectData(stolen).body).toBe(expectData(unknown).body)
      expect(JSON.parse(expectData(stolen).body).error.code).toBe("invalid_key")
    })

    it("answers a revoked key with the same 401 as a missing one", async () => {
      await keys.revokeKey(alice.key.id, alice.user.id)
      const data = expectData(
        await playground.runPlaygroundRequest(request(alice.api.id), alice.user.id, null, {
          deps: realEngine(GRID),
        })
      )
      expect(data.status).toBe(401)
      expect(JSON.parse(data.body).error.code).toBe("invalid_key")
    })

    it("forwards a 404 for an unknown api and a 403 for a write the API does not allow", async () => {
      const missing = expectData(
        await playground.runPlaygroundRequest(request(randomUUID()), alice.user.id, null, {
          deps: realEngine(GRID),
        })
      )
      expect(missing.status).toBe(404)
      expect(JSON.parse(missing.body).error.code).toBe("api_not_found")

      const write = expectData(
        await playground.runPlaygroundRequest(
          request(alice.api.id, { method: "POST", bodyJson: '[{"id":"3","name":"Hedy"}]' }),
          alice.user.id,
          null,
          { deps: realEngine(GRID) }
        )
      )
      // The seeded API is `permissions: read`, `allowedOperations: ["GET"]`: the engine's own 403.
      expect(write.status).toBe(403)
      expect(JSON.parse(write.body).error.code).toBe("operation_not_allowed")
    })

    it("forwards a 429 rate-limit verdict verbatim, Retry-After and all", async () => {
      const carol = await seedWorld("carol")
      const slowApi = await apis.createApi(
        {
          spreadsheetId: carol.sheet.id,
          name: "One per hour",
          tabTitle: TAB.title,
          headerRow: 1,
          primaryKeyColumn: "id",
          permissions: "read",
          allowedOperations: ["GET"],
          rateLimitPerHour: 1,
        },
        carol.user.id
      )
      if (!slowApi.ok) throw new Error(`seed api failed: ${slowApi.error.code}`)

      const first = expectData(
        await playground.runPlaygroundRequest(
          { apiKeyId: carol.key.id, method: "GET", path: slowApi.data.id },
          carol.user.id,
          null,
          { deps: realEngine(GRID) }
        )
      )
      expect(first.status).toBe(200)

      const second = expectData(
        await playground.runPlaygroundRequest(
          { apiKeyId: carol.key.id, method: "GET", path: slowApi.data.id },
          carol.user.id,
          null,
          { deps: realEngine(GRID) }
        )
      )
      expect(second.status).toBe(429)
      expect(JSON.parse(second.body).error.code).toBe("rate_limited")
      expect(Object.keys(second.headers).map((key) => key.toLowerCase())).toContain("retry-after")
    })

    it("logs the playground call like any real client, with no key material in the row", async () => {
      const data = expectData(
        await playground.runPlaygroundRequest(request(alice.api.id), alice.user.id, null, {
          deps: realEngine(GRID),
        })
      )
      expect(data.status).toBe(200)

      const rows = await test
        .select({
          statusCode: apiRequestLogs.statusCode,
          apiKeyId: apiRequestLogs.apiKeyId,
          path: apiRequestLogs.path,
          durationMs: apiRequestLogs.durationMs,
        })
        .from(apiRequestLogs)
        .where(eq(apiRequestLogs.apiKeyId, alice.key.id))

      expect(rows.length).toBeGreaterThanOrEqual(1)
      const logged = rows.find((row) => row.path === `/api/v1/${alice.api.id}`)
      expect(logged?.statusCode).toBe(200)
      // §4.8: the same measured duration the response reports.
      expect(logged?.durationMs).toBe(data.durationMs)
      expect(JSON.stringify(rows)).not.toContain(alice.key.plaintext)
    })

    it("returns HTTP 200 with the engine's 404 nested in {data} — nothing re-mapped to 5xx", async () => {
      const response = await route.POST(
        postRequest(JSON.stringify(request(randomUUID())), cookieFor(alice.user.id))
      )
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(Object.keys(payload)).toEqual(["data"])
      expect(payload.data.status).toBe(404)
      expect(JSON.parse(payload.data.body).error.code).toBe("api_not_found")
      expect(response.headers.get("content-type")).toContain("application/json")
    })

    it("lets a typed Authorization header be ignored, and never puts a key on the wire", async () => {
      // The path is an unknown api id on purpose: the engine refuses it BEFORE any Google call, so
      // this route test stays off the network while still proving the header is dropped end-to-end.
      const response = await route.POST(
        postRequest(
          JSON.stringify({
            apiKeyId: alice.key.id,
            method: "GET",
            path: randomUUID(),
            headers: { Authorization: `Bearer ${alice.key.plaintext}` },
          }),
          cookieFor(alice.user.id)
        )
      )
      const text = await response.text()
      expect(response.status).toBe(200)
      expect(text).not.toContain(alice.key.plaintext)
      expect(text).not.toContain("sz_live_")
      expect(JSON.parse(text).data.status).toBe(404)
    })
  })
})
