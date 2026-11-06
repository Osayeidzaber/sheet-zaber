import { describe, expect, it } from "vitest"

import { can, type Action } from "@/server/auth/rbac"

/*
 * authentication-flow.md §3: one central table, so a third role adds rows here
 * rather than editing call sites.
 */

const ACTIONS: Action[] = [
  "user.list",
  "user.read",
  "user.disable",
  "user.enable",
  "user.promote",
  "user.demote",
  "invitation.create",
  "invitation.revoke",
  "settings.platform.update",
  "settings.update",
  "key.revoke_admin",
  "api_key.revoke_admin",
  "api.manage_own",
  "key.manage_own",
  "logs.read_own",
  "overview.read",
]

const ADMIN_ACTIONS = ACTIONS.filter((action) => !action.endsWith("_own") && action !== "overview.read")

describe("can('owner', …)", () => {
  it.each(ACTIONS.map((action) => [action] as [Action]))(
    "allows %s",
    (action) => {
      expect(can("owner", action)).toBe(true)
    },
  )

  it("allows every action in the table, including ones added later", () => {
    expect(ACTIONS.length).toBeGreaterThanOrEqual(16)
    expect(ACTIONS.every((action) => can("owner", action))).toBe(true)
  })
})

describe("can('user', …)", () => {
  it.each(["api.manage_own", "key.manage_own", "logs.read_own", "overview.read"] as Action[])(
    "allows %s",
    (action) => {
      expect(can("user", action)).toBe(true)
    },
  )

  it.each(ADMIN_ACTIONS.map((action) => [action] as [Action]))(
    "denies %s",
    (action) => {
      expect(can("user", action)).toBe(false)
    },
  )

  it("denies the privilege-escalation and admin verbs the contract reserves for owners", () => {
    const denied: Action[] = [
      "user.disable",
      "user.promote",
      "invitation.create",
      "settings.platform.update",
      "user.list",
      "user.read",
      "user.enable",
      "user.demote",
      "invitation.revoke",
      "key.revoke_admin",
      "api_key.revoke_admin",
      "settings.update",
    ]
    for (const action of denied) {
      expect(can("user", action), `user may perform ${action}`).toBe(false)
    }
  })

  it("denies an action that is not in the table", () => {
    expect(can("user", "not.an.action" as Action)).toBe(false)
    expect(can("owner", "not.an.action" as Action)).toBe(false)
  })
})
