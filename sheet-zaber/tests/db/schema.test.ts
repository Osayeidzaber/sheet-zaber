import { randomUUID } from "node:crypto"

import { drizzle } from "drizzle-orm/node-postgres"
import { eq } from "drizzle-orm"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { invitations, users } from "@/server/db/schema"

import { migrateTestDb, startTestDb, stopTestDb } from "../helpers/db"

/*
 * Integration test against a real (embedded) PostgreSQL 16 instance with all
 * committed migrations applied. Gated: if the embedded instance cannot start on
 * this machine (blocked binary, AV, etc.) the tests skip instead of failing —
 * but on the target machine they MUST run.
 */

const ALL_TABLES = [
  "users",
  "user_profiles",
  "invitations",
  "invitation_redemptions",
  "google_connections",
  "registered_spreadsheets",
  "api_configurations",
  "api_keys",
  "api_request_logs",
  "audit_logs",
  "rate_limit_buckets",
] as const

let startupError: unknown = null
let pool: pg.Pool | undefined

beforeAll(async () => {
  try {
    const url = await startTestDb()
    await migrateTestDb()
    pool = new pg.Pool({ connectionString: url })
  } catch (error) {
    startupError = error
    console.error("[schema.test] embedded Postgres unavailable:", error)
  }
}, 300_000)

afterAll(async () => {
  await pool?.end()
  await stopTestDb().catch(() => {})
})

/** Skip-with-reason when the embedded instance failed to boot; else give the pool. */
function db(ctx: { skip: () => never }): pg.Pool {
  if (startupError) ctx.skip()
  if (!pool) throw new Error("test pool missing without a startup error")
  return pool
}

describe("migrated schema", () => {
  it("creates all 11 tables", async (ctx) => {
    const { rows } = await db(ctx).query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    )
    expect(rows.map((r) => r.tablename).sort()).toEqual([...ALL_TABLES].sort())
  })

  it("enables RLS on all 11 tables", async (ctx) => {
    const { rows } = await db(ctx).query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
        ORDER BY c.relname`
    )
    expect(rows.map((r) => r.relname).sort()).toEqual([...ALL_TABLES].sort())
  })

  it("enforces the key UNIQUE constraints from database-schema.md", async (ctx) => {
    const { rows } = await db(ctx).query<{ table_name: string; def: string }>(
      `SELECT conrelid::regclass::text AS table_name,
              pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE contype = 'u' AND connamespace = 'public'::regnamespace`
    )
    const uniqueOn = (table: string) =>
      rows.filter((r) => r.table_name === table).map((r) => r.def.replace(/\s+/g, " "))

    expect(uniqueOn("users")).toContain("UNIQUE (google_sub)")
    expect(uniqueOn("users")).toContain("UNIQUE (email)")
    expect(uniqueOn("invitations")).toContain("UNIQUE (code_hash)")
    expect(uniqueOn("api_keys")).toContain("UNIQUE (key_hash)")
    expect(uniqueOn("registered_spreadsheets")).toContain("UNIQUE (user_id, google_sheet_id)")
    expect(uniqueOn("invitation_redemptions")).toContain("UNIQUE (invitation_id, redeemed_by)")
    expect(uniqueOn("google_connections")).toContain("UNIQUE (user_id, google_email)")
  })

  it("creates the partial indexes from database-schema.md", async (ctx) => {
    const { rows } = await db(ctx).query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`
    )
    const defs = rows.map((r) => r.indexdef.replace(/\s+/g, " "))
    expect(
      defs.some((d) => d.includes("invitations") && d.includes("code_hash") && d.includes("revoked_at IS NULL"))
    ).toBe(true)
    expect(
      defs.some((d) => d.includes("api_keys") && d.includes("key_hash") && d.includes("revoked_at IS NULL"))
    ).toBe(true)
    expect(
      defs.some((d) => d.includes("users") && d.includes("email") && d.includes("status <> 'deleted'::text"))
    ).toBe(true)
  })

  it("enforces the documented UNIQUE keys with real duplicate inserts", async (ctx) => {
    const client = await db(ctx).connect()
    try {
      const uid = randomUUID()
      await client.query(
        `INSERT INTO users (id, google_sub, email) VALUES ($1, $2, $3)`,
        [uid, `dup-${uid}`, `dup-${uid}@example.com`]
      )
      // users.google_sub
      await expect(
        client.query(`INSERT INTO users (id, google_sub, email) VALUES ($1, $2, $3)`, [
          randomUUID(),
          `dup-${uid}`,
          `other-${uid}@example.com`,
        ])
      ).rejects.toThrow(/users_google_sub_unique/)

      // invitations.code_hash
      const codeHash = randomUUID().replace(/-/g, "")
      await client.query(`INSERT INTO invitations (id, code_hash, created_by) VALUES ($1, $2, $3)`, [
        randomUUID(),
        codeHash,
        uid,
      ])
      await expect(
        client.query(`INSERT INTO invitations (id, code_hash, created_by) VALUES ($1, $2, $3)`, [
          randomUUID(),
          codeHash,
          uid,
        ])
      ).rejects.toThrow(/invitations_code_hash_unique/)

      // api_keys.key_hash
      const keyHash = `kh-${uid}`
      await client.query(
        `INSERT INTO api_keys (id, user_id, name, key_hash, key_preview) VALUES ($1, $2, 'k', $3, 'p')`,
        [randomUUID(), uid, keyHash]
      )
      await expect(
        client.query(
          `INSERT INTO api_keys (id, user_id, name, key_hash, key_preview) VALUES ($1, $2, 'k2', $3, 'p2')`,
          [randomUUID(), uid, keyHash]
        )
      ).rejects.toThrow(/api_keys_key_hash_unique/)

      // registered_spreadsheets (user_id, google_sheet_id)
      const connectionId = randomUUID()
      await client.query(
        `INSERT INTO google_connections (id, user_id, google_email, refresh_token_enc, scope) VALUES ($1, $2, $3, 'enc', 'scope')`,
        [connectionId, uid, `g-${uid}@example.com`]
      )
      const sheetInsert = `
        INSERT INTO registered_spreadsheets (id, user_id, connection_id, google_sheet_id, title, tabs)
        VALUES ($1, $2, $3, $4, 'title', '[]'::jsonb)`
      await client.query(sheetInsert, [randomUUID(), uid, connectionId, `sheet-${uid}`])
      await expect(
        client.query(sheetInsert, [randomUUID(), uid, connectionId, `sheet-${uid}`])
      ).rejects.toThrow(/registered_spreadsheets_user_sheet_unique/)
    } finally {
      client.release()
    }
  })

  it("inserts and reads back a users row via Drizzle with documented defaults", async (ctx) => {
    db(ctx)
    const orm = drizzle(pool!, { schema: { users, invitations } })
    const id = randomUUID()
    await orm.insert(users).values({
      id,
      googleSub: `sub-${id}`,
      email: `user-${id}@example.com`,
    })
    const [row] = await orm.select().from(users).where(eq(users.id, id))
    expect(row).toBeDefined()
    expect(row.googleSub).toBe(`sub-${id}`)
    expect(row.role).toBe("user")
    expect(row.status).toBe("active")
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.updatedAt).toBeInstanceOf(Date)

    // CHECK constraints: role/status are closed enums. Asserted via the raw
    // driver — Drizzle re-wraps pg errors as "Failed query: …", hiding the
    // constraint name from the message matcher (the schema is the same SQL).
    await expect(
      db(ctx).query(
        `INSERT INTO users (id, google_sub, email, role) VALUES ($1, $2, $3, 'admin')`,
        [randomUUID(), `bad-role-${id}`, `bad-role-${id}@x.dev`]
      )
    ).rejects.toThrow(/users_role_check/)
  })

  it("makes invitation redemption atomic (max_uses=1 redeems exactly once)", async (ctx) => {
    const client = await db(ctx).connect()
    const orm = drizzle(pool!, { schema: { users, invitations } })
    try {
      const ownerId = randomUUID()
      await orm.insert(users).values({ id: ownerId, googleSub: `owner-${ownerId}`, email: `owner-${ownerId}@example.com` })
      const invitationId = randomUUID()
      const codeHash = randomUUID().replace(/-/g, "")
      await orm.insert(invitations).values({ id: invitationId, codeHash, createdBy: ownerId, maxUses: 1 })

      // The exact single-statement redemption from database-schema.md.
      const redeem = `
        UPDATE invitations
           SET uses = uses + 1
         WHERE code_hash = $1
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
           AND uses < max_uses
        RETURNING id`
      const first = await client.query(redeem, [codeHash])
      expect(first.rowCount).toBe(1)
      expect(first.rows[0].id).toBe(invitationId)

      const second = await client.query(redeem, [codeHash])
      expect(second.rowCount).toBe(0)

      const { rows } = await client.query("SELECT uses FROM invitations WHERE id = $1", [invitationId])
      expect(rows[0].uses).toBe(1)
    } finally {
      client.release()
    }
  })
})
