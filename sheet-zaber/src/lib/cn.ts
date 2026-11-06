/** Class-name joiner. Utilities win over component classes, so overrides need no `!`. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ")
}
