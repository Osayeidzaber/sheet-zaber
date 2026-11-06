import "server-only"

import { z } from "zod"

/*
 * Single import point for environment configuration (architecture.md §8).
 * Parsed with zod at module load: an invalid or missing required variable
 * fails the boot with a message listing EVERY offender and its issue.
 * Dev degrades gracefully only for GOOGLE_* (login screen shows
 * "Google OAuth not configured") and RESEND_* (invite-by-email answers a typed
 * failure at call time; code minting is unaffected); everything else is mandatory.
 *
 * Tests never need real env vars: they exercise the pure `parseEnv` below,
 * while module-level `env` is `parseEnv(process.env)`.
 */

/** True when `value` is standard base64 decoding to exactly 32 bytes (AES-256 key). */
function isBase64Of32Bytes(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  try {
    // atob (not Buffer) so this stays edge-runtime safe.
    return atob(value).length === 32
  } catch {
    return false
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\/.+/, "must be a postgres:// or postgresql:// URL"),
    // PEM of the database's CA; needed for remote hosts outside Node's default trust store.
    DATABASE_CA_CERT: z.string().min(1).optional(),
    SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
    TOKEN_ENCRYPTION_KEY: z
      .string()
      .refine(isBase64Of32Bytes, "must be base64 encoding exactly 32 bytes"),
    OWNER_EMAIL: z.email("must be a valid email address"),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    NEXT_PUBLIC_SITE_URL: z.url().optional(),
    LOG_RETENTION_DAYS: z.coerce.number().int().default(90),
    // Outbound invitation email (Resend). Optional like GOOGLE_*: absent config must not
    // break boot — `src/server/email/client.ts` turns it into a typed failure at send time.
    // There is deliberately NO default sender: it must be a domain verified in Resend.
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_FROM_EMAIL: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== "production") return
    if (!value.GOOGLE_CLIENT_ID) {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_CLIENT_ID"],
        message: "required in production",
      })
    }
    if (!value.GOOGLE_CLIENT_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_CLIENT_SECRET"],
        message: "required in production",
      })
    }
    if (!value.NEXT_PUBLIC_SITE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_SITE_URL"],
        message: "required in production",
      })
    }
  })

/** Parse raw environment input; throws listing every invalid/missing variable. */
export function parseEnv(input: Record<string, string | undefined>): Env {
  // Empty strings from .env files count as absent so defaults apply.
  const normalized = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value === "" ? undefined : value])
  )
  const result = envSchema.safeParse(normalized)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n")
    throw new Error(`Invalid environment configuration:\n${details}`)
  }
  return Object.freeze({
    ...result.data,
    NEXT_PUBLIC_SITE_URL: result.data.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001",
    googleOAuthConfigured: Boolean(
      result.data.GOOGLE_CLIENT_ID && result.data.GOOGLE_CLIENT_SECRET
    ),
  })
}

export type Env = Readonly<
  z.output<typeof envSchema> & {
    NEXT_PUBLIC_SITE_URL: string
    googleOAuthConfigured: boolean
  }
>

/** Frozen, validated environment — fails fast at module load if invalid. */
export const env: Env = parseEnv(process.env)

/** Derived helper: false in dev without GOOGLE_* (login shows "not configured"). */
export const googleOAuthConfigured: boolean = env.googleOAuthConfigured
