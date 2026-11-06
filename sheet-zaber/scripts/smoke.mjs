/*
 * `pnpm smoke`, after `pnpm build` and with `pnpm db:local` running: exercises the production server
 * over real HTTP on a throwaway database, using the deploy scripts themselves. It refuses any non-local
 * database and never calls Google (the seeded refresh token cannot decrypt, so no token request is made).
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"

import pg from "pg"

process.loadEnvFile(".env.local")
const ADMIN_URL = "postgresql://postgres:postgres@localhost:5433/postgres"
const DB_URL = "postgresql://postgres:postgres@localhost:5433/sheet_zaber_smoke"
const PORT = 3105
const BASE = `http://localhost:${PORT}`
const env = { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "production", CLIENT_IP_HEADER: "" }

let failures = 0
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`)
  if (!ok) failures += 1
}

const admin = new pg.Client(ADMIN_URL)
await admin.connect()
await admin.query("drop database if exists sheet_zaber_smoke")
await admin.query("create database sheet_zaber_smoke")
await admin.end()

const run = (script) => spawnSync("pnpm", [script], { env, shell: true, encoding: "utf8" })
const migrated = run("db:deploy")
check("db:deploy applies every migration", migrated.status === 0, migrated.stderr)

const db = new pg.Client(DB_URL)
await db.connect()

const key = () => {
  const plaintext = `sz_live_${randomBytes(16).toString("hex")}`
  return { plaintext, hash: createHash("sha256").update(plaintext).digest("hex") }
}
async function seedAccount(role, email) {
  const id = randomUUID()
  const connectionId = randomUUID()
  const sheetId = randomUUID()
  const apiId = randomUUID()
  const apiKey = key()
  await db.query("insert into users (id, google_sub, email, role) values ($1,$2,$3,$4)", [id, `sub-${id}`, email, role])
  await db.query(
    "insert into google_connections (id, user_id, google_email, refresh_token_enc, scope) values ($1,$2,$3,'bm90LXJlYWwtY2lwaGVydGV4dA==','openid')",
    [connectionId, id, email]
  )
  await db.query(
    `insert into registered_spreadsheets (id, user_id, connection_id, google_sheet_id, title, tabs) values ($1,$2,$3,$4,'Roster','[]')`,
    [sheetId, id, connectionId, `sheet-${sheetId}`]
  )
  await db.query(
    `insert into api_configurations (id, user_id, spreadsheet_id, name, tab_title, allowed_operations) values ($1,$2,$3,'Smoke API','Sheet1','["GET"]')`,
    [apiId, id, sheetId]
  )
  await db.query(
    `insert into api_keys (id, user_id, name, key_hash, key_preview, scopes) values ($1,$2,'smoke',$3,'sz_live_x','["read"]')`,
    [randomUUID(), id, apiKey.hash]
  )
  const segment = Buffer.from(JSON.stringify({ uid: id, role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  const signature = createHmac("sha256", process.env.SESSION_SECRET).update(segment).digest("base64url")
  return { id, apiId, connectionId, token: apiKey.plaintext, cookie: `__Host-sz_session=${segment}.${signature}` }
}
const owner = await seedAccount("owner", "smoke-owner@example.com")
const member = await seedAccount("user", "smoke-member@example.com")

const server = spawn("pnpm", ["start", "-p", String(PORT)], { env, shell: true, stdio: "ignore" })
try {
  for (let i = 0; i < 60; i += 1) {
    const up = await fetch(`${BASE}/api/health`).catch(() => null)
    if (up?.ok) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const call = async (path, init = {}) => {
    const res = await fetch(BASE + path, { redirect: "manual", ...init })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* a page, not JSON */ }
    return { status: res.status, headers: res.headers, text, code: body?.error?.code, body }
  }
  const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } })
  const session = (who, extra = {}) => ({ headers: { cookie: who.cookie, ...extra } })

  const health = await call("/api/health")
  check("health answers 200", health.status === 200)
  check("security headers are sent", Boolean(health.headers.get("content-security-policy") && health.headers.get("strict-transport-security")))

  check("public API: no key is 401 missing_key", (await call(`/api/v1/${member.apiId}`)).code === "missing_key")
  check("public API: bad key is 401 invalid_key", (await call(`/api/v1/${member.apiId}`, bearer("sz_live_nope"))).code === "invalid_key")
  check("public API: unknown API is 404", (await call(`/api/v1/${randomUUID()}`, bearer(member.token))).status === 404)
  const foreign = await call(`/api/v1/${owner.apiId}`, bearer(member.token))
  check("public API: another user's API reads as 404", foreign.status === 404 && foreign.code === "api_not_found")
  check("public API: a write on a read-only API is 403", (await call(`/api/v1/${member.apiId}`, { method: "POST", ...bearer(member.token), body: "{}" })).status === 403)

  const dead = await call(`/api/v1/${member.apiId}`, bearer(member.token))
  check("public API: a dead Google grant is 503 google_reauth_required", dead.status === 503 && dead.code === "google_reauth_required", `${dead.status} ${dead.code}`)
  const { rows: [connection] } = await db.query("select status from google_connections where id = $1", [member.connectionId])
  check("the dead grant raises reauth_required", connection.status === "reauth_required", connection.status)
  check("public API: then 503 google_not_connected", (await call(`/api/v1/${member.apiId}`, bearer(member.token))).code === "google_not_connected")

  await db.query("update users set api_limit_per_day = 1 where id = $1", [member.id])
  await db.query("delete from rate_limit_buckets")
  await call(`/api/v1/${member.apiId}`, bearer(member.token))
  const limited = await call(`/api/v1/${member.apiId}`, bearer(member.token))
  check("public API: the daily quota is 429 with Retry-After", limited.status === 429 && Boolean(limited.headers.get("retry-after")), String(limited.status))

  const ownerCalls = await Promise.all([1, 2, 3].map(() => call(`/api/v1/${owner.apiId}`, bearer(owner.token))))
  check("public API: the owner gets no rate headers", ownerCalls.every((r) => r.status !== 429 && !r.headers.get("x-ratelimit-limit")))

  check("internal: no session is 401", (await call("/api/internal/keys")).status === 401)
  const keys = await call("/api/internal/keys", session(member))
  check("internal: own keys are listed without secrets", keys.status === 200 && !/key_?hash/i.test(keys.text), String(keys.status))
  check("internal: a member is 403 on admin", (await call("/api/internal/admin/users", session(member))).status === 403)
  check("internal: the owner reads admin", (await call("/api/internal/admin/users", session(owner))).status === 200)
  const memberLogs = await call("/api/internal/logs", session(member))
  check("internal: logs carry the name and email", memberLogs.status === 200 && /Smoke API/.test(memberLogs.text) && /smoke-member@example\.com/.test(memberLogs.text))
  check("internal: a member sees no one else's logs", !/smoke-owner@example\.com/.test(memberLogs.text))
  check("internal: analytics answers", (await call("/api/internal/analytics/overview", session(member))).status === 200)
  const csrf = await call("/api/internal/playground", { method: "POST", ...session(member, { origin: "https://evil.example" }), body: "{}" })
  check("internal: a foreign Origin is 403", csrf.status === 403)
  const invalid = await call("/api/internal/playground", { method: "POST", ...session(member, { origin: BASE, "content-type": "application/json" }), body: "{}" })
  check("internal: the playground validates input", invalid.status === 400, String(invalid.status))

  const gate = await call("/overview")
  check("pages: a signed-out dashboard redirects to /login", gate.status === 303 && (gate.headers.get("location") ?? "").endsWith("/login"), String(gate.status))
  check("pages: the dashboard renders signed in", (await call("/overview", session(member))).status === 200)
  check("pages: admin renders for the owner", (await call("/admin", session(owner))).status === 200)
  check("pages: login renders", (await call("/login")).status === 200)
  check("pages: privacy and terms render", (await call("/privacy")).status === 200 && (await call("/terms")).status === 200)
  check("auth: logout refuses GET", (await call("/auth/logout")).status === 405)

  await db.query("update users set status = 'disabled' where id = $1", [member.id])
  check("a disabled account loses its session at once", (await call("/api/internal/keys", session(member))).status === 401)
  check("a disabled account's API stops serving", (await call(`/api/v1/${member.apiId}`, bearer(member.token))).status === 404)

  await db.query("delete from users where id = $1", [member.id])
  const { rows: kept } = await db.query("select user_id, api_id, api_name, user_email from api_request_logs where user_email = 'smoke-member@example.com'")
  check("logs outlive the deleted account", kept.some((r) => r.api_name === "Smoke API") && kept.every((r) => r.user_id === null && r.api_id === null))

  await db.query("update api_request_logs set created_at = now() - interval '200 days'")
  const pruned = run("db:prune")
  const { rows: [left] } = await db.query("select count(*)::int as n from api_request_logs")
  check("db:prune removes expired logs", pruned.status === 0 && left.n === 0, pruned.stderr)
} finally {
  spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)], { shell: true })
  server.kill()
  await db.end()
}

console.log(failures === 0 ? "\nSmoke test passed." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
