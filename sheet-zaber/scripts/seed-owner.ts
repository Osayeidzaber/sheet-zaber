import { existsSync, readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { eq } from "drizzle-orm"
import { z } from "zod"

import { fail, isActionError, ok, type ActionResult } from "@/lib/action-result"
import { users } from "@/server/db/schema"

import type { AuditInput } from "@/server/admin/audit"
import type { DbTx } from "@/server/db/queries/types"

/*
 * `pnpm tsx scripts/seed-owner.ts` — the idempotent owner bootstrap.
 *
 * Scope is set by the docs, not here: `OWNER_EMAIL` grants `role='owner'` at INSERT time (the
 * first Google sign-in), and this script "merely promotes an already-signed-in user with that
 * email (idempotent, no rows created, no demo data)" — `authentication-flow.md` §4 and
 * `database-schema.md` "Migration & seed plan" item 2. Creating a row here would also plant a
 * fake `google_sub` on the owner's real email, and the partial unique on `users.email` would
 * then block their genuine first login.
 *
 * Nothing is imported from `@/lib/env` or `@/server/**` at module scope: those carry
 * `import "server-only"`, which only resolves under Next's `react-server` condition, so the
 * repository layer arrives lazily (and arrives as an injectable `deps` object for tests).
 */

export type SeedOwnerUserRow = { id: string; email: string; role: string }

export type SeedOwnerOutcome = "promoted" | "already_owner" | "absent"

export type SeedOwnerResult = { userId: string; email: string; outcome: SeedOwnerOutcome }

export type SeedOwnerDeps = {
  email: string
  transaction: <T>(fn: (tx: DbTx) => Promise<T>) => Promise<T>
  findUserByEmail: (email: string, tx: DbTx) => Promise<SeedOwnerUserRow | undefined>
  setRole: (id: string, role: "owner", tx: DbTx) => Promise<SeedOwnerUserRow | undefined>
  recordAudit: (input: AuditInput, tx: DbTx) => Promise<void>
}

/** One readable line, variable NAMES only: env validation and driver errors are multi-line. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 300)
}

/** The production wiring, resolved on first use so importing this file never needs env or a DB. */
async function defaultDeps(): Promise<SeedOwnerDeps> {
  const [envModule, usersRepo, client, auditModule] = await Promise.all([
    import("@/lib/env"),
    import("@/server/db/queries/users"),
    import("@/server/db/client"),
    import("@/server/admin/audit"),
  ])
  const { db } = client
  return {
    email: envModule.env.OWNER_EMAIL,
    transaction: (fn) => db.transaction(fn),
    // `users` has no by-email finder; this one read lives here instead of adding one, because
    // `promoteByEmail` takes no transaction handle and the role change must share the audit
    // row's transaction.
    findUserByEmail: async (email, tx) => {
      const [row] = await tx
        .select({ id: users.id, email: users.email, role: users.role })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      return row
    },
    setRole: (id, role, tx) => usersRepo.setRole(id, role, tx),
    recordAudit: (input, tx) => auditModule.recordAudit(input, tx),
  }
}

export async function seedOwner(deps?: Partial<SeedOwnerDeps>): Promise<ActionResult<SeedOwnerResult>> {
  let resolved: SeedOwnerDeps
  try {
    resolved = { ...(await defaultDeps()), ...deps }
  } catch (error) {
    return fail("internal_error", `Owner seed is unusable: ${reason(error)}`, "internal")
  }

  const parsedEmail = z.email().safeParse(resolved.email)
  if (!parsedEmail.success) {
    return fail("internal_error", "OWNER_EMAIL is not set to a valid email address; nothing changed.", "internal")
  }
  const email = parsedEmail.data

  try {
    const result = await resolved.transaction(async (tx) => {
      const existing = await resolved.findUserByEmail(email, tx)
      if (!existing) return { userId: "", email, outcome: "absent" as const }
      if (existing.role === "owner") {
        return { userId: existing.id, email: existing.email, outcome: "already_owner" as const }
      }

      const promoted = await resolved.setRole(existing.id, "owner", tx)
      if (!promoted) throw new Error("the user row disappeared mid-transaction")
      // System action: no session actor exists yet, so `actor_id` stays NULL (`audit_logs` allows it).
      await resolved.recordAudit(
        {
          actorId: null,
          action: "owner.bootstrap",
          subjectType: "user",
          subjectId: promoted.id,
          detail: { source: "scripts/seed-owner" },
        },
        tx
      )
      return { userId: promoted.id, email: promoted.email, outcome: "promoted" as const }
    })
    return ok(result)
  } catch (error) {
    return fail("internal_error", `Owner seed failed and rolled back: ${reason(error)}`, "internal")
  }
}

/**
 * `server-only` throws outside Next's `react-server` condition (Vitest aliases it). A plain-node
 * script is always server-side, so point it at that package's empty stub before the repository
 * modules load.
 */
function stubServerOnlyForNode(): void {
  try {
    const stub = fileURLToPath(new URL("../node_modules/server-only/empty.js", import.meta.url))
    registerHooks({
      resolve: (specifier, context, next) =>
        specifier === "server-only" ? { url: stub, shortCircuit: true } : next(specifier, context),
    })
  } catch {
    // A runtime without the synchronous hooks API: the import path already works there.
  }
}

/** Next loads `.env.local`/`.env`; `tsx` does not, and `src/lib/env.ts` parses at import time. */
function loadLocalEnvFiles(): void {
  for (const name of [".env.local", ".env"]) {
    const file = join(process.cwd(), name)
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (!match) continue
      const key = match[1]
      if (key === undefined || process.env[key] !== undefined) continue
      process.env[key] = match[2].replace(/^(["'])(.*)\1$/, "$2").trim()
    }
  }
}

/** One line of output per outcome; never a code, hash, token or connection string. */
export async function runSeedOwnerCli(): Promise<number> {
  stubServerOnlyForNode()
  loadLocalEnvFiles()

  const result = await seedOwner()
  if (isActionError(result)) {
    console.error(`seed-owner: ${result.error.message}`)
    await closePool()
    return 1
  }

  const { outcome, email } = result.data
  if (outcome === "promoted") console.log(`seed-owner: promoted ${email} to owner.`)
  else if (outcome === "already_owner") console.log(`seed-owner: ${email} is already owner; nothing changed.`)
  else console.log(`seed-owner: no user with ${email} has signed in yet; nothing created.`)

  await closePool()
  return 0
}

async function closePool(): Promise<void> {
  try {
    const client = await import("@/server/db/client")
    await client.getPool().end()
  } catch {
    // The pool was never reached (bad env or DB) — the exit code already says so.
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return resolve(entry) === fileURLToPath(import.meta.url)
}

if (isDirectRun()) {
  runSeedOwnerCli().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      console.error(`seed-owner: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  )
}
