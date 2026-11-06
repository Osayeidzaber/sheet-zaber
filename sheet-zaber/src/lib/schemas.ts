/*
 * Shared zod input schemas (backend-api-contract.md §4.4 `fields`, integration-status.md Q-B5).
 * Client-importable: no DB, no env, no server-only. Server code validates with these and
 * never re-implements a rule locally, so a form and its route cannot drift.
 */

import { z } from "zod"

import type { SnippetMethod } from "./snippets"

export const METHOD_VALUES = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const satisfies readonly SnippetMethod[]

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type PaginationInput = z.input<typeof paginationSchema>

/** Codes are `ZABER-XXXX-XXXX`; the lookup hashes what the user typed, case-insensitively. */
export const invitationCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^ZABER-[0-9A-Z]{4}(-[0-9A-Z]{4})*$/.test(value), {
    message: "invitation code is not valid",
  })

export const createInvitationsSchema = z.object({
  count: z.coerce.number().int().min(1).max(500),
  maxUses: z.coerce.number().int().min(1).max(1000).default(1),
  label: z.string().trim().min(1).max(120).optional(),
  expiresAt: z.coerce.date().optional(),
})
export type CreateInvitationsInput = z.input<typeof createInvitationsSchema>

/** Ceiling for one `inviteUsers` call — a blast-radius limit, not a paging knob. */
export const INVITE_EMAIL_LIMIT = 50

/** Trim + lowercase before the format check: one canonical form per address for dedupe and send. */
export const invitationEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("must be a valid email address"))

export const inviteEmailListSchema = z
  .array(invitationEmailSchema)
  .min(1, "at least one email address is required")
  .max(INVITE_EMAIL_LIMIT, `at most ${INVITE_EMAIL_LIMIT} addresses per call`)
  .refine((list) => new Set(list).size === list.length, "duplicate email addresses are not allowed")

/** `inviteUsers` input: the same memo/limit fields as `createInvitations`, keyed by address. */
export const inviteUsersSchema = z.object({
  emails: inviteEmailListSchema,
  label: z.string().trim().min(1).max(120).optional(),
  // One address, one recipient: single-use is the default here, unlike a raw code mint.
  maxUses: z.coerce.number().int().min(1).max(1000).default(1),
  expiresAt: z.coerce.date().optional(),
})
export type InviteUsersInput = z.input<typeof inviteUsersSchema>

export const registerSpreadsheetSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  connectionId: z.uuid(),
})
export type RegisterSpreadsheetInput = z.output<typeof registerSpreadsheetSchema>

export const apiPermissionsSchema = z.enum(["read", "read_write"])

const apiConfigFields = {
  spreadsheetId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable(),
  tabTitle: z.string().trim().min(1).max(100),
  headerRow: z.coerce.number().int().min(1).max(1000),
  primaryKeyColumn: z.string().trim().min(1).max(100).nullable(),
  // Not trimmed: these must equal the sheet's header keys exactly, and a miss hides the column.
  exposedColumns: z.array(z.string().min(1).max(500)).min(1, "Expose at least one column").max(2000).nullable(),
  permissions: apiPermissionsSchema,
  allowedOperations: z.array(z.enum(METHOD_VALUES)).min(1),
  rateLimitPerHour: z.coerce.number().int().min(1).max(1_000_000).nullable(),
}

export const apiConfigSchema = z.object({
  ...apiConfigFields,
  description: apiConfigFields.description.optional(),
  primaryKeyColumn: apiConfigFields.primaryKeyColumn.optional(),
  exposedColumns: apiConfigFields.exposedColumns.optional(),
  rateLimitPerHour: apiConfigFields.rateLimitPerHour.optional(),
  headerRow: apiConfigFields.headerRow.default(1),
  permissions: apiConfigFields.permissions.default("read"),
  allowedOperations: apiConfigFields.allowedOperations.default(["GET"]),
})
export type ApiConfigFormInput = z.output<typeof apiConfigSchema>

/*
 * PATCH shape: built from the same fields but with NO defaults, because zod replays a
 * default for an absent key — `.partial()` over `apiConfigSchema` would silently rewrite
 * permissions and operations on a name-only patch. Absent means "leave it alone";
 * `null` means "clear it".
 */
export const apiConfigUpdateSchema = z
  .object({
    ...apiConfigFields,
    description: apiConfigFields.description.optional(),
    primaryKeyColumn: apiConfigFields.primaryKeyColumn.optional(),
    exposedColumns: apiConfigFields.exposedColumns.optional(),
    rateLimitPerHour: apiConfigFields.rateLimitPerHour.optional(),
  })
  .partial()
  .extend({
    spreadsheetId: z.uuid().optional(),
    tabTitle: z.string().trim().min(1).max(100).optional(),
  })

export const apiKeyScopeSchema = z.enum(["read", "write"])

export const createKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(apiKeyScopeSchema).min(1).default(["read"]),
  allowedApiIds: z.array(z.uuid()).max(200).nullable().default(null),
  expiresAt: z.coerce.date().optional(),
})
export type CreateKeyInput = z.output<typeof createKeySchema>

/** `Authorization` is accepted but ignored by the proxy — the key is injected server-side. */
export const playgroundRequestSchema = z.object({
  apiKeyId: z.uuid(),
  method: z.enum(METHOD_VALUES),
  path: z.string().trim().min(1).max(512),
  query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bodyJson: z.string().max(1_000_000).optional(),
})
export type PlaygroundFormInput = z.output<typeof playgroundRequestSchema>

export const logQuerySchema = paginationSchema.extend({
  apiId: z.uuid().optional(),
  method: z.enum(METHOD_VALUES).optional(),
  status: z.enum(["success", "failed"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
export type LogQueryInput = z.output<typeof logQuerySchema>

export const rangeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/.test(value), {
    message: "range must look like A1:D20",
  })

export const setUserStatusSchema = z.object({
  id: z.uuid(),
  status: z.enum(["active", "disabled"]),
})

/** Ceiling of `users.api_limit_per_day` — the same 10 000 000 the platform per-day default caps at. */
export const MAX_USER_API_LIMIT_PER_DAY = 10_000_000

/*
 * `users.api_limit_per_day` (§1.4): an integer 0…10_000_000, and **0 means unlimited**.
 *
 * A number OR a numeric string, because an admin form, a query string and a JSON body all reach the
 * same verb — the coercion `paginationSchema` and `rateLimitPerHour` already do. It is NOT written as
 * bare `z.coerce.number()`: `Number("") === 0`, and 0 is "unlimited", so an empty form field would
 * silently grant infinite API calls. An empty (or non-numeric) string therefore fails the check, and
 * the issue path stays on `apiLimitPerDay` so §4.4's `fields` names the right field.
 */
export const apiLimitPerDaySchema = z
  .union([z.number(), z.string().trim().min(1)])
  .transform((value) => Number(value))
  .pipe(z.number().int().min(0).max(MAX_USER_API_LIMIT_PER_DAY))

export const setUserApiLimitSchema = z.object({
  id: z.uuid(),
  apiLimitPerDay: apiLimitPerDaySchema,
})
export type SetUserApiLimitInput = z.input<typeof setUserApiLimitSchema>

export const updatePlatformSettingsSchema = z.object({
  defaultRateLimits: z
    .object({
      perHour: z.coerce.number().int().min(1).max(1_000_000).default(1000),
      perDay: z.coerce.number().int().min(1).max(10_000_000).default(10_000),
    })
    .optional(),
  logRetentionDays: z.coerce.number().int().min(1).max(3650).optional(),
})
