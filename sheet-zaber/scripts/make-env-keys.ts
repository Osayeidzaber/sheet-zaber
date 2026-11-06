import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/*
 * Generates the two local secrets `src/lib/env.ts` requires and writes them to `.env.local`.
 *
 * `.env.local` (not `.env.example`) is the target because `security.md` "Secrets" keeps the
 * tracked template placeholder-only: a real value in `.env.example` is committed the moment
 * anyone pastes one, and Next.js never reads that file anyway.
 *
 * Existing values are never overwritten. Rotating `SESSION_SECRET` invalidates every session
 * cookie and rotating `TOKEN_ENCRYPTION_KEY` makes stored Google refresh tokens unreadable, so
 * silently replacing them is a data-loss bug, not a convenience. Delete a line to rotate it.
 */

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const envPath = join(rootDir, ".env.local")

/** `>= 32` characters is what `env.ts` asserts for the HMAC key. */
function newSessionSecret(): string {
  return randomBytes(32).toString("hex")
}

/** AES-256-GCM wants exactly 32 bytes; base64 is the shape `tokens.ts` decodes. */
function newTokenEncryptionKey(): string {
  return randomBytes(32).toString("base64")
}

function generated(name: string): string | null {
  if (name === "SESSION_SECRET") return newSessionSecret()
  if (name === "TOKEN_ENCRYPTION_KEY") return newTokenEncryptionKey()
  return null
}

const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
const lines = existing === "" ? [] : existing.split(/\r?\n/)

let changed = false
for (const name of ["SESSION_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
  const index = lines.findIndex((line) => new RegExp(`^${name}=`).test(line))
  const current = index === -1 ? undefined : lines[index].slice(name.length + 1).trim()

  if (current !== undefined && current !== "") {
    console.log(`${name}: kept the existing value`)
    continue
  }
  const value = generated(name)
  if (value === null) continue

  if (index === -1) lines.push(`${name}=${value}`)
  else lines[index] = `${name}=${value}`
  changed = true
  console.log(`${name}: generated`)
}

if (changed || existing === "") {
  writeFileSync(envPath, `${lines.join("\n").trimEnd()}\n`, "utf8")
  console.log(`wrote ${envPath}`)
} else {
  console.log("nothing to do")
}

// The values themselves are deliberately never printed: this runs in a terminal that may be
// recorded, and `security.md` §2 keeps secrets out of logs.
