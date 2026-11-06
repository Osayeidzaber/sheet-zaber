import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto"

import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import pg from "pg"

import { E2E_DATABASE_URL, E2E_SESSION_SECRET, E2E_TOKEN_KEY } from "../playwright.config"

/*
 * The dashboard in a real browser against a production build. Google is never called: accounts are
 * seeded and signed in with a real session cookie, and the seeded refresh token cannot decrypt.
 */

type Account = { id: string; email: string; sheetId: string; apiId: string; cookie: string }

async function seed(db: pg.Client, role: "owner" | "user", tag: string): Promise<Account> {
  const id = randomUUID()
  const connectionId = randomUUID()
  const sheetId = randomUUID()
  const apiId = randomUUID()
  const email = `${tag}-${id.slice(0, 8)}@example.com`
  await db.query("insert into users (id, google_sub, email, role) values ($1,$2,$3,$4)", [id, `sub-${id}`, email, role])
  await db.query("insert into user_profiles (user_id, display_name) values ($1,$2)", [id, tag])
  await db.query(
    "insert into google_connections (id, user_id, google_email, refresh_token_enc, scope) values ($1,$2,$3,'bm90LXJlYWwtY2lwaGVydGV4dA==','openid')",
    [connectionId, id, email]
  )
  await db.query(
    `insert into registered_spreadsheets (id, user_id, connection_id, google_sheet_id, title, tabs)
     values ($1,$2,$3,$4,'Roster sheet','[{"id":0,"title":"Sheet1","rows":10,"columns":3}]')`,
    [sheetId, id, connectionId, `sheet-${sheetId}`]
  )
  await db.query(
    `insert into api_configurations (id, user_id, spreadsheet_id, name, tab_title, allowed_operations)
     values ($1,$2,$3,'Roster API','Sheet1','["GET"]')`,
    [apiId, id, sheetId]
  )
  const plaintext = `sz_live_${randomBytes(16).toString("hex")}`
  await db.query(
    `insert into api_keys (id, user_id, name, key_hash, key_preview, scopes) values ($1,$2,'seeded key',$3,'sz_live_seed','["read"]')`,
    [randomUUID(), id, createHash("sha256").update(plaintext).digest("hex")]
  )
  const segment = Buffer.from(JSON.stringify({ uid: id, role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  const signature = createHmac("sha256", E2E_SESSION_SECRET).update(segment).digest("base64url")
  return { id, email, sheetId, apiId, cookie: `__Host-sz_session=${segment}.${signature}` }
}

let db: pg.Client
let owner: Account
let member: Account

test.beforeAll(async () => {
  db = new pg.Client(E2E_DATABASE_URL)
  await db.connect()
  owner = await seed(db, "owner", "owner")
  member = await seed(db, "user", "member")
})

// The invitation throttle counts attempts per client, and every test here is the same client.
test.beforeEach(async () => {
  await db.query("delete from rate_limit_buckets")
})

test.afterAll(async () => {
  await db.end()
})

async function signIn(page: Page, account: Account): Promise<void> {
  // A real cookie, because an injected header does not reliably reach a page's own fetch POSTs.
  const [name, value] = account.cookie.split(/=(.*)/)
  await page.context().addCookies([{ name, value, domain: "localhost", path: "/", secure: true, httpOnly: true }])
}

/** Fails on a crashed page, an uncaught script error, a serious accessibility fault or sideways scroll. */
async function visit(page: Page, path: string): Promise<void> {
  const errors: string[] = []
  const onError = (error: Error) => errors.push(error.message)
  page.on("pageerror", onError)
  const response = await page.goto(path)
  expect(response?.status(), path).toBeLessThan(400)
  await expect(page.locator("h1").first(), path).toBeVisible()
  await expect(page.getByText("Application error"), path).toHaveCount(0)
  // Past streaming, so the check sees the page and not its loading skeleton.
  await page.waitForTimeout(500)

  const overflow = await page.evaluate(() => {
    const width = window.innerWidth
    const offenders = Array.from(document.querySelectorAll("body *"))
      .filter((element) => element.getBoundingClientRect().right > width + 1)
      .slice(0, 5)
      .map((element) => `${element.tagName}.${String(element.getAttribute("class")).slice(0, 70)}`)
    return { amount: document.documentElement.scrollWidth - width, offenders }
  })
  expect(overflow.amount, `${path} scrolls sideways: ${overflow.offenders.join(" | ")}`).toBeLessThanOrEqual(1)

  // Entrance animations must finish: nothing may stay dimmed.
  await page.waitForTimeout(600)
  const dimmed = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".stagger-page > * > *, .reveal")).filter((element) => Number(getComputedStyle(element).opacity) < 1).length
  )
  expect(dimmed, `${path} has elements stuck mid-fade`).toBe(0)

  const axe = await new AxeBuilder({ page }).analyze()
  const serious = axe.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 2).map((node) => node.target.join(" ")).join(", ")}`)
  expect(serious, `${path} accessibility`).toEqual([])

  page.off("pageerror", onError)
  expect(errors, path).toEqual([])
}

test("public pages render", async ({ page }) => {
  for (const path of ["/", "/login", "/docs", "/docs/authentication", "/docs/envelope", "/docs/errors", "/docs/operations", "/docs/rate-limits", "/privacy", "/terms"]) {
    await visit(page, path)
  }
})

test("public pages can be indexed and private ones cannot", async ({ page, request }) => {
  await page.goto("/docs/errors")
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^index/)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/docs\/errors$/)
  await page.goto("/")
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1)
  await page.goto("/login")
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^noindex/)
  await signIn(page, member)
  await page.goto("/overview")
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^noindex/)
  expect(await (await request.get("/robots.txt")).text()).toContain("Disallow: /overview")
  expect(await (await request.get("/sitemap.xml")).text()).toContain("/docs/rate-limits</loc>")
  expect((await request.get("/opengraph-image")).headers()["content-type"]).toBe("image/png")
})

test("a signed-out dashboard goes to sign-in, and sign-in errors are explained", async ({ page }) => {
  await page.goto("/overview")
  await expect(page).toHaveURL(/\/login$/)
  await page.goto("/login?error=disabled")
  await expect(page.getByRole("alert").or(page.locator("main")).first()).toContainText(/disabled/i)
})

test("every member screen renders", async ({ page }) => {
  await signIn(page, member)
  for (const path of ["/overview", "/spreadsheets", `/spreadsheets/${member.sheetId}`, "/apis", "/apis/new", `/apis/${member.apiId}`, `/apis/${member.apiId}/edit`, "/keys", "/playground", "/logs", "/analytics", "/settings"]) {
    await visit(page, path)
  }
})

test("a member cannot open admin", async ({ page }) => {
  await signIn(page, member)
  await page.goto("/admin")
  await expect(page).not.toHaveURL(/\/admin$/)
})

test("every admin screen renders for the owner", async ({ page }) => {
  await signIn(page, owner)
  for (const path of ["/admin", "/admin/users", `/admin/users/${member.id}`, "/admin/invitations"]) {
    await visit(page, path)
  }
})

function pendingCookie(email: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(E2E_TOKEN_KEY, "base64"), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify({ refreshToken: "e2e-token", scope: "openid" }), "utf8"), cipher.final()])
  const tok = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")
  const value = { sub: `sub-${randomUUID()}`, email, name: "New Person", picture: null, exp: Math.floor(Date.now() / 1000) + 600, tok }
  const segment = Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${segment}.${createHmac("sha256", E2E_SESSION_SECRET).update(segment).digest("base64url")}`
}

async function mintCode(page: Page): Promise<string> {
  await signIn(page, owner)
  await page.goto("/admin/invitations")
  await page.getByLabel("How many codes").fill("1")
  await page.getByRole("button", { name: "Create invitation codes" }).click()
  const field = page.getByLabel("Invitation code 1 of 1")
  await expect(field).toHaveValue(/^ZABER-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  const code = await field.inputValue()
  await page.context().clearCookies()
  return code
}

test("a new person is refused a bad code, then redeems a real one and lands in the dashboard", async ({ page, context, baseURL }) => {
  const code = await mintCode(page)
  const email = `new-${randomUUID().slice(0, 8)}@example.com`
  await context.addCookies([
    { name: "__Host-sz_pending", value: pendingCookie(email), url: (baseURL as string).replace("http:", "https:"), secure: true, httpOnly: true, sameSite: "Lax" },
  ])

  await page.goto("/login?step=invitation")
  await page.locator('input[name="username"]').fill(`user_${randomUUID().slice(0, 8)}`)
  await page.locator('input[name="code"]').fill("ZABER-0000-0000")
  await page.locator("form", { has: page.locator('input[name="code"]') }).locator('button[type="submit"]').click()
  await expect(page.getByText(/invitation code is not valid/i).first()).toBeVisible()

  await page.locator('input[name="username"]').fill(`user_${randomUUID().slice(0, 8)}`)
  await page.locator('input[name="code"]').fill(code)
  await page.locator("form", { has: page.locator('input[name="code"]') }).locator('button[type="submit"]').click()
  await expect(page).toHaveURL(/\/overview/)
  await expect(page.locator("h1").first()).toBeVisible()
  const { rows } = await db.query("select role, status, username is not null as named from users where email = $1", [email])
  expect(rows).toEqual([{ role: "user", status: "active", named: true }])
})

test("a revoked code is refused with the same message", async ({ page, context, baseURL }) => {
  const code = await mintCode(page)
  await db.query("update invitations set revoked_at = now() where revoked_at is null")
  await context.addCookies([
    { name: "__Host-sz_pending", value: pendingCookie(`rev-${randomUUID().slice(0, 8)}@example.com`), url: (baseURL as string).replace("http:", "https:"), secure: true, httpOnly: true, sameSite: "Lax" },
  ])
  await page.goto("/login?step=invitation")
  await page.locator('input[name="username"]').fill(`user_${randomUUID().slice(0, 8)}`)
  await page.locator('input[name="code"]').fill(code)
  await page.locator("form", { has: page.locator('input[name="code"]') }).locator('button[type="submit"]').click()
  await expect(page.getByText(/invitation code is not valid/i).first()).toBeVisible()
})

test("inviting needs the owner's permission, and the switch grants it", async ({ page }) => {
  const person = await seed(db, "user", "inviter")
  await signIn(page, person)
  await page.goto("/invites")
  await expect(page.getByText("You can't create invitation codes")).toBeVisible()
  await expect(page.getByRole("button", { name: "Create invitation code" })).toHaveCount(0)

  await page.context().clearCookies()
  await signIn(page, owner)
  await page.goto(`/admin/users/${person.id}`)
  await page.getByText("Can create invitation codes").click()
  await expect.poll(async () => (await db.query("select can_invite from users where id = $1", [person.id])).rows[0].can_invite).toBe(true)

  await page.context().clearCookies()
  await signIn(page, person)
  await page.goto("/invites")
  await page.getByRole("button", { name: "Create invitation code" }).click()
  await expect(page.getByLabel("Invitation code (shown once)")).toHaveValue(/^ZABER-/)
  const { rows } = await db.query("select max_uses, expires_at from invitations where created_by = $1", [person.id])
  expect(rows).toHaveLength(1)
  expect(rows[0].max_uses).toBe(1)
  expect(rows[0].expires_at).not.toBeNull()
})

test("a disabled person is out on their next request", async ({ page }) => {
  const person = await seed(db, "user", "disabled")
  await signIn(page, person)
  await page.goto("/overview")
  await expect(page).toHaveURL(/\/overview/)
  await db.query("update users set status = 'disabled' where id = $1", [person.id])
  await page.goto("/overview")
  await expect(page).toHaveURL(/\/login/)
})

test("create an endpoint from a registered sheet, then it appears and can be opened", async ({ page }) => {
  await signIn(page, member)
  await page.goto("/apis/new")
  await page.getByLabel("Endpoint name").fill("Journey API")
  await page.getByRole("button", { name: "Create endpoint" }).click()
  await expect(page).toHaveURL(/\/apis\/[0-9a-f-]{36}/)
  await expect(page.getByText("Journey API").first()).toBeVisible()
  // The seeded grant cannot decrypt, so the connection test must say so rather than claim success.
  await expect(page.getByText("Not connected")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("link", { name: "Reconnect Google" }).first()).toBeVisible()
})

test("a key is shown once and never returns", async ({ page }) => {
  await signIn(page, member)
  await page.goto("/keys")
  await page.getByLabel("Key name").fill("e2e key")
  await page.locator("form", { has: page.getByLabel("Key name") }).locator('button[type="submit"]').click()
  await expect(page.getByLabel("API key (shown once)")).toHaveValue(/^sz_live_[0-9a-f]{32}$/)
  await page.reload()
  await expect(page.getByText("e2e key").first()).toBeVisible()
  await expect(page.getByLabel("API key (shown once)")).toHaveCount(0)
})

test("the playground renders the engine's real answer, and logs keep the API's name", async ({ page }) => {
  await signIn(page, member)
  await page.goto("/playground")
  const { rows } = await db.query("select id from api_keys where user_id = $1 and name = 'seeded key'", [member.id])
  await page.getByLabel("API key row").selectOption(rows[0].id)
  await page.getByLabel("Endpoint").selectOption(member.apiId)
  await page.getByRole("button", { name: "Send request" }).click()
  await expect(page.getByText(/google_reauth_required|google_not_connected/).first()).toBeVisible({ timeout: 15_000 })
  await page.goto("/logs")
  await expect(page.locator("table").getByText("Roster API").first()).toBeVisible()
})

test("the owner sets a limit, sees it on the row, and cannot delete without typing the email", async ({ page }) => {
  await signIn(page, owner)
  await page.goto("/admin/users")
  await page.getByRole("button", { name: `Set the daily limit for ${member.email}` }).click()
  await page.getByLabel("Requests per day").fill("1234")
  await page.getByRole("button", { name: "Save limit" }).click()
  await expect(page.getByText(`Stored: ${member.email}'s daily limit is now 1234.`)).toBeVisible()
  await expect(page.getByRole("row", { name: new RegExp(member.email) })).toContainText("1,234")

  const victim = await seed(db, "user", "victim")
  await page.reload()
  await page.getByRole("button", { name: `Delete ${victim.email}` }).click()
  const confirm = page.getByRole("button", { name: "Delete account" })
  await expect(confirm).toBeDisabled()
  await page.getByRole("dialog").getByRole("textbox").fill(victim.email)
  await confirm.click()
  await expect(page.getByText(`Deleted ${victim.email}.`)).toBeVisible()
})

test("the owner issues a code, and invite-by-email says why it can't send", async ({ page }) => {
  await signIn(page, owner)
  await page.goto("/admin/invitations")
  await page.getByLabel("How many codes").fill("1")
  await page.getByRole("button", { name: "Create invitation codes" }).click()
  await expect(page.getByLabel("Invitation code 1 of 1")).toHaveValue(/^ZABER-/)

  await page.getByLabel("Email addresses").fill("rahim@example.com")
  await page.getByRole("button", { name: "Send invitations" }).click()
  await expect(page.getByText("email_from_missing")).toBeVisible()
})
