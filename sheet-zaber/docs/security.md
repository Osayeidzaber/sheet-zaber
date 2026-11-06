# Sheet Zaber — Security Design

Threat model first, then every mitigation from the brief (§17) mapped to its implementation
and its test. "Users must never be able to…" requirements are treated as acceptance tests,
not aspirations.

## 1. Trust boundaries

1. **Public internet → `/api/v1`** — fully untrusted. Only a valid Bearer key opens anything.
2. **Browser → dashboard/internal API** — semi-trusted: signed session cookie + SameSite +
   per-route guards; all mutations are server actions that re-verify.
3. **App → Google** — outbound only; per-user tokens; least scope.
4. **App → Postgres** — single pooled TLS connection, secrets in env only.
5. **Owner vs user** — role column set only by server code paths (bootstrap/login), never
   from request input.

## 2. Mitigation matrix (brief §17 → implementation → test)

| Requirement | Implementation | Verified by |
|---|---|---|
| Secure Google OAuth | Authorization-code + PKCE(S256); `state` bound to signed httpOnly nonce cookie; ID token verified (`iss`, `aud`, `exp`, `nonce`, `email_verified`) via `google-auth-library`; no implicit flow, no client-side token parsing | unit: forged/expired/wrong-aud ID tokens rejected; e2e: full login |
| Verified user identity | Identity anchored on `google_sub` (unique); email taken only from verified token | unit: duplicate sub → same user; different sub same email → rejected as conflict, manual owner action |
| Secure session management | HMAC-SHA256 signed cookie, `HttpOnly; Secure; SameSite=Lax; Path=/`, 7-day exp, payload `{uid, role, exp}`; constant-time compare; re-validated against DB (`users.status`, `role`) on every guarded request → disable takes effect immediately | unit: tampered cookie rejected; test: disabled user mid-session gets 403 next request |
| Invitation validation server-side | Redemption is one atomic conditional UPDATE inside the registration transaction; frontend only transports the code | integration: concurrent redemptions of a `max_uses=1` code → exactly one winner |
| Hashed invitation codes | SHA-256 at generation; plaintext returned once; DB stores only hash; lookup by hash index | unit: no plaintext anywhere in DB rows/logs |
| Hashed API keys | `sz_live_` + 128-bit `crypto.randomBytes(16).toString('hex')`; SHA-256 stored; preview = first 10 + last 4 chars; plaintext once | unit + integration: revoked key → 401; hash collision surface negligible |
| Encrypted refresh tokens | AES-256-GCM, `TOKEN_ENCRYPTION_KEY` (32 bytes from env), random 12-byte IV per encryption, auth-tag verified on decrypt; failure → `reauth_required`, never crash | unit: tampered ciphertext rejected |
| Server-side authorization | Guards (`requireUser/requireOwner/requireKeyOwner`) in every server action and internal route; engine refuses cross-user key↔API pairs structurally | integration: user A key on user B api → 403/404 identical to unknown api (no oracle) |
| Role-based permissions | `can(role, action)` table; role only mutated by owner actions + bootstrap, each audited | test: regular user hitting every admin route → 403 + audit entry |
| Database access controls | RLS enabled, zero policies; it blocks non-owner roles only. The app connects as the table owner, which bypasses RLS, so tenant isolation is enforced in the application layer; anon key useless; Supabase dashboard access restricted to the owner account | documented + checked in Phase 7 checklist |
| Rate limiting | `/api/v1`: per-key fixed windows (hour/day) in `rate_limit_buckets`; auth/invitation endpoints: in-memory token bucket (5 per 15 min); Google-side 429 passed through as 503 | integration: N+1th request → 429 + Retry-After |
| Input validation | zod on every action/route body & query; A1-range regex + bounds; column names must exist in header snapshot; JSON body ≤1 MB; arrays ≤500 records | unit: fuzz table of malformed inputs → 4xx, never 5xx |
| Request size limits | `serverActions.bodySizeLimit: 1mb`; route handler manual check for `/api/v1` POST | test: 1.1 MB body → 413 |
| No cross-user spreadsheet access | Engine path always: key → key.user → api.user equality → api's connection → that user's Google token. There is no code path accepting a user-supplied connection/token | integration test matrix |
| CSRF | SameSite=Lax cookies + mutations only via POST server actions / same-origin fetch; no cookie-auth GET mutations; OAuth `state` prevents login-CSRF | documented; Playwright cross-origin form test rejected |
| Secure cookie settings | as above + `__Host-` prefix in production (`__Host-sz_session`) | unit: prefix enforced when NODE_ENV=production |
| Audit logging | `audit_logs` for: user disable/enable, role change, invitation create/revoke, platform settings, owner bootstrap, admin key revocation; actor+subject+detail, never secrets | integration: each admin action writes a row |
| Brute-force invitation protection | entropy (~40 bits, 8 Crockford base32 characters) + attempt bucket + generic error message (no "exists but expired" oracle) | unit: 6th attempt → 429 |
| Proper error handling | Canonical envelope (§API_SPEC 1.2); internal errors log server-side with request id, return `internal_error` only; stack traces never serialized to clients | unit: thrown Error → 500 envelope without message leak |
| Secrets never in logs | Logger redacts `authorization`, `cookie`, `key`, `token` fields; request logs schema has no such columns at all | code review + unit on redactor |

## 3. "Users must never be able to…" — explicit test list

Each becomes a named integration test (spec §18):

1. Read another user's Google tokens → no SELECT path exists; connection queries always
   scoped `WHERE user_id = session/key owner` (test: direct service call with wrong user → null).
2. Access another user's spreadsheets/APIs → cross-pair 403/404 (test matrix over all verbs).
3. View another user's API keys → keys list scoped by user; plaintext never retrievable by
   anyone after creation (only hash stored).
4. Modify another user's API configurations → guards + ownership WHERE clauses; test every
   mutation action with a foreign id → not-found.
5. Escalate privileges → role never read from request body/cookie payload (cookie role is
   cross-checked against DB each request); test: hand-crafted cookie with `role=owner` but
   DB says `user` → treated as user; test: `promoteUser` called by non-owner → 403 + audit.
6. Bypass invitations → new Google account without valid code gets pending-registration
   state only; every registration INSERT requires a redemption row in the same transaction.

## 4. Data minimization & privacy

- No spreadsheet cell contents in logs, analytics, or error messages (only structural
  metadata: tab titles, header names — user-owned data they registered themselves).
- Playground proxies server-side; the selected key's plaintext is never sent to the browser
  after creation (proxy injects it from DB by keyId).
- Google avatar URLs stored, not the images.
- Log retention default 90 days, owner-configurable, pruned by script.

## 5. Operational security

- Env secrets: `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_SECRET`,
  `DATABASE_URL` — Render + `.env.local` only; `.env.example` carries empty placeholders;
  `scripts/make-env-keys.ts` generates the two random keys; nothing `NEXT_PUBLIC_` except
  the site URL.
- Security headers on every response (mirroring host repo): CSP (`default-src 'self'`,
  `connect-src 'self'`, `img-src 'self' data: https://lh3.googleusercontent.com https:`),
  `X-Frame-Options DENY`, `frame-ancestors 'none'`, `nosniff`, HSTS, Referrer-Policy
  `strict-origin-when-cross-origin`, Permissions-Policy minimal.
- Dependencies: `pnpm audit` in Phase 6 gate; no unpinned wildcard deps.
- Key rotation story: rotating `TOKEN_ENCRYPTION_KEY` invalidates all connections →
  documented re-consent procedure; rotating `SESSION_SECRET` logs everyone out (acceptable).

## 6. Known residual risks (accepted, documented)

| Risk | Why accepted | Mitigation in place |
|---|---|---|
| Sheets has no conditional row update → resolve/write race | Google API limitation | 409 on ambiguity; last-write-wins documented |
| Fixed-window rate limit can burst 2× at window edges | Simplicity vs Redis vendor | Windows are small; Upstash upgrade path documented |
| In-memory buckets reset across serverless instances | Render functions are ephemeral | DB-backed limits for `/api/v1` (the important surface); memory bucket only guards low-volume auth endpoints |
| Testing-mode 7-day token expiry until verification exemption granted | Google policy | Graceful `reauth_required` flow + banner; exemption application in README |
| Single region Supabase free tier | Scale | Fine for ≤100 users; migration path = any Postgres (Drizzle is portable) |
