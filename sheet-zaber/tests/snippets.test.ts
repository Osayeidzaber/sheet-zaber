import { describe, expect, it } from "vitest"

import {
  buildCurl,
  buildJavaScript,
  buildPython,
  validateSnippetRequest,
  type SnippetRequest,
} from "@/lib/snippets"

/*
 * Golden-string tests for the shared snippet builders.
 *
 * Every expected string below was constructed BY HAND from the format rules
 * in the Task 5.4 brief (curl line-continuations, JS async-fetch indentation,
 * Python `requests` idiom). No expected value is produced by re-running the
 * builder — otherwise the test would only prove the builder equals itself.
 *
 * Query strings follow URLSearchParams semantics exactly (space -> "+",
 * array values repeat their key), confirmed against Node 22.
 */

const BASE = "https://sheet.zaber.tech/api/v1"
const KEY = "sz_live_example"

function req(overrides: Partial<SnippetRequest> & Pick<SnippetRequest, "method">): SnippetRequest {
  return { baseUrl: BASE, apiId: "leads", apiKey: KEY, ...overrides }
}

describe("buildCurl", () => {
  it("renders a plain GET list request", () => {
    const out = buildCurl(req({ method: "GET" }))
    expect(out).toBe(
      `curl 'https://sheet.zaber.tech/api/v1/leads' \\
  -H "Authorization: Bearer sz_live_example"`
    )
  })

  it("percent-encodes filters with repeated keys, __contains and URL-encoded spaces", () => {
    const out = buildCurl(
      req({
        method: "GET",
        query: {
          city: "Bologna",
          name__contains: "ra in",
          sort: ["created", "-name"],
        },
      })
    )
    expect(out).toBe(
      `curl 'https://sheet.zaber.tech/api/v1/leads?city=Bologna&name__contains=ra+in&sort=created&sort=-name' \\
  -H "Authorization: Bearer sz_live_example"`
    )
  })

  it("renders a single-record GET", () => {
    const out = buildCurl(req({ method: "GET", recordId: "42" }))
    expect(out).toBe(
      `curl 'https://sheet.zaber.tech/api/v1/leads/42' \\
  -H "Authorization: Bearer sz_live_example"`
    )
  })

  it("renders a search-suffix GET", () => {
    const out = buildCurl(req({ method: "GET", routeSuffix: "search", query: { q: "widget" } }))
    expect(out).toBe(
      `curl 'https://sheet.zaber.tech/api/v1/leads/search?q=widget' \\
  -H "Authorization: Bearer sz_live_example"`
    )
  })

  it("renders a range-suffix GET", () => {
    const out = buildCurl(req({ method: "GET", routeSuffix: "range/A1:D20", query: { limit: "50" } }))
    expect(out).toBe(
      `curl 'https://sheet.zaber.tech/api/v1/leads/range/A1:D20?limit=50' \\
  -H "Authorization: Bearer sz_live_example"`
    )
  })

  it("renders a POST with a nested JSON body (--data-raw, --request, Content-Type)", () => {
    const out = buildCurl(req({ method: "POST", body: { name: "Ada", meta: { tier: "gold" } } }))
    expect(out).toBe(
      `curl 'https://sheet.zaber.tech/api/v1/leads' \\
  --request POST \\
  -H "Authorization: Bearer sz_live_example" \\
  -H "Content-Type: application/json" \\
  --data-raw '{"name":"Ada","meta":{"tier":"gold"}}'`
    )
  })

  it("renders a PATCH of a single record", () => {
    const out = buildCurl(req({ method: "PATCH", recordId: "42", body: { status: "done" } }))
    expect(out).toBe(
      `curl 'https://sheet.zaber.tech/api/v1/leads/42' \\
  --request PATCH \\
  -H "Authorization: Bearer sz_live_example" \\
  -H "Content-Type: application/json" \\
  --data-raw '{"status":"done"}'`
    )
  })

  it("renders a DELETE (no body, --request present)", () => {
    const out = buildCurl(req({ method: "DELETE", recordId: "42" }))
    expect(out).toBe(
      `curl 'https://sheet.zaber.tech/api/v1/leads/42' \\
  --request DELETE \\
  -H "Authorization: Bearer sz_live_example"`
    )
  })

  it("shell-escapes an embedded single quote in a body value", () => {
    const out = buildCurl(req({ method: "POST", body: { command: "'; rm -rf /" } }))
    expect(out).toBe(
      `curl 'https://sheet.zaber.tech/api/v1/leads' \\
  --request POST \\
  -H "Authorization: Bearer sz_live_example" \\
  -H "Content-Type: application/json" \\
  --data-raw '{"command":"'\\''; rm -rf /"}'`
    )
  })

  it("adds extra headers with Authorization first and Content-Type last", () => {
    const out = buildCurl(req({ method: "GET", headers: { "X-Source": "docs" } }))
    expect(out).toBe(
      `curl 'https://sheet.zaber.tech/api/v1/leads' \\
  -H "Authorization: Bearer sz_live_example" \\
  -H "X-Source: docs"`
    )
  })
})

describe("buildJavaScript", () => {
  it("renders a plain GET list request", () => {
    const out = buildJavaScript(req({ method: "GET" }))
    expect(out).toBe(
      `async function main() {
  const res = await fetch("https://sheet.zaber.tech/api/v1/leads", {
    method: "GET",
    headers: {
      "Authorization": "Bearer sz_live_example"
    }
  });

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main();`
    )
  })

  it("renders an encoded filter query", () => {
    const out = buildJavaScript(
      req({ method: "GET", query: { city: "Bologna", sort: ["created", "-name"] } })
    )
    expect(out).toBe(
      `async function main() {
  const res = await fetch("https://sheet.zaber.tech/api/v1/leads?city=Bologna&sort=created&sort=-name", {
    method: "GET",
    headers: {
      "Authorization": "Bearer sz_live_example"
    }
  });

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main();`
    )
  })

  it("renders a POST with a nested JSON body as an inlined 2-space object literal", () => {
    const out = buildJavaScript(req({ method: "POST", body: { name: "Ada", meta: { tier: "gold" } } }))
    expect(out).toBe(
      `async function main() {
  const res = await fetch("https://sheet.zaber.tech/api/v1/leads", {
    method: "POST",
    headers: {
      "Authorization": "Bearer sz_live_example",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "name": "Ada",
      "meta": {
        "tier": "gold"
      }
    })
  });

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main();`
    )
  })

  it("renders a PATCH of a single record", () => {
    const out = buildJavaScript(req({ method: "PATCH", recordId: "42", body: { status: "done" } }))
    expect(out).toBe(
      `async function main() {
  const res = await fetch("https://sheet.zaber.tech/api/v1/leads/42", {
    method: "PATCH",
    headers: {
      "Authorization": "Bearer sz_live_example",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "status": "done"
    })
  });

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main();`
    )
  })

  it("renders a DELETE", () => {
    const out = buildJavaScript(req({ method: "DELETE", recordId: "42" }))
    expect(out).toBe(
      `async function main() {
  const res = await fetch("https://sheet.zaber.tech/api/v1/leads/42", {
    method: "DELETE",
    headers: {
      "Authorization": "Bearer sz_live_example"
    }
  });

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main();`
    )
  })
})

describe("buildPython", () => {
  it("renders a plain GET list request", () => {
    const out = buildPython(req({ method: "GET" }))
    expect(out).toBe(
      `import requests

url = "https://sheet.zaber.tech/api/v1/leads"
headers = {
    "Authorization": "Bearer sz_live_example",
}

resp = requests.get(url, headers=headers)
print(resp.json())`
    )
  })

  it("renders an encoded filter query", () => {
    const out = buildPython(
      req({ method: "GET", query: { city: "Bologna", name__contains: "ra in" } })
    )
    expect(out).toBe(
      `import requests

url = "https://sheet.zaber.tech/api/v1/leads?city=Bologna&name__contains=ra+in"
headers = {
    "Authorization": "Bearer sz_live_example",
}

resp = requests.get(url, headers=headers)
print(resp.json())`
    )
  })

  it("renders a POST with a nested JSON body (json=payload)", () => {
    const out = buildPython(req({ method: "POST", body: { name: "Ada", meta: { tier: "gold" } } }))
    expect(out).toBe(
      `import requests

url = "https://sheet.zaber.tech/api/v1/leads"
headers = {
    "Authorization": "Bearer sz_live_example",
    "Content-Type": "application/json",
}
payload = {
    "name": "Ada",
    "meta": {
        "tier": "gold",
    },
}

resp = requests.post(url, headers=headers, json=payload)
print(resp.json())`
    )
  })

  it("renders a PATCH of a single record", () => {
    const out = buildPython(req({ method: "PATCH", recordId: "42", body: { status: "done" } }))
    expect(out).toBe(
      `import requests

url = "https://sheet.zaber.tech/api/v1/leads/42"
headers = {
    "Authorization": "Bearer sz_live_example",
    "Content-Type": "application/json",
}
payload = {
    "status": "done",
}

resp = requests.patch(url, headers=headers, json=payload)
print(resp.json())`
    )
  })

  it("renders a DELETE with no json kwarg", () => {
    const out = buildPython(req({ method: "DELETE", recordId: "42" }))
    expect(out).toBe(
      `import requests

url = "https://sheet.zaber.tech/api/v1/leads/42"
headers = {
    "Authorization": "Bearer sz_live_example",
}

resp = requests.delete(url, headers=headers)
print(resp.json())`
    )
  })
})

describe("validateSnippetRequest", () => {
  it("returns [] for valid requests", () => {
    expect(validateSnippetRequest(req({ method: "GET" }))).toEqual([])
    expect(validateSnippetRequest(req({ method: "POST", body: { a: 1 } }))).toEqual([])
    expect(validateSnippetRequest(req({ method: "DELETE", recordId: "42" }))).toEqual([])
    expect(validateSnippetRequest(req({ method: "GET", routeSuffix: "search" }))).toEqual([])
  })

  it("reports the recordId + routeSuffix conflict", () => {
    const problems = validateSnippetRequest(
      req({ method: "GET", recordId: "42", routeSuffix: "search" })
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/recordId.*routeSuffix|routeSuffix.*recordId/i)
  })

  it("reports a body on GET", () => {
    const problems = validateSnippetRequest(req({ method: "GET", body: { a: 1 } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/body/i)
    expect(problems[0]).toContain("GET")
  })

  it("reports a body on DELETE", () => {
    const problems = validateSnippetRequest(req({ method: "DELETE", recordId: "42", body: { a: 1 } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/body/i)
    expect(problems[0]).toContain("DELETE")
  })

  it("reports a missing body on POST / PATCH / PUT", () => {
    for (const method of ["POST", "PATCH", "PUT"] as const) {
      const problems = validateSnippetRequest(req({ method, recordId: "42" }))
      expect(problems).toHaveLength(1)
      expect(problems[0]).toMatch(/body/i)
      expect(problems[0]).toContain(method)
    }
  })

  it("reports an invalid baseUrl (scheme, unparseable, or embedded query)", () => {
    expect(validateSnippetRequest(req({ method: "GET", baseUrl: "ftp://sheet.zaber.tech/api" }))[0]).toMatch(/baseUrl/i)
    expect(validateSnippetRequest(req({ method: "GET", baseUrl: "not a url" }))[0]).toMatch(/baseUrl/i)
    expect(validateSnippetRequest(req({ method: "GET", baseUrl: "https://x.test/api?debug=1" }))[0]).toMatch(/baseUrl/i)
  })

  it("accumulates several problems at once", () => {
    const problems = validateSnippetRequest(
      req({ method: "GET", baseUrl: "nope", recordId: "1", routeSuffix: "search", body: { a: 1 } })
    )
    expect(problems).toHaveLength(3)
  })
})

describe("builders reject invalid requests", () => {
  it("throws on recordId + routeSuffix conflict", () => {
    const bad = req({ method: "GET", recordId: "42", routeSuffix: "search" })
    expect(() => buildCurl(bad)).toThrow(/recordId/i)
    expect(() => buildJavaScript(bad)).toThrow(/recordId/i)
    expect(() => buildPython(bad)).toThrow(/recordId/i)
  })

  it("throws on a GET request that carries a body", () => {
    const bad = req({ method: "GET", body: { a: 1 } })
    expect(() => buildCurl(bad)).toThrow(/body/i)
    expect(() => buildPython(bad)).toThrow(/body/i)
  })

  it("throws on a POST request missing its body", () => {
    const bad = req({ method: "POST" })
    expect(() => buildCurl(bad)).toThrow(/body/i)
    expect(() => buildJavaScript(bad)).toThrow(/body/i)
  })

  it("throws on an invalid baseUrl", () => {
    const bad = req({ method: "GET", baseUrl: "ht!tp://oops" })
    expect(() => buildCurl(bad)).toThrow(/baseUrl/i)
    expect(() => buildJavaScript(bad)).toThrow(/baseUrl/i)
    expect(() => buildPython(bad)).toThrow(/baseUrl/i)
  })
})
