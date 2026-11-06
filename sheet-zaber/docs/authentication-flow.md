# Sheet Zaber — Authentication & Access Control

Extracted from `architecture.md` §4–§5 so the sign-in, session and role material has one home the
dashboard, the internal API and the tests can all cite. `architecture.md` keeps the topology and the
enforcement-layer table; this document keeps the flows and the rules. Threat mitigations and their
tests live in `security.md`; the backend↔frontend call signatures live in
`backend-api-contract.md` §4.

## 1. Sign-in / registration

```
GET /auth/google          → 302 Google consent (state=HMAC nonce cookie, PKCE S256,
                             scope: openid email profile …/auth/spreadsheets,
                             access_type=offline, prompt=consent on first connect)
GET /auth/google/callback → exchange code; VERIFY ID token (iss/aud/exp/nonce)
  ├─ email verified? no → /login?error=email_unverified
  ├─ users row exists?
  │    ├─ yes, status=active   → set session cookie → /overview
  │    ├─ yes, status=disabled → /login?error=disabled (no session, no re-activation by login)
  │    └─ no → /login?step=invitation (Google identity held in short-lived signed
  │            "pending-registration" cookie `sz_pending`, 10 min)
  └─ invitation submit → server validates hash, expiry, uses, revoked
       → atomic redeem (UPDATE … SET uses=uses+1 WHERE uses<max_uses AND …)
       → create user (role='user'; role='owner' iff email==OWNER_EMAIL)
       → store google_connection (encrypted refresh token)
       → insert invitation_redemptions + audit_logs → session cookie → /overview
```

The pending-registration cookie means the invitation step never re-triggers Google consent, and the
code is validated only server-side against the `sz_pending` email binding — the browser never
carries an authorization decision.

`sz_pending` contents: `{ email, name, picture, sub, exp }` plus the **AES-256-GCM-encrypted**
Google tokens. It is signed, 10-minute-lived, `HttpOnly`, and it is *not* a session: every guarded
code path ignores it, and only `POST /auth/invitation` consumes it.

When `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are absent (local dev before configuration),
`/auth/google` does not crash: it renders/redirects to `/login?error=oauth_not_configured` and the
login screen shows the "Google OAuth not configured" state.

## 2. Sessions

HMAC-SHA256 signed cookie `sz_session` (mirrors the portfolio's `lib/auth/session.ts` doctrine):
`payload = { uid, role, exp }`, `value = base64url(JSON payload) + "." + base64url(HMAC)`, signed
with `SESSION_SECRET`.

| Attribute | Value |
|---|---|
| name | `sz_session` in development, `__Host-sz_session` when `NODE_ENV=production` |
| flags | `HttpOnly; SameSite=Lax; Path=/` + `Secure` in production |
| lifetime | `Max-Age=604800` (7 days), `exp` claim checked on every verify |
| rotation | re-signed on login, on invitation redemption, and on any privilege change |

Two rules the implementation must not bend:

1. **`verifySession()` authenticates the signature only.** It returns the payload or `null`
   (constant-time compare, `exp` check). It does not know about the database.
2. **`requireUser()` / `readUser()` are the security boundary.** They reload the `users` row on
   every call, fail unless `status='active'`, and return the **DB** role — never the cookie role.
   So disabling or demoting a user takes effect on their next request, and a hand-crafted cookie
   claiming `role:'owner'` for a `user` row cannot escalate. See `security.md` §3 items 5–6.

Guard surface (exact names, so `proxy.ts` and every page can rely on them):

| export | caller | behaviour when unauthenticated |
|---|---|---|
| `requireUser()` | server components / layouts | `redirect("/login")` |
| `requireOwner()` | `(app)/admin/layout.tsx` | `redirect("/overview")` for a valid non-owner |
| `readUser(req?)` | route handlers, server actions | `null` — never redirects |
| `readOwner(req?)` | admin route handlers | `null` unless the DB row says `owner` |

The split exists because a guard that both redirects and returns `null` would turn a missing session
into a 500 inside a route handler.

## 3. Authorization model (RBAC)

Two roles today (`user`, `owner`), a string column, and one central `can(role, action)` table in
`src/server/auth/rbac.ts` so a third role is additive rather than a hunt through call sites.

| Layer | Mechanism |
|---|---|
| Pages | `(app)` layout calls `requireUser()`; `admin/` layout calls `requireOwner()` (server components; redirect is UX) |
| Internal API | every `/api/internal/*` handler calls `readUser`/`readOwner` first |
| Public API | ownership is structural: a key belongs to a user, an API belongs to the same user, the engine refuses cross-user combinations |
| DB | RLS deny-by-default (no policies); the app connects as table owner — defense in depth, not the primary boundary |

`src/proxy.ts` only redirects for UX. Never trust a frontend check: role and status are re-read from
the database on every guarded request, and `role` is only ever written by server code paths —
first-login bootstrap (`email === OWNER_EMAIL`) and audited owner actions — never from a request body
or a cookie payload.

Every action listed in `database-schema.md`'s `audit_logs.action` set (user disable/enable, role
change, invitation create/revoke, admin key revocation, platform settings, owner bootstrap) writes an
`audit_logs` row with actor, subject and non-secret detail — including the *rejected* attempts, so a
privilege-escalation try is evidence, not silence.

## 4. Invitation lifecycle

| State | Rule |
|---|---|
| created | owner generates N codes (`ZABER-XXXX-XXXX`, Crockford base32, ~40 bits entropy); plaintext is returned once, only the SHA-256 hash is stored |
| redeemed | one atomic conditional `UPDATE` (see `database-schema.md`), then user + profile + connection + redemption + audit rows in the same transaction |
| expired / revoked / exhausted | identical generic user-facing message (`invitation code is not valid`) — no "it exists but expired" oracle |
| brute force | 5 attempts per 15 minutes per pending cookie **and** per IP (in-memory token bucket) → `429` |
| existing user | a second sign-in by the same `google_sub` never asks for a code; `users.google_sub` unique + the partial unique on `email WHERE status <> 'deleted'` make a second account for the same identity impossible |

Owner initialization is deliberately narrow: `OWNER_EMAIL` grants `role='owner'` **at INSERT time
only**, and `scripts/seed-owner.ts` merely promotes an already-signed-in user with that email
(idempotent, no rows created, no demo data).
