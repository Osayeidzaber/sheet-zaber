# Sheet Zaber — API Specification
> **Exposed columns.** `api_configurations.exposed_columns` is null for every column, or an allowlist of header names. With an allowlist, reads, `fields`, filters, sort and search see only those columns, a write naming a hidden column is `422 header_mismatch`, PUT keeps hidden cells, DELETE still removes the whole row, and `/range/{A1}` answers `403 operation_not_allowed`. The primary key must be exposed.

Two surfaces: the **public data API** (`/api/v1`, Bearer key) and the **internal dashboard
API** (`/api/internal`, session cookie — mostly server actions; JSON routes where a client
component needs them). This document is the contract tests and docs are written against.

---

## 1. Public API — `/api/v1`

Base: `https://sheet.zaber.tech/api/v1`

### 1.1 Authentication

```http
Authorization: Bearer sz_live_<32 hex>
```

- Key must be unrevoked, unexpired, owned by the API's user, scope-compatible with the verb
  (`read` → GET; `write` → POST/PATCH/PUT/DELETE), and — if `allowed_api_ids` is set —
  restricted to those APIs.
- Missing/invalid → `401`; scope or restriction violation → `403`.
- Query-param auth (`?key=`) is **not** supported (leaks into logs/referrers).

### 1.2 Canonical response envelope

Success:
```json
{ "data": <result>, "meta": { "api_id": "…", "count": 12, "limit": null, "offset": 0, "duration_ms": 143 } }
```
Error (all non-2xx):
```json
{ "error": { "code": "record_not_found", "message": "No record with id=42", "category": "not_found" } }
```

| HTTP | `error.code` (examples) | category |
|---|---|---|
| 400 | `validation_failed`, `invalid_range`, `invalid_json` | validation |
| 401 | `missing_key`, `invalid_key` | auth |
| 403 | `key_scope_insufficient`, `key_restricted`, `api_disabled`, `operation_not_allowed`, `write_requires_primary_key` | auth |
| 404 | `api_not_found`, `record_not_found` | not_found |
| 409 | `ambiguous_record` (PK matched >1 row) | validation |
| 413 | `body_too_large` (>1 MB) | validation |
| 422 | `google_sheet_inaccessible`, `tab_not_found`, `header_mismatch` (POST/PATCH/PUT keys not in header) | google/validation |
| 429 | `rate_limited` (+ `Retry-After` header) | rate_limit |
| 503 | `google_reauth_required`, `google_quota_exceeded` | google |
| 500 | `internal_error` (message never leaks internals) | internal |

### 1.3 Operations

Let `{api}` = `api_configurations.id`, header row H, data rows start at H+1.

#### List records — `GET /api/v1/{api}`
Query parameters (all optional):

| param | meaning |
|---|---|
| `limit` (int ≥1, ≤1000) | page size; default: all rows |
| `offset` (int ≥0) | rows to skip (SheetDB-compatible) |
| `page` + `per_page` | alternative pagination (`offset = (page-1)*per_page`); rejected if mixed with `offset` |
| `sort` | `column` or `-column` (desc); repeatable: `sort=a&sort=-b` |
| `fields` / `select` | comma-separated column subset, applied after filtering |
| `q` | shortcut for search across all columns (same as `/search`) |
| any `column=value` | equality filter; repeatable (AND); value comparison is exact, case-sensitive; `column__contains=v`, `column__gt`, `column__gte`, `column__lt`, `column__lte` operators supported |
| `order` | alias of `sort` (SheetDB compat) |

Response `data` = array of record objects. `meta.count` = rows returned; unknown column in
filter/sort → `400 validation_failed`.

#### Single record — `GET /api/v1/{api}/{record}`
`{record}` = primary-key value. The API must have `primary_key_column` configured;
otherwise → `403 operation_not_allowed` (message: set a primary key or use list+filter).
0 matches → 404; >1 → 409. `data` = one object.

#### Search — `GET /api/v1/{api}/search?q=term`
Case-insensitive substring match across all columns; supports `limit/offset/sort/fields`.
Empty `q` → `400`.

#### Range — `GET /api/v1/{api}/range/{A1notation}`
e.g. `range/A1:D20` or `range/Sheet1!A1:D20` (sheet part must match the configured tab).
Returns raw 2-D array under `data.rows` plus `data.headers`. A1 notation validated by regex +
bounds check against tab size; invalid → `400 invalid_range`.

#### Create — `POST /api/v1/{api}`
Body: one object or array of objects (≤500 per request). Keys must exist in the header row
(unknown key → `422 header_mismatch` listing offenders; missing keys allowed → empty cells).
Values stringified for Sheets. Appends after the last non-empty row (`values.append`,
`insertDataOption=INSERT_ROWS`). `201` with `data.created` = count and `data.records`
(echoed objects). Requires `write` scope + `POST ∈ allowed_operations` + `read_write`.

#### Update (merge) — `PATCH /api/v1/{api}/{record}`
Body: partial object. Resolves row via PK at request time; writes only the provided columns
(`values.update` per contiguous span). `data.updated` = 1.

#### Replace — `PUT /api/v1/{api}/{record}`
Body: full object (every header column except PK optional-but-overwritten; omitted columns
are **cleared** — documented divergence from PATCH).

#### Delete — `DELETE /api/v1/{api}/{record}`
Resolves row via PK; `spreadsheets.batchUpdate → deleteDimension` for that single row.
`data.deleted` = 1. Body-bearing deletes rejected (`400`).

#### Limits / batch — `DELETE|PATCH` accept `?where[column]=value` bulk form? **No.** v1 is
single-record only (matches spec §7; avoids destructive bulk surprises).

### 1.4 Rate limits

Default per key: **1000 req/hour, 10000 req/day** (fixed windows, `rate_limit_buckets`);
per-API override `rate_limit_per_hour`. `429` carries `Retry-After` seconds. Limits are
documented in `/docs` and surfaced in the dashboard key UI.

### 1.5 Semantics guarantees (tested)

- Row numbers are never exposed or persisted; `{record}` is always the PK value.
- Concurrent row shifts between resolve and write: last-write-wins, documented; ambiguity
  always 409s, never silently updates two rows.
- Google 401 → single refresh + retry; failure → `503 google_reauth_required`.
- Google quota 429 → `503 google_quota_exceeded` with `Retry-After` passthrough.
- Every request (including 401/404) is logged; logs contain no keys/headers/bodies.

---

## 2. Internal dashboard API — `/api/internal` (session cookie; guards re-checked per route)

Server actions handle most mutations (typed `{ ok, error }` results); JSON routes exist for
the playground, polling, and chart data. RBAC noted per route.

Every `/api/internal/**` route is built with `userRoute`/`ownerRoute` from
`src/server/http/internal-route.ts` (§4.2/§4.4) — the wrapper reads and verifies the session,
re-reads the `users` row (so a disabled user or a demoted role takes effect on the next request
without waiting for the cookie to expire), answers `401 unauthenticated` / `403 forbidden`,
serialises success as `{ data: … }`, maps failure through `statusFor`, and turns a thrown handler
into `500 internal_error`. A route file therefore contains no guard code and no SQL.

### Auth & session
| route | role | notes |
|---|---|---|
| `GET /auth/google` → `GET /auth/google/callback` | public | `authentication-flow.md` §1; `POST /auth/invitation` (pending-registration cookie + code) |
| `POST /auth/logout` | any session | form POST; clears the session cookie. Never a GET. |

### Spreadsheets (user)
| action/route | purpose |
|---|---|
| `registerSpreadsheet(url, connectionId)` | validate via `spreadsheets.get`, snapshot tabs, upsert row |
| `refreshSpreadsheet(id)` | re-fetch metadata/tabs |
| `previewTab(spreadsheetId, tabTitle, headerRow)` | first 10 records + detected headers |
| `removeSpreadsheet(id)` | delete + cascade APIs |
| `GET /api/internal/connections` | list `Connection[]` with `status` — drives the reconnect banner (`reauth_required`). The earlier `…/connections/status` variant is dropped; nothing consumes it. |
| `GET /api/internal/spreadsheets` | `Spreadsheet[]` owned by the session user; `?connection_id=` narrows. Never a `userId` field (§4.6) |
| `reconnectGoogle()` / `disconnectGoogle(connectionId)` | OAuth re-consent / revoke+delete |

### APIs (user)
| action/route | purpose |
|---|---|
| `createApi(input)` / `updateApi(id, input)` / `deleteApi(id)` | config CRUD; zod-validated |
| `toggleApi(id, enabled)` | enable/disable |
| `GET /api/internal/apis` | `ApiConfig[]` owned by the session user; `?spreadsheet_id=` narrows |
| `GET /api/internal/apis/{id}/stats?from&to` | aggregates for detail page |

### Keys (user)
| action/route | purpose |
|---|---|
| `createKey({name, scopes, allowedApiIds, expiresAt})` | returns `{ ...keyMeta, plaintext }` **once** |
| `revokeKey(id)` / `regenerateKey(id)` | regenerate = revoke + create (new plaintext once) |
| `GET /api/internal/keys` | `ApiKeyMeta[]` owned by the session user — `keyPreview` only; `key_hash`, the plaintext and `userId` are projected out before serialization (§4.6) |

### Playground (user)
| route | purpose |
|---|---|
| `POST /api/internal/playground` | body `PlaygroundRequest` → the engine is invoked **in process** with `{kind:"keyId"}` (§4.8), so no plaintext key exists to inject and no loopback HTTP is involved; returns `{ status, durationMs, headers, body }`. Refuses keys not owned by the session user (`invalid_key`). |

### Logs & analytics (user: own; owner: all)
| route | purpose |
|---|---|
| `GET /api/internal/logs?apiId&method&status&from&to&page` | filtered, paginated log rows (own scope enforced server-side) |
| `GET /api/internal/analytics/overview?from&to` | totals: requests, success, failed, by-day series |
| `GET /api/internal/analytics/apis` | per-API request counts + error rates |

### Admin (owner only — every route is an `ownerRoute`)
| action/route | purpose |
|---|---|
| `GET /api/internal/admin/users` | list w/ invite used, status, api count, request totals |
| `setUserStatus(id, 'active'|'disabled')` | immediate effect: session verification re-checks `users.status` on every request (disabled → logout; that user's APIs answer 404 `api_not_found`, the same as an unknown id) |
| `promoteUser(id)` / `demoteUser(id)` | role changes, audited |
| `createInvitations({count, label, maxUses, expiresAt})` | returns plaintext codes **once**; hashes stored |
| `revokeInvitation(id)` | |
| `GET /api/internal/admin/invitations` | list + redemptions (who/when) |
| `GET /api/internal/admin/analytics` | platform totals (users, active, connections, spreadsheets, APIs, requests, error rate) |
| `updatePlatformSettings({defaultRateLimits, logRetentionDays})` | audited — **blocked**: no storage for it yet (§4.10) |

### Brute-force protection (internal)
`POST /auth/invitation` (and every other caller of `redeemInvitation`/`submitInvitation`): max 5
attempts per pending-cookie **and** per IP per 15 min, answered `429` + `Retry-After` +
`fields.retry_after`. Codes have 62 bits of entropy; this stops online guessing UX-wise and
log-noise-wise. Two properties are contract, and both were corrections to the v0.2 text:
the counter is a **DB fixed-window bucket** (`rate_limit_buckets`, `consumeRateBucket`) so it
survives a restart and is shared across instances — not an in-memory token bucket; and it is
consumed **inside the service**, before the code is hashed, so a server action added later over the
same service cannot reach the redemption path unthrottled (`integration-status.md` B9).

---

## 3. Documentation contract

`/docs` pages must render examples that are **generated from this spec's tested behavior**
(shared snippet builders used by playground + docs, unit-tested once). Any change here
requires updating `docs/` pages and the engine tests in the same commit.

---

## 4. Internal contract surfaces

The frozen signatures the dashboard (`src/app/(app)/**`, `(app)/admin/**`, `src/app/login/**`)
and every later backend task import verbatim. Types the browser needs live under `src/lib/**`
(client-importable, side-effect-free — `integration-status.md` Q-B5); everything under
`src/server/**` carries `import "server-only"` and never crosses to the client. A rename of any
name below is a contract change announced in `integration-status.md` before it lands.

### 4.1 Session layer

```ts
// src/server/auth/session.ts
export type SessionRole = "user" | "owner"
export type SessionPayload = { uid: string; role: SessionRole; exp: number }   // exp = unix seconds
export const SESSION_COOKIE: string                 // "sz_session" | "__Host-sz_session" by NODE_ENV
export const SESSION_MAX_AGE_SECONDS = 604800
export function signSession(p: SessionPayload): string
export function verifySession(token: string | null | undefined): SessionPayload | null
export function buildSessionSetHeaders(token: string, maxAgeSeconds?: number): string[]
export function buildClearSessionHeaders(): string[]
```

| symbol | contract callers may rely on |
|---|---|
| `SESSION_COOKIE` | `sz_session` in development, `__Host-sz_session` when `NODE_ENV=production` — the only session cookie name ever read or written (`authentication-flow.md` §2) |
| `signSession` | `base64url(JSON({uid,role,exp}))` + `"."` + `base64url(HMAC-SHA256)` over those exact bytes with `SESSION_SECRET`; key order is canonical |
| `verifySession` | signature + `exp` only, compared with `timingSafeEqualStr`; **no DB access** (rule 1, `authentication-flow.md` §2). Returns `null` for `undefined`/`null` input |
| `buildSessionSetHeaders` | raw `Set-Cookie` values (`HttpOnly; SameSite=Lax; Path=/; Max-Age=…`, plus `Secure` in production) so route handlers and server actions share one source of truth; `maxAgeSeconds` defaults to `SESSION_MAX_AGE_SECONDS` |
| `buildClearSessionHeaders` | `Max-Age=0` clear of `SESSION_COOKIE` with the same attributes; used by the form POST to `/auth/logout` (`integration-status.md` B3) — never a GET |

### 4.2 Guards

```ts
// src/server/auth/guards.ts
export type AuthenticatedUser = { id: string; email: string; role: SessionRole }
export function requireUser(): Promise<AuthenticatedUser>      // server components; redirect("/login")
export function requireOwner(): Promise<AuthenticatedUser>     // admin layouts; redirect("/overview") for a valid non-owner
export function readUser(req?: Request): Promise<AuthenticatedUser | null>   // routes/actions; never redirects
export function readOwner(req?: Request): Promise<AuthenticatedUser | null>
```

| guard | behaviour |
|---|---|
| `requireUser` | verify cookie → reload the `users` row → require `status='active'` → return the **DB** `role`, never the cookie role; `redirect("/login")` on any failure |
| `requireOwner` | same, and `redirect("/overview")` for a valid non-owner session (`authentication-flow.md` §2 guard table) |
| `readUser` | identical checks, `null` instead of a redirect — a guard that both redirects and returns `null` would 500 inside a route handler |
| `readOwner` | `null` unless the reloaded `users` row says `role='owner'` |
| token source | order is fixed: the `Cookie` header of a passed `req` first, then Next's async `cookies()` |

`AuthenticatedUser.id` is `users.id`; `email` is `users.email`. `status` and `googleSub` are
deliberately absent — status is enforced, not carried, and the identity anchor stays server-side.

### 4.3 RBAC

```ts
// src/server/auth/rbac.ts
export type Action =
  | "user.read" | "user.disable" | "user.enable" | "user.promote" | "user.demote"
  | "invitation.create" | "invitation.revoke"
  | "api_key.revoke_admin"
  | "settings.update"
  | "overview.read"
export function can(role: SessionRole, action: Action): boolean
```

| rule | contract |
|---|---|
| membership | `can("owner", *)` is true for every `Action`; `can("user", *)` is true for `"overview.read"` only |
| what is *not* here | ownership-scoped user verbs (`createApi`, `createKey`, `registerSpreadsheet`, …) are not RBAC actions — they are guarded by `readUser` + `WHERE user_id = …`, never by `can()` |
| audit vs action | `owner.bootstrap` is an `audit_logs.action` value (`schema.ts`) but not a guarded verb — it happens at INSERT, so `can()` never sees it. The other direction also holds: of `user.promote`, `user.demote`, `user.read` and `overview.read`, only promote/demote write an audit row (role change, `security.md` §2) |
| third role | adding a role means adding rows to this table, not editing call sites (`authentication-flow.md` §3) |

### 4.4 Result envelope and internal error codes

```ts
// src/lib/action-result.ts (client-importable; no DB, no env, no server-only)
export type ErrorCategory = "auth" | "rate_limit" | "validation" | "google" | "not_found" | "internal"
export type ActionError = {
  /**
   * TYPE-only discriminant so `result.ok === true` narrows the union at compile time. `fail()`
   * never assigns it, so the wire body stays exactly `{ error: { … } }` (§1.2). The
   * authoritative runtime test is `isActionError`, not this field.
   */
  ok?: false
  error: {
    code: string
    message: string
    category: ErrorCategory
    fields?: Record<string, string>
  }
}
export type ActionResult<T> = { ok: true; data: T } | ActionError
export const CATEGORY_STATUS: Record<ErrorCategory, number>
export function ok<T>(data: T): { ok: true; data: T }
export function fail(code: string, message: string, category: ErrorCategory, fields?: Record<string, string>): ActionError
export function isActionError(result: object): result is ActionError
export function internalError(): ActionError
export function statusFor(result: ActionError): number
```

| rule | contract |
|---|---|
| reuse | `category` + `code` is the same pair §1.2 defines for the public API; an internal failure uses an existing code when one fits, and a new code only when none does |
| severity | **derived**, never stored: the UI computes it from `statusCode` + `errorCategory` (log rows) or `error.category` (actions). There is no `level` field and none will be added (`integration-status.md` R2) |
| `fields` | keyed by the zod path (`name`, `headerRow`, …) → the field's message; zod definitions live in `src/lib/schemas.ts` (Q-B5). Two non-validation uses are contract: `rate_limited` carries `fields.retry_after` (seconds, stringified) so both a route (`Retry-After`) and an action (a countdown) read one value, and `pending_expired` carries nothing — the fix is a round trip to `/auth/google` |
| messages | user-safe; never contain SQL, stack traces, tokens, keys, cell contents or another user's data |
| JSON route statuses | `src/server/http/internal-route.ts` maps category → HTTP via `statusFor`: `validation` 400, `auth` 401, `not_found` 404, `rate_limit` 429, `google` 503, `internal` 500 — **with one carve-out**: code `forbidden` (category `auth`) is answered `403`, because 401 would tell a caller their cookie is broken when it is valid and merely insufficient. Server actions return the object and carry no status |
| success serialization | an internal JSON route returns `{ data: … }` — the success arm of `ActionResult` minus the `ok` discriminant, which is a compile-time marker and never a wire field. A public `/api/v1` success returns `{ data, meta }` (§1.2); the two are not interchangeable |
| throw policy | a route handler that throws is answered `500 internal_error` by the wrapper after logging the message server-side; the cause is never serialized into the body (`internalError()` has no detail field by design) |

| internal code | category | meaning |
|---|---|---|
| `validation_failed` | validation | action/route input rejected by zod; `fields` carries the per-field messages (§1.2) |
| `unauthenticated` | auth | no `sz_session` cookie, or one that fails signature/expiry verification, or one whose user row no longer exists or is `disabled` — emitted by the route wrapper before any handler runs |
| `forbidden` | auth | a **valid** session whose role is not enough for the route (`ownerRoute` on a `user`); answered 403, never 401 |
| `method_not_allowed` | validation | a verb the route does not export; answered 405 with `Allow` |
| `invalid_invitation` | auth | unknown, expired, revoked or exhausted code — the message is byte-identical in all four cases so the route is not an oracle (`authentication-flow.md` §4) |
| `already_registered` | auth | redemption collided with `users.google_sub` UNIQUE or the partial unique on `users.email` (`database-schema.md`) |
| `pending_expired` | auth | `POST /auth/invitation` with a missing, tampered or past-`exp` `sz_pending` cookie; the fix is to re-run `/auth/google`, not to retry the code (v0.2 addition) |
| `rate_limited` | rate_limit | invitation attempt bucket full — 5 per 15 min per pending cookie **and** per IP (§2 brute-force); `fields.retry_after` carries the seconds |
| `invalid_key` | auth | a playground `apiKeyId` that is absent **or** not owned by the session user: one shape for both, no existence oracle (`security.md` §3 item 2) |
| `not_found` | not_found | a mutation id that names no row the session user owns; identical for "does not exist" and "not yours" (`security.md` §3 item 4) |
| `google_reauth_required` | google | the action needs a connection whose `status='reauth_required'` (`google-integration.md` §2) |
| `google_not_connected` | google | the user has **no** `google_connections` row at all — the fix is `/auth/google`, not re-consent. Distinct from `google_reauth_required` for exactly that reason |
| `google_sheet_inaccessible` | google | `spreadsheets.get` 403/404 during register or refresh (`google-integration.md` §3) |
| `google_unavailable` | google | the Google call failed for a reason that is not an auth problem (network, 5xx, quota) — retryable, answered 503 |
| `playground_unreachable` | internal | the engine produced **no** answer for a playground call (§4.8). A fabricated `status: 500` is forbidden; this code is the only acceptable outcome when the handler throws before responding |
| `internal_error` | internal | anything else (§1.2) |

These are the codes the internal surface may emit; `api_not_found`, `invalid_range`, `operation_not_allowed`,
`key_restricted` and `key_scope_insufficient` belong to the public engine (§1) and never appear on
`/api/internal/**`.

### 4.5 Invitations

```ts
// src/server/invitations/service.ts — table invitations (+ invitation_redemptions joined to users.email)
export type InvitationStatus = "active" | "exhausted" | "expired" | "revoked"
export type InvitationRow = {
  id: string                    // invitations.id
  label: string | null          // invitations.label
  maxUses: number               // invitations.max_uses
  uses: number                  // invitations.uses
  expiresAt: Date | null
  revokedAt: Date | null
  createdBy: string             // invitations.created_by (the owner)
  createdAt: Date
  /** derived from revoked_at / expires_at / uses vs max_uses — not a column */
  status: InvitationStatus
  /** invitation_redemptions: who/when, per `GET /api/internal/admin/invitations` */
  redemptions: { redeemedBy: string; email: string; redeemedAt: Date }[]
}
```

Two shapes, and the difference is a layer, not a version: `InvitationListItem` (below, the
repository/service row — exactly the columns `invitations` has, `code_hash` projected out) is what
`createInvitations`/`listInvitations` return today; `InvitationRow` (above, the admin-page payload)
is that plus the two derived members, and only `GET /api/internal/admin/invitations` owes it. The
UI may derive `status` itself from `revokedAt`/`expiresAt`/`uses` vs `maxUses` — that is already
possible from `InvitationListItem` — but it may not derive `redemptions`, which needs the
`invitation_redemptions` join. Neither shape ever carries `invitations.code_hash` or a plaintext
code; the only place a plaintext exists is the return value of `createInvitations`, once.

```ts
// src/server/auth/pending.ts — the decoded sz_pending payload (authentication-flow.md §1)
export type PendingIdentity = {
  sub: string                   // users.google_sub
  email: string                 // users.email (verified)
  name: string | null           // user_profiles.display_name seed
  picture: string | null        // user_profiles.picture_url seed
  exp: number                   // unix seconds; 10-minute life
  refreshToken: string          // decrypted in the cookie; re-encrypted on INSERT
  scope: string                 // google_connections.scope
}
```

```ts
// src/server/invitations/service.ts
export type RedeemResult = { userId: string; email: string; role: SessionRole }

/**
 * `ip` is required, not optional sugar: it is the second throttle dimension (§2). A caller that
 * genuinely cannot see an address says so with `null` rather than omitting the field and being
 * silently unthrottled. Omitting it is a type error by design.
 */
export type RedeemInput = {
  plaintextCode: string
  pending: PendingIdentity | null
  ip: string | null
}

/** Failure-injection seam used by the redemption tests; production passes nothing. */
export type ServiceOptions = { req?: Request; deps?: Partial<RedeemDeps> }

export type CreateInvitationsPayload = {
  codes: string[]                         // the plaintext, returned exactly once
  plaintext: string[]                     // §4.5 alias of `codes`
  invitations: InvitationListItem[]       // hash-stripped rows
}

/** `invitations` minus `code_hash`; `status`/`redemptions` are NOT in this row (see §4.10). */
export type InvitationListItem = {
  id: string
  label: string | null
  maxUses: number
  uses: number
  expiresAt: Date | null
  revokedAt: Date | null
  createdBy: string
  createdAt: Date
}

export function createInvitations(
  input: { count: number; label?: string | null; maxUses?: number; expiresAt?: Date | null },
  actorId: string,
  opts?: ServiceOptions,
): Promise<ActionResult<CreateInvitationsPayload>>

export function redeemInvitation(input: RedeemInput, opts?: ServiceOptions): Promise<ActionResult<RedeemResult>>

/** The `POST /auth/invitation` surface; forwards to `redeemInvitation` unchanged. */
export function submitInvitation(input: RedeemInput, opts?: ServiceOptions): Promise<ActionResult<RedeemResult>>

export function listInvitations(): Promise<ActionResult<InvitationListItem[]>>   // = listInvitationsForOwner
export function revokeInvitation(id: string, actorId: string, opts?: ServiceOptions): Promise<ActionResult<{ id: string }>>

/** The bucket lives in the service, so every reachable surface shares it. Exported for the tests. */
export const ATTEMPT_WINDOW_SECONDS = 900
export const ATTEMPT_LIMIT = 5
export function attemptBucketKeys(ip: string | null, sub: string | null): string[]
```

| surface | contract |
|---|---|
| `createInvitations` | `generateInvitationCode()` → `sha256` stored in `code_hash`, plaintext returned once, `audit_logs` row `invitation.create` with `actorId` |
| `redeemInvitation` | the single conditional `UPDATE … WHERE code_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND uses < max_uses RETURNING id` (`database-schema.md`), inside one transaction that inserts `users`, `user_profiles`, `google_connections`, `invitation_redemptions`, `audit_logs`; `role='owner'` iff `email === OWNER_EMAIL`. The transaction is opened inside the service — callers pass no handle |
| throttle placement | **the attempt bucket is consumed inside `redeemInvitation`, before the code is hashed**, not in the route. `POST /auth/invitation` and any server action over `submitInvitation` are the same surface and get the same 5/15 min per `sz_pending` sub **and** per IP; a caller that consumes only one dimension is a defect, not a shortcut. Both dimensions are checked even when one is already full, and the longest `retryAfterSeconds` wins. The bucket keys are `sha256`-truncated (`invite:ip:<32>:m15`, `invite:sub:<32>:m15`) — never a raw IP or `sub` (`security.md` §2) |
| `listInvitations` | owner-only (`invitation.read` is not an `Action`; the route calls `readOwner`) |
| `revokeInvitation` | sets `invitations.revoked_at`; audited `invitation.revoke`; idempotent — revoking a revoked row is `ok: true` |
| `submitInvitation` | `redeemInvitation` under the §4.5 name, so the route and the frontend action call one thing. The thin `ActionState`/FormData wrapper in `src/app/login/actions.ts` is frontend-owned, adds no logic, **and must pass `ip`** (`integration-status.md` B9) |

### 4.6 Read payloads the dashboard consumes

```ts
// src/server/google/connections.ts — table google_connections (refresh_token_enc and user_id are never exposed)
export type ConnectionStatus = "connected" | "reauth_required" | "disconnected"
export type Connection = {
  id: string
  googleEmail: string           // google_connections.google_email
  scope: string
  status: ConnectionStatus
  connectedAt: Date
  lastUsedAt: Date | null
}
```
Exactly the frontend-visible shape published in `google-integration.md` §6; an empty array means
"never connected", and the reconnect banner is driven by `status === 'reauth_required'`.

```ts
// src/server/spreadsheets/service.ts — table registered_spreadsheets
export type SpreadsheetTab = {
  id: number                    // Google sheet gid
  title: string
  rows: number                  // dimensions captured with the same spreadsheets.get
  columns: number
}
export type SpreadsheetStatus = "active" | "inaccessible"
export type Spreadsheet = {
  id: string
  connectionId: string          // which verified connection reads it
  googleSheetId: string
  title: string
  tabs: SpreadsheetTab[]        // registered_spreadsheets.tabs snapshot
  status: SpreadsheetStatus
  createdAt: Date
  updatedAt: Date
}
```
`tabs` is a **snapshot**, so a header added to the sheet later is invisible until
`refreshSpreadsheetTabs` re-runs (`google-integration.md` §3); `userId` is omitted because every
list is already scoped to the session user.

```ts
// src/server/apis/service.ts — table api_configurations
export type ApiPermissions = "read" | "read_write"
export type ApiConfig = {
  id: string                    // api_configurations.id — the public {api_id}
  spreadsheetId: string
  name: string
  description: string | null
  tabTitle: string
  headerRow: number
  primaryKeyColumn: string | null   // NULL = PATCH/PUT/DELETE refused (D9)
  permissions: ApiPermissions
  allowedOperations: SnippetMethod[]
  enabled: boolean
  rateLimitPerHour: number | null   // NULL = platform default
  createdAt: Date
  updatedAt: Date
}
export type ApiConfigInput = {
  spreadsheetId: string
  name: string
  description?: string
  tabTitle: string
  headerRow: number
  primaryKeyColumn?: string
  permissions: ApiPermissions
  allowedOperations: SnippetMethod[]
  rateLimitPerHour?: number
}
```
`SnippetMethod` (`"GET" | "POST" | "PATCH" | "PUT" | "DELETE"`) is the existing export of
`src/lib/snippets.ts` — there is no second method union. `enabled` is absent from
`ApiConfigInput` because it changes only through `toggleApi`.

```ts
// src/server/keys/api-keys.ts — table api_keys (key_hash is in no payload)
export type ApiKeyScope = "read" | "write"
export type ApiKeyMeta = {
  id: string
  name: string
  keyPreview: string            // "sz_live_ab12…last4" — the only displayable form, ever
  scopes: ApiKeyScope[]         // jsonb: ["read"] or ["read","write"]
  allowedApiIds: string[] | null    // NULL = all of the user's APIs
  expiresAt: Date | null
  revokedAt: Date | null
  lastUsedAt: Date | null       // written at most 1×/minute, so it can lag by up to a minute
  createdAt: Date
}
export type CreatedApiKey = ApiKeyMeta & { plaintext: string }
```
`api_keys` has no `updated_at`, so neither does this payload. `plaintext` exists only on the
return of `createKey`/`regenerateKey` (`security.md` §2 "hashed API keys").

```ts
// src/server/logs/request-log.ts — table api_request_logs
export type LogRow = {
  id: number                    // bigint identity, drizzle mode "number"
  apiId: string | null          // NULL for 404-on-unknown-api
  userId: string | null
  /** the owner's email when served; kept after account deletion until the retention sweep */
  userEmail: string | null
  /** the API's name when served; kept after the API is deleted */
  apiName: string | null
  apiKeyId: string | null       // SET NULL when the key is deleted; NULL for dashboard calls
  method: SnippetMethod
  path: string                  // /api/v1/… — no query strings carrying data
  statusCode: number
  durationMs: number
  requestBytes: number | null
  errorCategory: ErrorCategory | null   // NULL on 2xx
  origin: string | null         // Origin/Referer host only
  createdAt: Date
}
export type LogStatusFilter = "success" | "failed"   // success = statusCode < 400 (§1.2 non-2xx = error)
export type LogQuery = {
  apiId?: string
  method?: SnippetMethod
  status?: LogStatusFilter
  from?: string                 // YYYY-MM-DD; absent = unbounded on that side
  to?: string
  page?: number                 // 1-based
}
export function listLogs(
  session: AuthenticatedUser,
  query: LogQuery,
): Promise<ActionResult<{ rows: LogRow[]; page: number; total: number }>>
```
`LogRow` mirrors the table column-for-column and has **no** header/body/key/token/cell field,
because the table has none (`database-schema.md` §api_request_logs, spec §10). It also has no API
display name: deleting an API deletes its logs today, see §4.10 — do not render a name the row
cannot legitimately join.

```ts
// src/server/logs/analytics.ts — SQL aggregates over api_request_logs; never a hardcoded number
export type OverviewRange = { from?: string; to?: string }   // YYYY-MM-DD; absent = unbounded
export type OverviewDay = { date: string; requests: number; failed: number }
export type Overview = {
  /** exact counts the UI must render unconditionally; never null */
  must: {
    requests: number
    success: number
    failed: number
    series: OverviewDay[]        // ascending by date; [] when the range has no rows
  }
  /** derived from the same query; null when there is nothing to derive — render "—", never 0 */
  nice: {
    avgDurationMs: number | null
    peakDayRequests: number | null
    busiestApi: { apiId: string; requests: number } | null
  }
}
export function getOverview(
  session: AuthenticatedUser,
  range: OverviewRange,
): Promise<ActionResult<Overview>>

export type ApiUsageRow = {
  apiId: string
  name: string                  // api_configurations.name — safe: the join target still exists (§4.10)
  requests: number
  success: number
  failed: number
  errorRate: number             // failed / requests, 0 when requests is 0
  lastRequestAt: Date | null
}
export function getApiUsage(session: AuthenticatedUser): Promise<ActionResult<ApiUsageRow[]>>
```

```ts
// src/server/admin/users.ts — table users + aggregates (owner-only surface)
export type UserStatus = "active" | "disabled"
export type AdminUserRow = {
  id: string
  email: string
  role: SessionRole
  status: UserStatus
  /** users.invitation_id — the row id ONLY: never the plaintext code, never invitations.code_hash */
  invitationId: string | null
  invitationLabel: string | null     // invitations.label, the owner's memo
  apiCount: number                 // COUNT(api_configurations WHERE user_id = users.id)
  requestTotal: number             // COUNT(api_request_logs WHERE user_id = users.id)
  lastLoginAt: Date | null
  createdAt: Date
}
export function listUsers(): Promise<ActionResult<AdminUserRow[]>>
export function setUserStatus(id: string, status: UserStatus, actorId: string): Promise<ActionResult<never>>
export function promoteUser(id: string, actorId: string): Promise<ActionResult<never>>
export function demoteUser(id: string, actorId: string): Promise<ActionResult<never>>
```
`AdminUserRow` is the only admin view of `users`: no `googleSub`, no `invitationRedemptions`
rows, no code and no `code_hash` field may ever be added to it. `demoteUser` refuses the last
owner (`validation_failed` with `fields.role`).

```ts
// src/server/logs/analytics.ts — GET /api/internal/admin/analytics totals (owner-only)
export type PlatformTotals = {
  users: number
  activeUsers: number           // users.status = 'active'
  connections: number           // google_connections rows
  spreadsheets: number          // registered_spreadsheets rows
  apis: number                  // api_configurations rows
  requests: number              // api_request_logs rows
  errorRate: number
}
export function getPlatformTotals(range: OverviewRange): Promise<ActionResult<PlatformTotals>>
```

Route → body for the §2 JSON routes (failures are always `ActionError`):

| route | success body |
|---|---|
| `GET /api/internal/connections` | `{ connections: Connection[] }` |
| `GET /api/internal/logs` | `{ rows: LogRow[]; page: number; total: number }` |
| `GET /api/internal/analytics/overview?from&to` | `Overview` |
| `GET /api/internal/analytics/apis` | `{ apis: ApiUsageRow[] }` |
| `GET /api/internal/apis/{id}/stats?from&to` | `{ overview: Overview; usage: ApiUsageRow }` (both scoped to that `apiId`) |
| `GET /api/internal/admin/users` | `{ users: AdminUserRow[] }` |
| `GET /api/internal/admin/invitations` | `{ invitations: InvitationRow[] }` |
| `GET /api/internal/admin/analytics?from&to` | `PlatformTotals` |

### 4.7 Action signatures (mutations)

```ts
// src/server/spreadsheets/service.ts
export function registerSpreadsheet(input: {
  url: string                   // URL or bare id; normalized in the service
  connectionId: string
}): Promise<ActionResult<{ id: string; title: string; tabs: SpreadsheetTab[] }>>
export function refreshSpreadsheetTabs(id: string): Promise<ActionResult<{ tabs: SpreadsheetTab[] }>>
export function previewTab(
  spreadsheetId: string,
  tabTitle: string,
  headerRow: number,
): Promise<ActionResult<{ headers: string[]; records: Record<string, string>[] }>>
export function removeSpreadsheet(id: string): Promise<ActionResult<never>>
```
`previewTab` returns the detected headers (empty header cells rendered as `column_N`,
`architecture.md` §3) plus the first 10 records. `removeSpreadsheet` cascades the user's APIs
(`api_configurations.spreadsheet_id` is `onDelete: "cascade"`), which is why §4.10 keeps the
log-retention question open.

```ts
// src/server/apis/service.ts — every verb takes the SESSION USER ID LAST; scope is a parameter, never a global
export function createApi(input: unknown, userId: string): Promise<ActionResult<ApiConfig>>
export function updateApi(id: string, input: unknown, userId: string): Promise<ActionResult<ApiConfig>>
export function deleteApi(id: string, userId: string): Promise<ActionResult<never>>
export function toggleApi(id: string, enabled: boolean, userId: string): Promise<ActionResult<never>>
export function getApi(id: string, userId: string): Promise<ActionResult<ApiConfig>>
export function listApis(userId: string): Promise<ActionResult<ApiConfig[]>>
/** The engine's config lookup: no session, because a `/api/v1` caller authenticates with a key. */
export function resolveEngineApi(apiId: string): Promise<EngineApi | null>

// src/server/keys/service.ts
export function listKeys(userId: string): Promise<ActionResult<ApiKeyMeta[]>>
/** The §4.6 wire shape: `ApiKeyMeta` minus `userId`, projected in the SERVICE so no future
 *  consumer can serialize a key list that names its owner. `GET /api/internal/keys` calls this. */
export type KeyListItem = Omit<ApiKeyMeta, "userId">
export function listKeyItems(userId: string): Promise<ActionResult<KeyListItem[]>>
export function createKey(input: unknown, userId: string): Promise<ActionResult<CreatedApiKey>>
export function revokeKey(id: string, userId: string): Promise<ActionResult<never>>
export function regenerateKey(id: string, userId: string): Promise<ActionResult<CreatedApiKey>>
/** §1.1 authentication: `sha256(token)` → row, or `null`. The engine's only key entry point. */
export function authenticateKey(plaintext: string): Promise<EngineKey | null>
export function authorizeKeyCall(/* key, apiId, verb */): ActionError | null
export function markKeyUsed(keyId: string): Promise<void>

// src/server/spreadsheets/service.ts
export function registerSpreadsheet(input: unknown, userId: string, deps?: SheetsDeps): Promise<ActionResult<Spreadsheet>>
export function refreshSpreadsheetTabs(id: string, userId: string, deps?: SheetsDeps): Promise<ActionResult<{ tabs: SpreadsheetTab[] }>>
export function previewTab(input: unknown, userId: string, deps?: SheetsDeps): Promise<ActionResult<TabPreview>>
export function removeSpreadsheet(id: string, userId: string): Promise<ActionResult<never>>
/** `GET /api/internal/spreadsheets`. A pure read: no `SheetsDeps`, no Google call. */
export function listSpreadsheetsForUser(userId: string, connectionId?: string | null): Promise<ActionResult<Spreadsheet[]>>

// src/server/logs/service.ts — the analytics scope is taken from the SESSION, not from a query param
export function toLogQuery(raw: Record<string, string | string[]>): LogQuery
export function listLogs(user: AuthenticatedUser, raw: Record<string, string | string[]>): Promise<ActionResult<LogsPage>>
export function overview(user: AuthenticatedUser, raw: Record<string, string | string[]>): Promise<ActionResult<AnalyticsOverview>>
export function usageByApi(user: AuthenticatedUser): Promise<ActionResult<ApiAnalyticsRow[]>>

// src/server/google/connections.ts
export function listConnections(userId: string): Promise<ActionResult<Connection[]>>
export function disconnectGoogle(connectionId: string, userId: string): Promise<ActionResult<never>>
```
`disconnectGoogle`: the row deletion is what enforces access, the Google `revokeToken()` call is
best-effort and a revoke failure does not fail the action (`google-integration.md` §2).
`reconnectGoogle()` is not a service signature — it is the plain link `/auth/google/connect`
(`google-integration.md` §6).

Two conventions the earlier sketches in this section did not state, now frozen because the
dashboard consumes every one of them:

| convention | why |
|---|---|
| the session user id is an **argument**, last, on every user-scoped verb (`userId: string`), except the logs/analytics verbs that take the whole `AuthenticatedUser` because they derive owner-vs-self scope from `role` | an id in the signature is checkable by the type system and by a test; a session read from a module global is not. `usageByApi`/`listLogs`/`overview` need `role`, so they take the session and call `scopeFor(user)` internally — a `?user_id=` query param can only ever *narrow* an owner's view, never widen a user's |
| `input: unknown` on `createApi`/`updateApi`/`createKey`/`registerSpreadsheet`/`previewTab` | the zod schema in `src/lib/schemas.ts` is the validator and it runs inside the service, so a server action cannot skip it by passing a pre-`string` type. Callers that want compile-time help get it from the schema's inferred type, which the service also accepts |

`updateApi` validates `tabTitle` and `primaryKeyColumn` against the tab snapshot, and refuses a
write verb while `primaryKeyColumn` is unset or `permissions='read'` (§1.2/§1.3).
`regenerateKey` = revoke the old row + insert a new one (never mutate a hash), so history
survives; it returns a fresh `plaintext` once. A spreadsheet verb whose connection is absent fails
with `google_not_connected` before any Google call, and a verb whose connection is
`reauth_required` fails with `google_reauth_required` — the two are different codes because the
user's fix is different (connect vs. re-consent).

### 4.8 Playground contract

```ts
// src/lib/playground.ts (client-importable; no key material in this shape, ever)
export type PlaygroundRequest = {
  apiKeyId: string              // api_keys.id, must be owned by the session user
  method: SnippetMethod
  path: string                  // after /api/v1: "{apiId}" | "{apiId}/{record}" | "{apiId}/search" | "{apiId}/range/A1:D20"
  query?: Record<string, string | string[]>
  headers?: Record<string, string>   // an Authorization header here is ignored, never forwarded
  bodyJson?: string             // raw JSON text as typed; the engine validates it
}
export type PlaygroundResponse = {
  status: number                // the engine's status, verbatim
  durationMs: number
  headers: Record<string, string>
  body: string                  // engine body verbatim (§1.2 envelope on non-2xx)
}
export type PlaygroundResult = ActionResult<PlaygroundResponse>
```

`POST /api/internal/playground` accepts `PlaygroundRequest` and returns `PlaygroundResult`. Three
rules are contract, not implementation detail:

| rule | contract |
|---|---|
| status is verbatim | the engine's status is returned unchanged inside `data`. A 404/409/422/429 from `/api/v1` is an `ok: true` playground result carrying that status; nothing re-maps it to 200 and nothing re-maps it to 500 |
| the plaintext key never reaches the browser | the browser sends `apiKeyId` only — `PlaygroundRequest` has no key field, and the engine resolves the key row server-side by `apiKeyId` + session owner (`{kind:"keyId"}`, below). The only key string the client ever sees is `ApiKeyMeta.keyPreview` (`security.md` §4, `integration-status.md` B5). A foreign or missing `apiKeyId` → `invalid_key` |
| an unreachable engine is an error, not a fake response | if the engine call throws before producing an outcome, the result is `error.code = "playground_unreachable"` (category `internal`). A fabricated `status: 500` is forbidden: `PlaygroundResponse` exists only when the engine actually answered |

### Mechanism: the playground calls the engine **in process** (decided, replaces the open note)

The engine is a function, not a peer service. `src/app/api/internal/playground/route.ts` builds an
`EngineCall` and awaits `handleEngineCall` from `src/server/engine/**`, authenticating with
`{ kind: "keyId", apiKeyId, ownerId: session.userId }` instead of a Bearer string. Consequences:

| consequence | why it is the better answer |
|---|---|
| `api_keys` stays hash-only | the AES-256-GCM "encrypted plaintext copy" option is **rejected**. A recoverable key column means a `TOKEN_ENCRYPTION_KEY` leak plus a DB read mints live `sz_live_` credentials; hash-only means the worst case is one replayed hash lookup. `api_keys` gains no column and the migration stays as committed |
| no loopback HTTP | no self-request, so no port/base-URL config, no second rate-limit round trip through the network stack, and no chance of the playground reaching a *different* deployment than the one holding the session |
| the injected Authorization never exists | `PlaygroundRequest` has no key field, and now there is no key string to inject at all — the only place a plaintext has ever existed is the create-key response (`security.md` §4). The rule "a plaintext key never reaches the browser" is satisfied structurally, not by discipline |
| `{kind:"keyId"}` is indistinguishable from a bad bearer token | a `apiKeyId` that is absent or owned by someone else yields the same `invalid_key`/401 body as a wrong token, so the playground is not an existence oracle for other users' keys (`security.md` §3 item 2). Byte-identical responses for the two arms are an engine test, not a route test |
| `PlaygroundResponse.headers` | `EngineOutcome.headers` minus `content-type`, which the route sets itself; nothing is added or re-derived |
| `PlaygroundResponse.durationMs` | the engine's own measured duration (`meta.duration_ms` in the success envelope), so the playground reports the same number the request log row carries |
| timeout | there is no fetch to abort. A hung Google call is bounded by the transport timeout inside `src/server/google/*`, not by the route (`google-integration.md` §4) |

`src/app/api/v1/[...path]/route.ts` and the playground are two thin adapters over one engine entry
point; the public route uses the `{kind:"bearer"}` arm. Anything the playground can do, a real
client can do, and the two paths are covered by the same engine tests.

### 4.9 Naming resolutions

Where `docs/` already spelled a surface differently, this section is the tie-break and the
divergence is recorded here so nobody re-decides it:

| surface | divergence | frozen as |
|---|---|---|
| `refreshSpreadsheetTabs(id)` | §2 writes `refreshSpreadsheet(id)`; `google-integration.md` §6 writes `refreshSpreadsheetTabs(id)` | `refreshSpreadsheetTabs` (the frontend-visible table is the specific one) |
| `registerSpreadsheet(input)` | §2 writes `registerSpreadsheet(url, connectionId)`; §6 writes `registerSpreadsheet(input)` | object input, zod-validated in `src/lib/schemas.ts` |
| `AdminUserRow` | Plan A Task 7 spells the same row `UserAdminRow` | `AdminUserRow` (published v0.2 name; the plan must follow the contract) |
| `createInvitations` | Plan A Task 6 returns `{ rows, plaintext }` | `ActionResult<{ invitations, plaintext }>` — one envelope shape for every action |
| `revokeInvitation(id, actorId)` | §2 shows one argument | two: the audit row needs the actor, and it must not be inferred from a global |
| `redeemInvitation(input)` | Plan A Task 6 takes an optional transaction handle | none: the service owns its transaction |

### 4.10 Deferred / not in the contract

| surface | why it is not here |
|---|---|
| Google Picker | deferred by the user (2026-11-05). Prerequisites, the three owners and the scope/CSP consequences are recorded in `google-integration.md` §5; the paste → `spreadsheets.get` → snapshot-tab flow in §4.7 is the v1 contract, and nothing in §4 changes when the Picker lands |
| `GET /api/internal/connections/status` | **dropped** in v0.2 (`integration-status.md` version log): `GET /api/internal/connections` returns the same per-connection `status`, and nothing consumes the variant, so no type is published for it |
| Log retention after API deletion | **decided**: `api_id` and `user_id` are `SET NULL`, and `api_name` and `user_email` are snapshotted (migrations 0002 and 0003). Rows expire through `pnpm db:prune`. |
| `updatePlatformSettings({defaultRateLimits, logRetentionDays})` | untypeable as written, and already recorded as an open question in `docs/plan.md`: no platform-settings table exists among the 11 tables, `LOG_RETENTION_DAYS` is an env var (`src/lib/env.ts`), and the only rate-limit column is per-API `api_configurations.rate_limit_per_hour`. The route stays listed in §2; a signature needs a storage decision first |
| `signPendingCookie` / `readPendingCookie` | the payload they carry (`PendingIdentity`, §4.5) is frozen because `redeemInvitation` consumes it; the functions have no consumer outside `/auth/*`, so their exact parameters land with Plan A Task 5 |
| Playground key injection mechanism | **no longer open** — ruled in §4.8: the playground calls `handleEngineCall` in process with `{kind:"keyId"}`, so `api_keys` stays hash-only and no plaintext is ever injected. The row remains here as the record that the encrypted-column option was considered and rejected |
| `InvitationRow.status` / `.redemptions` | the admin list payload in §4.5 is a superset of `InvitationListItem` (the row the service returns today). `status` is derivable by the UI from columns it already receives; `redemptions` needs the `invitation_redemptions` → `users.email` join and ships with the admin invitations route, not before |
