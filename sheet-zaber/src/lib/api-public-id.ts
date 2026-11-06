/*
 * The short address of an API: `/api/v1/{name}-{shortId}`, e.g. `test123-a1b2c`.
 *
 * Only the last five characters identify the API. The name is decoration, so renaming an API leaves
 * every old URL working. Pure and browser-safe. The API key, not this id, is what protects an API.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const SHORT_ID_LENGTH = 5
const MAX_SLUG_LENGTH = 40
const PUBLIC_ID = new RegExp(`^(?:.*-)?([a-z0-9]{${SHORT_ID_LENGTH}})$`)

export function generateShortId(): string {
  let id = ""
  while (id.length < SHORT_ID_LENGTH) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1))
    // 252 is the largest multiple of 36 that fits a byte; anything above it would bias the result.
    if (byte < 252) id += ALPHABET[byte % ALPHABET.length]
  }
  return id
}

/** A name with no usable characters yields the bare short id. */
export function apiPublicId(name: string, shortId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "")
  return slug === "" ? shortId : `${slug}-${shortId}`
}

/** The short id inside a URL segment, or null. A uuid never matches: its last group is 12 characters. */
export function shortIdFromPublicId(segment: string): string | null {
  return PUBLIC_ID.exec(segment)?.[1] ?? null
}
