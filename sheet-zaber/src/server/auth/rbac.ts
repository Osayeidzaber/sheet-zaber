import "server-only"

import type { SessionRole } from "./session"

export type Action =
  | "user.list"
  | "user.read"
  | "user.disable"
  | "user.enable"
  | "user.promote"
  | "user.demote"
  | "user.delete"
  | "user.limit"
  | "user.invite_permission"
  | "invitation.create"
  | "invitation.revoke"
  | "settings.platform.update"
  | "settings.update"
  | "key.revoke_admin"
  | "api_key.revoke_admin"
  | "api.manage_own"
  | "key.manage_own"
  | "logs.read_own"
  | "overview.read"

/*
 * `authentication-flow.md` §3: the only place role → permission is decided.
 * The `*_own` rows are belt-and-braces — ownership is enforced by `readUser` plus
 * `WHERE user_id = …`; an action absent from this table is denied for everyone.
 */
const TABLE: Record<Action, readonly SessionRole[]> = {
  "user.list": ["owner"],
  "user.read": ["owner"],
  "user.disable": ["owner"],
  "user.enable": ["owner"],
  "user.promote": ["owner"],
  "user.demote": ["owner"],
  "user.delete": ["owner"],
  // `users.api_limit_per_day`: the owner allocates each user's daily API quota (§1.4). Owner-only
  // like its siblings — a `user` row must never be able to raise itself out of a 429.
  "user.limit": ["owner"],
  // A member may also create codes when `users.can_invite` is set; the invitation service checks it.
  "user.invite_permission": ["owner"],
  "invitation.create": ["owner"],
  "invitation.revoke": ["owner"],
  "settings.platform.update": ["owner"],
  "settings.update": ["owner"],
  "key.revoke_admin": ["owner"],
  "api_key.revoke_admin": ["owner"],
  "api.manage_own": ["user", "owner"],
  "key.manage_own": ["user", "owner"],
  "logs.read_own": ["user", "owner"],
  "overview.read": ["user", "owner"],
}

export function can(role: SessionRole, action: Action): boolean {
  return TABLE[action]?.includes(role) ?? false
}
