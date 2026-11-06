import "server-only"

import { eq } from "drizzle-orm"
import { redirect } from "next/navigation"

import { db } from "@/server/db/client"
import { users } from "@/server/db/schema"

import { SESSION_COOKIE, verifySession, type SessionRole } from "./session"

export type AuthenticatedUser = { id: string; email: string; role: SessionRole }

function tokenFromCookieHeader(header: string | null): string | null {
  if (!header) return null
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=")
    if (separator === -1) continue
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE) continue
    const value = pair.slice(separator + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}

async function readToken(req?: Request): Promise<string | null> {
  const fromRequest = tokenFromCookieHeader(req?.headers.get("cookie") ?? null)
  if (fromRequest) return fromRequest

  try {
    const { cookies } = await import("next/headers")
    const store = await cookies()
    return store.get(SESSION_COOKIE)?.value ?? null
  } catch {
    // Outside a request context (scripts, plain-node workers) there is no cookie store.
    return null
  }
}

async function loadSession(req?: Request): Promise<AuthenticatedUser | null> {
  const payload = verifySession(await readToken(req))
  if (!payload) return null

  const [row] = await db
    .select({ id: users.id, email: users.email, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, payload.uid))
    .limit(1)

  if (!row || row.status !== "active") return null

  // The DB role wins over the cookie role, so a signed cookie claiming `owner`
  // on a `user` row cannot escalate (`security.md` §3 item 5).
  if (row.role === "owner") return { id: row.id, email: row.email, role: "owner" }
  if (row.role === "user") return { id: row.id, email: row.email, role: "user" }
  return null
}

export async function readUser(req?: Request): Promise<AuthenticatedUser | null> {
  return loadSession(req)
}

export async function readOwner(req?: Request): Promise<AuthenticatedUser | null> {
  const user = await loadSession(req)
  return user?.role === "owner" ? user : null
}

export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await loadSession()
  if (!user) redirect("/login")
  return user
}

export async function requireOwner(): Promise<AuthenticatedUser> {
  const user = await loadSession()
  if (!user) redirect("/login")
  if (user.role !== "owner") redirect("/overview")
  return user
}
