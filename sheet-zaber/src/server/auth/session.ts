import "server-only"

import { createHmac } from "node:crypto"

import { timingSafeEqualStr } from "@/lib/crypto"
import { env } from "@/lib/env"

export type SessionRole = "user" | "owner"
export type SessionPayload = { uid: string; role: SessionRole; exp: number }

const isProduction = process.env.NODE_ENV === "production"

export const SESSION_COOKIE: string = isProduction ? "__Host-sz_session" : "sz_session"
export const SESSION_MAX_AGE_SECONDS = 604800

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const MS_PER_SECOND = 1000

function canonicalJson(payload: SessionPayload): string {
  return JSON.stringify({ uid: payload.uid, role: payload.role, exp: payload.exp })
}

function sign(segment: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(segment, "utf8").digest("base64url")
}

/** Rejects lenient base64url: re-encoding the decoded bytes must reproduce the input. */
function decodeJson(segment: string): string | null {
  if (!BASE64URL_RE.test(segment)) return null
  const decoded = Buffer.from(segment, "base64url")
  if (decoded.toString("base64url") !== segment) return null
  return decoded.toString("utf8")
}

function parsePayload(segment: string): SessionPayload | null {
  const json = decodeJson(segment)
  if (json === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null

  const { uid, role, exp } = parsed as Record<string, unknown>
  if (typeof uid !== "string" || uid.length === 0) return null
  if (role !== "user" && role !== "owner") return null
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null
  return { uid, role, exp }
}

export function signSession(payload: SessionPayload): string {
  const segment = Buffer.from(canonicalJson(payload), "utf8").toString("base64url")
  return `${segment}.${sign(segment)}`
}

/**
 * Signature + `exp` only (`authentication-flow.md` §2 rule 1): the `users` row is
 * re-read by the guards, so this stays a pure, DB-free check.
 */
export function verifySession(token: string | null | undefined): SessionPayload | null {
  if (!token) return null

  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [segment, signature] = parts
  if (!BASE64URL_RE.test(segment) || !BASE64URL_RE.test(signature)) return null
  if (!timingSafeEqualStr(sign(segment), signature)) return null

  const payload = parsePayload(segment)
  if (!payload || payload.exp <= Math.floor(Date.now() / MS_PER_SECOND)) return null
  return payload
}

function attributes(maxAgeSeconds: number): string {
  return [
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    ...(isProduction ? ["Secure"] : []),
  ].join("; ")
}

export function buildSessionSetHeaders(
  token: string,
  maxAgeSeconds: number = SESSION_MAX_AGE_SECONDS
): string[] {
  return [`${SESSION_COOKIE}=${token}; ${attributes(maxAgeSeconds)}`]
}

export function buildClearSessionHeaders(): string[] {
  return [`${SESSION_COOKIE}=; ${attributes(0)}`]
}
