import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest"

import { invitationRedemptions, invitations, users } from "@/server/db/schema"

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
 * Integration coverage for src/server/db/queries/invitations.ts and audit.ts against the
 * real embedded PostgreSQL 16 (no mocks). Same harness shape as `tests/smoke.test.ts`:
 * DATABASE_URL is republished before the query modules (and therefore `src/lib/env.ts`)
 * are first imported, so the modules' own pooled `db` reaches the test instance.
 * Prerequisites come only from `users` plus raw schema inserts — the other query modules
 * are owned by concurrent tasks and are deliberately not imported.
 */

describe("invitations and audit query modules", () => {
  let test: TestDb
  let repo: {
    users: typeof import("@/server/db/queries/users")
    invitations: typeof import("@/server/db/queries/invitations")
    audit: typeof import("@/server/db/queries/audit")
  }

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
    repo = {
      users: await import("@/server/db/queries/users"),
      invitations: await import("@/server/db/queries/invitations"),
      audit: await import("@/server/db/queries/audit"),
    }
  }, 300_000)

  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await stopTestDb()
  })

  async function seedUser(role: "user" | "owner" = "user") {
    const stamp = randomUUID()
    return repo.users.createUser({
      googleSub: `sub-${stamp}`,
      email: `repo-${stamp}@example.com`,
      role,
    })
  }

  function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 86_400_000)
  }

  function invitationInput(
    codeHash: string,
    createdBy: string,
    overrides: Partial<{ label: string | null; maxUses: number; expiresAt: Date | null }> = {}
  ) {
    return { codeHash, label: null, maxUses: 1, expiresAt: null, createdBy, ...overrides }
  }

  /** Drizzle surfaces the driver's error; walk `cause` anyway so wrapping cannot hide it. */
  function pgConstraint(error: unknown): string | undefined {
    const seen = new Set<unknown>()
    let current: unknown = error
    while (current !== null && current !== undefined && !seen.has(current)) {
      seen.add(current)
      const candidate = current as { constraint?: unknown; cause?: unknown }
      if (typeof candidate.constraint === "string") return candidate.constraint
      current = candidate.cause
    }
    return undefined
  }

  // `createdAt` is app-side JS time (millisecond resolution); separate writes so the
  // newest-first assertions below cannot tie.
  async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  it("batch-inserts invitations and lists them newest-first without the code hash", async () => {
    const owner = await seedUser("owner")
    const [first, second] = await repo.invitations.insertInvitations(
      [
        invitationInput(`code-${randomUUID()}`, owner.id, { label: "for Rahim", maxUses: 2 }),
        invitationInput(`code-${randomUUID()}`, owner.id, { expiresAt: daysFromNow(1) }),
      ],
      test
    )
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first.id).not.toBe(second.id)
    expect(first.uses).toBe(0)
    expect(first.createdAt).toBeInstanceOf(Date)

    await tick()
    const [newest] = await repo.invitations.insertInvitations(
      [invitationInput(`code-${randomUUID()}`, owner.id)],
      test
    )

    const listed = await repo.invitations.listInvitations()
    expect(listed).toHaveLength(3)
    expect(listed[0].id).toBe(newest.id)
    for (const row of listed) {
      expect(row).not.toHaveProperty("codeHash")
      expect(row).not.toHaveProperty("code_hash")
    }
    expect(listed.find((row) => row.id === first.id)).toMatchObject({
      label: "for Rahim",
      maxUses: 2,
      uses: 0,
      expiresAt: null,
      revokedAt: null,
      createdBy: owner.id,
    })
  })

  it("redeems a single-use code once and refuses revoked, expired and unknown codes", async () => {
    const owner = await seedUser("owner")
    const single = `code-${randomUUID()}`
    const [one] = await repo.invitations.insertInvitations([invitationInput(single, owner.id)], test)

    expect(await repo.invitations.redeemInvitation(single, test)).toBe(one.id)
    expect(await repo.invitations.redeemInvitation(single, test)).toBeNull()
    const [spent] = await test.select({ uses: invitations.uses }).from(invitations).where(eq(invitations.id, one.id))
    expect(spent.uses).toBe(1)

    const expired = `code-${randomUUID()}`
    const revoked = `code-${randomUUID()}`
    const [timed, killable] = await repo.invitations.insertInvitations(
      [
        invitationInput(expired, owner.id, { maxUses: 5, expiresAt: daysFromNow(-1) }),
        invitationInput(revoked, owner.id, { maxUses: 5 }),
      ],
      test
    )
    expect(await repo.invitations.redeemInvitation(expired, test)).toBeNull()
    expect(await repo.invitations.redeemInvitation(revoked, test)).toBe(killable.id)

    // Omitted `q` here exercises the module's default pooled handle against the same
    // instance, and the double revoke must not clobber the first timestamp.
    await repo.invitations.revokeInvitation(killable.id)
    const [afterFirstRevoke] = await test.select().from(invitations).where(eq(invitations.id, killable.id))
    await repo.invitations.revokeInvitation(killable.id)

    expect(await repo.invitations.redeemInvitation(revoked, test)).toBeNull()
    expect(await repo.invitations.redeemInvitation(`code-${randomUUID()}`, test)).toBeNull()

    const [row] = await test.select().from(invitations).where(eq(invitations.id, killable.id))
    expect(row.revokedAt).toBeInstanceOf(Date)
    expect(row.uses).toBe(1)
    expect(row.revokedAt?.getTime()).toBe(afterFirstRevoke.revokedAt?.getTime())
    expect(row.revokedAt?.getTime()).toBeLessThanOrEqual(Date.now())

    const [untouched] = await test
      .select({ uses: invitations.uses })
      .from(invitations)
      .where(eq(invitations.id, timed.id))
    expect(untouched.uses).toBe(0)
  })

  it("elects exactly one winner when two redemptions race a single-use code", async () => {
    const owner = await seedUser("owner")
    const code = `code-${randomUUID()}`
    const [invitation] = await repo.invitations.insertInvitations([invitationInput(code, owner.id)], test)

    const results = await Promise.all([
      repo.invitations.redeemInvitation(code, test),
      repo.invitations.redeemInvitation(code, test),
    ])
    expect(results.filter((id) => id === invitation.id)).toHaveLength(1)
    expect(results.filter((id) => id === null)).toHaveLength(1)

    const [row] = await test
      .select({ uses: invitations.uses })
      .from(invitations)
      .where(eq(invitations.id, invitation.id))
    expect(row.uses).toBe(1)
  })

  it("rolls the redemption counter, the user and the redemption row back with the transaction", async () => {
    const owner = await seedUser("owner")
    const code = `code-${randomUUID()}`
    const [invitation] = await repo.invitations.insertInvitations([invitationInput(code, owner.id)], test)

    await expect(
      test.transaction(async (tx) => {
        expect(await repo.invitations.redeemInvitation(code, tx)).toBe(invitation.id)
        const created = await repo.users.createUser(
          {
            googleSub: `sub-${randomUUID()}`,
            email: `rolledback-${randomUUID()}@example.com`,
            role: "user",
            invitationId: invitation.id,
          },
          tx
        )
        await repo.invitations.recordRedemption({ invitationId: invitation.id, redeemedBy: created.id }, tx)
        throw new Error("forced rollback")
      })
    ).rejects.toThrow("forced rollback")

    const [row] = await test.select().from(invitations).where(eq(invitations.id, invitation.id))
    expect(row.uses).toBe(0)
    expect(await test.select().from(invitationRedemptions)).toHaveLength(0)
    expect(await test.select().from(users)).toHaveLength(1)

    expect(await repo.invitations.redeemInvitation(code, test)).toBe(invitation.id)
  })

  it("surfaces the invitations_code_hash_unique violation from a duplicate batch insert", async () => {
    const owner = await seedUser("owner")
    const codeHash = `code-${randomUUID()}`
    await repo.invitations.insertInvitations([invitationInput(codeHash, owner.id)], test)

    const duplicate = await repo.invitations
      .insertInvitations([invitationInput(codeHash, owner.id)], test)
      .catch((error: unknown) => error)
    expect(pgConstraint(duplicate)).toBe("invitations_code_hash_unique")

    const listed = await repo.invitations.listInvitations(test)
    expect(listed).toHaveLength(1)
  })

  it("records redemptions and surfaces the invitation/user unique violation", async () => {
    const owner = await seedUser("owner")
    const [invitation] = await repo.invitations.insertInvitations(
      [invitationInput(`code-${randomUUID()}`, owner.id, { maxUses: 3 })],
      test
    )
    const invited = await repo.users.createUser(
      {
        googleSub: `sub-${randomUUID()}`,
        email: `invited-${randomUUID()}@example.com`,
        role: "user",
        invitationId: invitation.id,
      },
      test
    )

    await repo.invitations.recordRedemption({ invitationId: invitation.id, redeemedBy: invited.id }, test)
    const [redemption] = await test.select().from(invitationRedemptions)
    expect(redemption.invitationId).toBe(invitation.id)
    expect(redemption.redeemedBy).toBe(invited.id)
    expect(redemption.id).toBeTruthy()
    expect(redemption.redeemedAt).toBeInstanceOf(Date)

    const duplicate = await repo.invitations
      .recordRedemption({ invitationId: invitation.id, redeemedBy: invited.id }, test)
      .catch((error: unknown) => error)
    expect(pgConstraint(duplicate)).toBe("invitation_redemptions_invitation_user_unique")

    // `recordRedemption` is bookkeeping only — it never touches the consumption counter.
    const [row] = await test
      .select({ uses: invitations.uses })
      .from(invitations)
      .where(eq(invitations.id, invitation.id))
    expect(row.uses).toBe(0)
  })

  it("writes audit rows with default detail and a null actor, and filters newest-first", async () => {
    const owner = await seedUser("owner")
    const invited = await seedUser()
    const [invitation] = await repo.invitations.insertInvitations(
      [invitationInput(`code-${randomUUID()}`, owner.id)],
      test
    )

    const createdRow = await repo.audit.writeAudit({
      actorId: owner.id,
      action: "invitation.create",
      subjectType: "invitation",
      subjectId: invitation.id,
      detail: { maxUses: 1 },
    })
    expect(createdRow.id).toBeTruthy()
    expect(createdRow.actorId).toBe(owner.id)
    expect(createdRow.detail).toEqual({ maxUses: 1 })
    expect(createdRow.createdAt).toBeInstanceOf(Date)

    const bootstrap = await repo.audit.writeAudit({
      actorId: null,
      action: "owner.bootstrap",
      subjectType: "user",
      subjectId: owner.id,
    })
    expect(bootstrap.actorId).toBeNull()
    expect(bootstrap.detail).toEqual({})

    await tick()
    await repo.audit.writeAudit(
      {
        actorId: invited.id,
        action: "invitation.redeem",
        subjectType: "invitation",
        subjectId: invitation.id,
        detail: { code: "redemption" },
      },
      test
    )

    expect(await repo.audit.listAudit({ actorId: owner.id, limit: 10 })).toHaveLength(1)

    const subjectRows = await repo.audit.listAudit({
      subjectType: "invitation",
      subjectId: invitation.id,
      limit: 10,
    })
    expect(subjectRows).toHaveLength(2)
    expect(subjectRows[0].actorId).toBe(invited.id)
    expect(subjectRows[1].actorId).toBe(owner.id)

    const bootRows = await repo.audit.listAudit({ subjectType: "user", subjectId: owner.id, limit: 10 })
    expect(bootRows).toHaveLength(1)
    expect(bootRows[0].actorId).toBeNull()
    expect(bootRows[0].detail).toEqual({})

    expect(await repo.audit.listAudit({ limit: 1 })).toHaveLength(1)
    const all = await repo.audit.listAudit({ limit: 10 })
    expect(all).toHaveLength(3)
    expect(all[0].action).toBe("invitation.redeem")
  })

  it("returns no rows for filters that match nothing and defaults detail to {}", async () => {
    const owner = await seedUser("owner")
    await repo.audit.writeAudit({ actorId: owner.id, action: "user.disable", subjectType: "user", subjectId: owner.id })

    expect(await repo.audit.listAudit({ actorId: randomUUID(), limit: 10 })).toHaveLength(0)
    expect(await repo.audit.listAudit({ subjectType: "invitation", limit: 10 })).toHaveLength(0)
    expect(await repo.audit.listAudit({ actorId: owner.id, subjectId: randomUUID(), limit: 10 })).toHaveLength(0)
    expect((await repo.audit.listAudit({ limit: 10 }))[0].detail).toEqual({})
  })
})
