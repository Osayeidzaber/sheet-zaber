import { beforeEach, describe, expect, it, vi } from "vitest"

// Tests header parsing and response forwarding with a mocked engine.
// Does not exercise engine authentication, Next path decoding, or live reads.

const API_ID = "5b1f4a56-6d0b-4f6e-9f2a-3a7c8e1d0a11"
/** §1.1's shape exactly: `sz_live_` + 32 lowercase hex. */
const LIVE_KEY = "sz_live_0f1e2d3c4b5a6978f0e1d2c3b4a59687"

type Outcome = { status: number; body: string; headers: Record<string, string> }

const harness = vi.hoisted(() => {
  const state = {
    calls: [] as unknown[],
    deps: [] as unknown[],
    outcome: { status: 200, body: "{}", headers: {} } as Outcome,
  }
  return {
    state,
    reset: () => {
      state.calls = []
      state.deps = []
      state.outcome = { status: 200, body: "{}", headers: {} }
    },
    setOutcome: (next: { status: number; body: string; headers?: Record<string, string> }) => {
      state.outcome = { status: next.status, body: next.body, headers: next.headers ?? {} }
    },
  }
})

vi.mock("@/server/engine", () => ({
  handleEngineCall: vi.fn(async (call: unknown, deps?: unknown) => {
    harness.state.calls.push(call)
    harness.state.deps.push(deps)
    return harness.state.outcome
  }),
}))

const routes = await import("@/app/api/v1/[...path]/route")

type CapturedCall = {
  auth: { kind: string; token: string }
  method: string
  pathSegments: string[]
  searchParams: URLSearchParams
  bodyText: string | null
  ip: string | null
}

/** The segments a real Next request hands this handler for that URL, split off `/api/v1`. */
function segmentsOf(url: string): string[] {
  return new URL(url).pathname
    .replace(/^\/api\/v1\/?/, "")
    .split("/")
    .filter((segment) => segment !== "")
}

/** Next 16 hands `params` as a Promise. */
function context(path: string[]) {
  return { params: Promise.resolve({ path }) }
}

function urlFor(...parts: string[]): string {
  return `http://localhost:3001/api/v1/${parts.join("/")}`
}

/** The most recent `EngineCall` the route handed the engine, so a case may send more than once. */
function lastCall(): CapturedCall {
  expect(harness.state.calls.length).toBeGreaterThan(0)
  return harness.state.calls[harness.state.calls.length - 1] as CapturedCall
}

async function send(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  init?: { headers?: Record<string, string>; body?: string }
): Promise<Response> {
  const request = new Request(url, {
    method,
    headers: init?.headers,
    // The fetch spec forbids a body on GET; the route's own guard is covered separately below.
    body: method === "GET" ? undefined : init?.body,
  })
  return routes[method](request, context(segmentsOf(url)))
}

beforeEach(() => {
  harness.reset()
})

describe("the Bearer translation (§1.1)", () => {
  it("hands the engine the credential, not the header", async () => {
    await send("GET", urlFor(API_ID), { headers: { authorization: `Bearer ${LIVE_KEY}` } })

    const call = lastCall()
    expect(call.auth.kind).toBe("bearer")
    expect(call.auth.token).toBe(LIVE_KEY)
  })

  it.each([
    { name: "lowercase scheme and extra spaces", header: `bearer   ${LIVE_KEY}` },
    { name: "mixed-case scheme", header: `BeArEr ${LIVE_KEY}` },
    { name: "tabs and surrounding spaces", header: `  BeArEr \t  ${LIVE_KEY}  ` },
  ])("extracts the credential with $name", async ({ header }) => {
    await send("GET", urlFor(API_ID), { headers: { authorization: header } })
    expect(lastCall().auth.token).toBe(LIVE_KEY)
  })

  it("sends an empty credential when there is no header, so the engine answers missing_key", async () => {
    await send("GET", urlFor(API_ID))
    expect(lastCall().auth.token).toBe("")

    await send("GET", urlFor(API_ID), { headers: { authorization: "   " } })
    expect(lastCall().auth.token).toBe("")
  })

  it.each([
    { name: "bare credential", header: LIVE_KEY },
    { name: "Basic scheme", header: `Basic ${LIVE_KEY}` },
    { name: "scheme without a separator", header: `Bearer${LIVE_KEY}` },
    { name: "empty Bearer scheme", header: "Bearer" },
    { name: "empty Bearer scheme with spaces", header: "Bearer   " },
    { name: "empty Bearer scheme with a tab", header: "BeArEr\t" },
  ])("maps $name to an invalid, nonempty token", async ({ header }) => {
    await send("GET", urlFor(API_ID), { headers: { authorization: header } })

    const { auth } = lastCall()
    expect(auth.kind).toBe("bearer")
    expect(auth.token).toBe("invalid_authorization")
    expect(auth.token.trim()).not.toBe("")
    expect(auth.token).not.toMatch(/^sz_live_[0-9a-f]{32}$/)
  })

  it.each([
    { name: "space-separated credentials", header: `Bearer ${LIVE_KEY} ${LIVE_KEY}` },
    { name: "comma-separated credentials", header: `Bearer ${LIVE_KEY},${LIVE_KEY}` },
    { name: "combined Bearer headers", header: `Bearer ${LIVE_KEY}, Bearer ${LIVE_KEY}` },
    { name: "combined authentication schemes", header: `Bearer ${LIVE_KEY}, Basic Zm9v` },
  ])("never selects a valid key from $name", async ({ header }) => {
    await send("GET", urlFor(API_ID), { headers: { authorization: header } })

    const { token } = lastCall().auth
    expect(token.trim()).not.toBe("")
    expect(token).not.toBe(LIVE_KEY)
    expect(token).not.toMatch(/^sz_live_[0-9a-f]{32}$/)
  })

  it("never reads a credential out of the query string (§1.1 forbids ?key=)", async () => {
    await send("GET", `${urlFor(API_ID)}?key=${LIVE_KEY}`)

    const call = lastCall()
    expect(call.auth.token).toBe("")
    expect(call.searchParams.get("key")).toBe(LIVE_KEY)
  })
})

describe("the EngineCall the route builds", () => {
  it("splits the catch-all after /api/v1 and records the verb", async () => {
    await send("GET", urlFor(API_ID, "search"))
    expect(lastCall().pathSegments).toEqual([API_ID, "search"])
    expect(lastCall().method).toBe("GET")

    await send("PATCH", urlFor(API_ID, "42"), { body: "{}" })
    expect(lastCall().pathSegments).toEqual([API_ID, "42"])
    expect(lastCall().method).toBe("PATCH")

    await send("GET", urlFor(API_ID, "range", "A1:D4"))
    expect(lastCall().pathSegments).toEqual([API_ID, "range", "A1:D4"])
  })

  it("answers the root path with no segments, so the engine can say api_not_found", async () => {
    await send("GET", "http://localhost:3001/api/v1")
    expect(lastCall().pathSegments).toEqual([])

    // `//` carries no information and must not become an empty segment.
    await send("GET", "http://localhost:3001/api/v1//")
    expect(lastCall().pathSegments).toEqual([])
  })

  it("forwards the query verbatim, without decoding a second time", async () => {
    await send("GET", `${urlFor(API_ID)}?limit=2&name__contains=Ada%20L`)

    const params = lastCall().searchParams
    expect(params.get("limit")).toBe("2")
    // URLSearchParams already yields the decoded value; re-decoding would corrupt a literal `%`.
    expect(params.get("name__contains")).toBe("Ada L")
  })

  it("reads no body for GET, and the raw text for every write verb", async () => {
    // A GET cannot carry a body through `Request`, so a hand-built request proves the short-circuit:
    // the route must not even ask for the text.
    let read = false
    const fakeGet = {
      url: urlFor(API_ID),
      headers: new Headers({ authorization: `Bearer ${LIVE_KEY}` }),
      text: async () => {
        read = true
        return JSON.stringify({ name: "Ada" })
      },
    } as unknown as Request

    await routes.GET(fakeGet, context([API_ID]))
    expect(lastCall().bodyText).toBe(null)
    expect(read).toBe(false)

    const body = JSON.stringify({ name: "Ada" })
    await send("POST", urlFor(API_ID), { body })
    expect(lastCall().bodyText).toBe(body)
  })

  it("turns a bodyless write into `null`, so the engine sees no body rather than an empty one", async () => {
    await send("POST", urlFor(API_ID))
    expect(lastCall().bodyText).toBe(null)
  })

  it("passes an oversized body through un-clipped so the engine can answer 413, not 400", async () => {
    // §1.2 measures the RAW text; clipping here would turn `body_too_large` into `invalid_json`.
    const huge = "x".repeat(1_000_001)

    await send("POST", urlFor(API_ID), { body: huge })
    expect(lastCall().bodyText).toBe(huge)
    expect(lastCall().bodyText).toHaveLength(1_000_001)
  })

  it("reads the rate-limit bucket dimension from the forwarded headers", async () => {
    await send("GET", urlFor(API_ID), { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } })
    expect(lastCall().ip).toBe("203.0.113.7")

    await send("GET", urlFor(API_ID), { headers: { "x-real-ip": "198.51.100.9" } })
    expect(lastCall().ip).toBe("198.51.100.9")

    // Stripped headers share one bucket rather than skipping the IP window.
    await send("GET", urlFor(API_ID))
    expect(lastCall().ip).toBe("unknown-client")
  })

  it("calls the engine with no injected seam, so the real Google client is the only one", async () => {
    // The fake `sheetsFor` seam exists for tests; a production route must never reach it.
    await send("GET", urlFor(API_ID))
    expect(harness.state.deps).toEqual([undefined])
  })

  it("opts out of static rendering", () => {
    expect(routes.dynamic).toBe("force-dynamic")
  })
})

describe("EngineOutcome → Response", () => {
  it("carries the engine's status, headers and already-serialised body verbatim", async () => {
    const envelope = JSON.stringify({
      error: { code: "rate_limited", message: "Too many requests.", category: "rate_limit" },
    })
    harness.setOutcome({
      status: 429,
      body: envelope,
      headers: { "content-type": "application/json; charset=utf-8", "Retry-After": "37" },
    })

    const response = await send("GET", urlFor(API_ID))

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("37")
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await response.text()).toBe(envelope)
  })

  it("answers 405 with the Allow list the engine serves, and spends no engine call", async () => {
    for (const handler of [routes.HEAD, routes.OPTIONS]) {
      const response = await handler()

      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("GET, POST, PATCH, PUT, DELETE")
      expect(await response.json()).toEqual({
        error: { code: "method_not_allowed", message: "Method not allowed.", category: "validation" },
      })
    }
    expect(harness.state.calls).toHaveLength(0)
  })
})
