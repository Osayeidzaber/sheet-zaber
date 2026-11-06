import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { isActionError, type ActionResult } from "@/lib/action-result"
import { auditLogs, users } from "@/server/db/schema"

import { seedOwner, type SeedOwnerResult } from "../scripts/seed-owner"

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
 * `scripts/seed-owner.ts` against the real embedded PostgreSQL 16 (`tests/smoke.test.ts` harness
 * shape: DATABASE_URL is republished before the modules that read `src/lib/env.ts` are first
 * imported). No Google calls, no browser, no network — the CLI cases spawn `tsx` locally.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url))

describe("owner seed script", () => {
  let test: TestDb
  let url: string
  let env: typeof import("@/lib/env")["env"]
  let usersRepo: typeof import("@/server/db/queries/users")

  beforeAll(async () => {
    try {
      url = inject(TEST_DB_URL_KEY)
    } catch {
      await startTestDb()
      await migrateTestDb()
      url = getTestDbUrl()
    }
    process.env.DATABASE_URL = url
    test = await getTestDb()

    const [envModule, usersModule] = await Promise.all([
      import("@/lib/env"),
      import("@/server/db/queries/users"),
    ])
    env = envModule.env
    usersRepo = usersModule
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  /** A person who has already signed in with Google, so the script has something to promote. */
  async function signIn(email: string, role: "user" | "owner" = "user") {
    return usersRepo.createUser({ googleSub: `seed-sub-${randomUUID()}`, email, role })
  }

  async function roleOf(id: string): Promise<string> {
    const [row] = await test.select({ role: users.role }).from(users).where(eq(users.id, id))
    return row.role
  }

  async function bootstrapRows() {
    return test.select().from(auditLogs).where(eq(auditLogs.action, "owner.bootstrap"))
  }

  function unwrap(result: ActionResult<SeedOwnerResult>): SeedOwnerResult {
    if (isActionError(result)) throw new Error(`unexpected refusal: ${result.error.message}`)
    return result.data
  }

  function errorOf(result: ActionResult<SeedOwnerResult>) {
    if (!isActionError(result)) throw new Error("expected a refusal")
    return result.error
  }

  /** The real `pnpm tsx` invocation: exit code plus everything the process printed. */
  function runCli(overrides: Record<string, string>) {
    const probe = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "seed-owner.ts")],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...overrides }, timeout: 120_000 }
    )
    return { code: probe.status, output: `${probe.stdout ?? ""}${probe.stderr ?? ""}` }
  }

  function expectNoSecrets(output: string) {
    for (const secret of [process.env.SESSION_SECRET, process.env.TOKEN_ENCRYPTION_KEY, url]) {
      if (secret) expect(output).not.toContain(secret)
    }
    expect(output).not.toMatch(/ZABER-[0-9A-Z]{4}-[0-9A-Z]{4}/)
    expect(output).not.toMatch(/[0-9a-f]{64}/)
  }

  it("creates nothing when the owner email has never signed in", async () => {
    const result = unwrap(await seedOwner())
    expect(result).toEqual({ userId: "", email: env.OWNER_EMAIL, outcome: "absent" })
    expect(await test.select().from(users)).toHaveLength(0)
    expect(await bootstrapRows()).toHaveLength(0)
  })

  it("promotes the signed-in user once, is idempotent, and audits exactly one change", async () => {
    const existing = await signIn(env.OWNER_EMAIL)

    expect(unwrap(await seedOwner())).toEqual({
      userId: existing.id,
      email: env.OWNER_EMAIL,
      outcome: "promoted",
    })
    expect(await roleOf(existing.id)).toBe("owner")

    const second = unwrap(await seedOwner())
    expect(second).toEqual({ userId: existing.id, email: env.OWNER_EMAIL, outcome: "already_owner" })
    expect(await roleOf(existing.id)).toBe("owner")

    const rows = await bootstrapRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actorId: null,
      subjectType: "user",
      subjectId: existing.id,
      detail: { source: "scripts/seed-owner" },
    })
  })

  it("writes nothing when a different email already holds the owner role", async () => {
    const other = await signIn(`other-${randomUUID()}@example.com`, "owner")
    const result = unwrap(await seedOwner({ email: other.email }))
    expect(result).toEqual({ userId: other.id, email: other.email, outcome: "already_owner" })
    expect(await bootstrapRows()).toHaveLength(0)
  })

  it("rolls the promotion back when the audit row fails", async () => {
    const existing = await signIn(env.OWNER_EMAIL)

    const error = errorOf(
      await seedOwner({
        recordAudit: async () => {
          throw new Error("forced audit failure")
        },
      })
    )
    expect(error).toMatchObject({ code: "internal_error", category: "internal" })
    expect(error.message).toContain("rolled back")
    expect(await roleOf(existing.id)).toBe("user")
    expect(await test.select().from(auditLogs)).toHaveLength(0)
  })

  it("refuses a missing or malformed OWNER_EMAIL before touching the database", async () => {
    const existing = await signIn(env.OWNER_EMAIL)

    for (const email of ["", "not-an-email", "   ", "plain text"]) {
      const error = errorOf(await seedOwner({ email }))
      expect(error).toMatchObject({ code: "internal_error", category: "internal" })
      expect(error.message).toContain("OWNER_EMAIL")
    }
    expect(await roleOf(existing.id)).toBe("user")
    expect(await test.select().from(auditLogs)).toHaveLength(0)
  })

  it("reports an unusable connection as a readable failure", async () => {
    const error = errorOf(
      await seedOwner({
        transaction: async () => {
          throw new Error("connection to server at 127.0.0.1:1 refused")
        },
      })
    )
    expect(error.code).toBe("internal_error")
    expect(error.message).toContain("refused")
  })

  it("exits non-zero with a readable message when the environment is unusable", async () => {
    const run = runCli({ DATABASE_URL: "", OWNER_EMAIL: "", SESSION_SECRET: "", TOKEN_ENCRYPTION_KEY: "" })
    expect(run.code).toBe(1)
    expect(run.output).toContain("seed-owner:")
    expect(run.output).toContain("DATABASE_URL")
    expect(run.output).toContain("OWNER_EMAIL")
    expectNoSecrets(run.output)
  })

  it("promotes through the CLI and stays safe to run twice", async () => {
    const email = `cli-owner-${randomUUID()}@example.com`
    const existing = await signIn(email)

    const first = runCli({ OWNER_EMAIL: email })
    expect(first.code).toBe(0)
    expect(first.output).toContain(`promoted ${email}`)
    expectNoSecrets(first.output)
    expect(await roleOf(existing.id)).toBe("owner")

    const second = runCli({ OWNER_EMAIL: email })
    expect(second.code).toBe(0)
    expect(second.output).toContain("already owner")
    expectNoSecrets(second.output)
    expect(await bootstrapRows()).toHaveLength(1)
  }, 120_000)
})
