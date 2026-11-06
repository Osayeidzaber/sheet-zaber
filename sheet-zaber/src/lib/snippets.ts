/*
 * Shared code-snippet builders (docs/backend-api-contract.md §1.2 envelope, §3 docs contract).
 *
 * PURE functions — no network, no DB, no React, no `server-only` import (the
 * playground renders these inside client components, docs render them on the
 * server). One tested source of truth so the playground UI and the /docs pages
 * can never drift from the spec's behavior.
 *
 * Output is fully deterministic (no Date / random), so docs can golden-test it.
 *
 * Query strings use URLSearchParams semantics EXACTLY: spaces become "+",
 * array values repeat their key, other characters follow the
 * application/x-www-form-urlencoded serializer.
 */

export type SnippetMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

export type SnippetRequest = {
  /** e.g. https://sheet.zaber.tech/api/v1 */
  baseUrl: string
  method: SnippetMethod
  /** path segment after baseUrl (api_configurations.id) */
  apiId: string
  /** appends /{recordId}; mutually exclusive with routeSuffix */
  recordId?: string
  /** e.g. 'search' | 'range/A1:D20'; mutually exclusive with recordId */
  routeSuffix?: string
  query?: Record<string, string | string[]>
  /** extra headers; builders ADD the Authorization header themselves */
  headers?: Record<string, string>
  /** JSON body for POST/PATCH/PUT */
  body?: unknown
  /** literal key string inserted as the Bearer token */
  apiKey: string
}

const BODY_METHODS: readonly SnippetMethod[] = ["POST", "PATCH", "PUT"]
const NO_BODY_METHODS: readonly SnippetMethod[] = ["GET", "DELETE"]

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (!url.host) return false
    // origin + path only: query/fragment belong in `query`, never baked in
    if (url.search || url.hash) return false
    return true
  } catch {
    return false
  }
}

/**
 * Returns human-readable problems ([] when the request is valid).
 * Builders call this first and THROW on any problem, so the playground can
 * never emit a broken snippet.
 */
export function validateSnippetRequest(req: SnippetRequest): string[] {
  const problems: string[] = []

  if (!isValidBaseUrl(req.baseUrl)) {
    problems.push(
      `baseUrl must be an absolute http(s) origin+path URL (no query or fragment), got: "${req.baseUrl}"`
    )
  }

  if (req.recordId !== undefined && req.routeSuffix !== undefined) {
    problems.push("recordId and routeSuffix are mutually exclusive; choose one path segment")
  }

  if (req.body !== undefined && NO_BODY_METHODS.includes(req.method)) {
    problems.push(`a request body is not allowed for ${req.method} requests`)
  }

  if (req.body === undefined && BODY_METHODS.includes(req.method)) {
    problems.push(`${req.method} requests require a JSON body`)
  }

  return problems
}

function assertValid(req: SnippetRequest): void {
  const problems = validateSnippetRequest(req)
  if (problems.length > 0) {
    throw new Error(`Invalid snippet request:\n  - ${problems.join("\n  - ")}`)
  }
}

/* ------------------------------------------------------------------ */
/* URL + header resolution                                             */
/* ------------------------------------------------------------------ */

/** baseUrl + '/' + apiId [+ '/' + recordId | routeSuffix] [+ '?query'] */
function buildUrl(req: SnippetRequest): string {
  const base = req.baseUrl.replace(/\/+$/, "")
  let path = `${base}/${req.apiId}`
  if (req.recordId !== undefined) path = `${path}/${req.recordId}`
  else if (req.routeSuffix !== undefined) path = `${path}/${req.routeSuffix}`

  const qs = buildQueryString(req.query)
  return qs ? `${path}?${qs}` : path
}

function buildQueryString(query: Record<string, string | string[]> | undefined): string {
  if (!query) return ""
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item)
    } else {
      params.append(key, value)
    }
  }
  return params.toString()
}

/**
 * Deterministic, de-duplicated header order:
 *   Authorization (always first, added by the builder)
 *   → user extras (Authorization / our Content-Type overridden from extras)
 *   → Content-Type: application/json (only when a body is present)
 */
function resolveHeaders(req: SnippetRequest): Record<string, string> {
  const out: Record<string, string> = { Authorization: `Bearer ${req.apiKey}` }
  const hasBody = req.body !== undefined

  for (const [key, value] of Object.entries(req.headers ?? {})) {
    const lower = key.toLowerCase()
    if (lower === "authorization") continue
    if (lower === "content-type" && hasBody) continue
    out[key] = value
  }

  if (hasBody) out["Content-Type"] = "application/json"
  return out
}

/* ------------------------------------------------------------------ */
/* Shell / language helpers                                            */
/* ------------------------------------------------------------------ */

/** Wrap in single quotes; embed literal single quotes shell-safely as '\''. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Indent every line of `text` EXCEPT the first by `spaces`. */
function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces)
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : pad + line))
    .join("\n")
}

/** Render a JSON-serializable value as an indented Python literal. */
function pyLiteral(value: unknown, indent: number): string {
  const pad = " ".repeat(indent)
  const inner = " ".repeat(indent + 4)

  if (value === null) return "None"
  if (typeof value === "boolean") return value ? "True" : "False"
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value)

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const items = value.map((item) => `${inner}${pyLiteral(item, indent + 4)},\n`).join("")
    return `[\n${items}${pad}]`
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return "{}"
    const lines = entries
      .map(([key, val]) => `${inner}${JSON.stringify(key)}: ${pyLiteral(val, indent + 4)},\n`)
      .join("")
    return `{\n${lines}${pad}}`
  }

  // undefined / functions / symbols have no JSON representation.
  return "None"
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

export function buildCurl(req: SnippetRequest): string {
  assertValid(req)

  const parts: string[] = [`curl ${shellSingleQuote(buildUrl(req))}`]
  if (req.method !== "GET") parts.push(`--request ${req.method}`)
  for (const [key, value] of Object.entries(resolveHeaders(req))) {
    parts.push(`-H "${key}: ${value}"`)
  }
  if (req.body !== undefined) parts.push(`--data-raw ${shellSingleQuote(JSON.stringify(req.body))}`)

  return parts
    .map((part, i) => {
      const pad = i === 0 ? "" : "  "
      const cont = i === parts.length - 1 ? "" : " \\"
      return `${pad}${part}${cont}`
    })
    .join("\n")
}

export function buildJavaScript(req: SnippetRequest): string {
  assertValid(req)

  const headerLines = Object.entries(resolveHeaders(req))
    .map(([key, value]) => `      ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(",\n")

  const options: string[] = [
    `    method: ${JSON.stringify(req.method)}`,
    `    headers: {\n${headerLines}\n    }`,
  ]
  if (req.body !== undefined) {
    const literal = indentBlock(JSON.stringify(req.body, null, 2), 4)
    options.push(`    body: JSON.stringify(${literal})`)
  }

  return [
    "async function main() {",
    `  const res = await fetch(${JSON.stringify(buildUrl(req))}, {`,
    options.join(",\n"),
    "  });",
    "",
    "  const data = await res.json();",
    "  console.log(JSON.stringify(data, null, 2));",
    "}",
    "",
    "main();",
  ].join("\n")
}

export function buildPython(req: SnippetRequest): string {
  assertValid(req)

  const lines: string[] = ["import requests", "", `url = ${JSON.stringify(buildUrl(req))}`]
  lines.push(`headers = ${pyLiteral(resolveHeaders(req), 0)}`)
  if (req.body !== undefined) {
    lines.push(`payload = ${pyLiteral(req.body, 0)}`)
  }
  const jsonArg = req.body !== undefined ? ", json=payload" : ""
  lines.push(
    "",
    `resp = requests.${req.method.toLowerCase()}(url, headers=headers${jsonArg})`,
    "print(resp.json())"
  )

  return lines.join("\n")
}
