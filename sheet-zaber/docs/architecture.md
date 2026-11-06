# Sheet Zaber — Architecture

## 1. Topology

```
                       ┌──────────────────────────────────────────────┐
 Browser ──────────────▶  Vercel project "sheet-zaber"                │
 API client ───────────▶  Root Directory: sheet-zaber/                │
 (Bearer sz_live_…)      │  https://sheet.zaber.tech                  │
                         │                                            │
                         │  Next.js 16 app (single deployable)        │
                         │  ├─ (marketing) landing, /docs             │
                         │  ├─ (auth)     /login, /auth/google/*      │
                         │  ├─ (app)      dashboard  — cookie session │
                         │  ├─ (admin)    admin pages — role=owner    │
                         │  └─ /api/v1/*  public REST — Bearer key    │
                         └───────┬─────────────────────┬──────────────┘
                                 │ Drizzle (pooled,    │ googleapis
                                 │ 543→6543 TLS)       │ (OAuth2 client,
                                 ▼                     ▼  per-user tokens)
                        Supabase Postgres        Google APIs
                        (RLS deny-by-default)    ├─ oauth2 / openid (identity)
                                                 └─ sheets v4 (data plane)
```

One deployable. Three clearly separated planes inside it:

- **Presentation** — React Server Components + route groups; no business logic in components.
- **Application/domain** — `src/server/**`: services that enforce authorization, invitations,
  API-key checks, spreadsheet operations. All request handlers are thin: parse → service → respond.
- **Data** — Drizzle repositories (`src/server/db/queries/*`) are the only code that touches SQL.

The public REST API never imports session/cookie code; the dashboard never bypasses services.
This is the "clearly separated responsibilities" requirement without a second service.

## 2. Directory layout

```
sheet-zaber/
├── package.json / pnpm-lock.yaml      # standalone; NOT a workspace member
├── next.config.ts                     # security headers, no cacheComponents
├── drizzle.config.ts
├── playwright.config.ts / vitest.config.mts
├── .env.example
├── docs/                              # shared contracts (plan.md, architecture.md,
│   │                                  # database-schema.md, backend-api-contract.md,
│   │                                  # authentication-flow.md, google-integration.md,
│   │                                  # security.md, integration-status.md)
├── GOOGLE_OAUTH_SETUP.md              # user's Google Cloud Console notes (owner: the user)
├── drizzle/                           # generated SQL migrations (committed)
├── scripts/
│   ├── seed-owner.ts                  # idempotent owner bootstrap
│   └── make-env-keys.ts               # prints SESSION_SECRET / TOKEN_ENCRYPTION_KEY
├── e2e/                               # Playwright specs
├── tests/                             # Vitest (unit + integration)
└── src/
    ├── proxy.ts                       # Next 16 middleware: session gate + RBAC redirect (UX only)
    ├── app/
    │   ├── globals.css                # Sheet Zaber design tokens (own palette)
    │   ├── layout.tsx
    │   ├── (marketing)/page.tsx       # landing
    │   ├── docs/…                     # documentation route group
    │   ├── login/page.tsx             # sign-in + invitation screens
    │   ├── auth/google/route.ts       # → redirect to Google consent
    │   ├── auth/google/callback/route.ts
    │   ├── auth/logout/route.ts
    │   ├── (app)/                     # cookie-gated dashboard
    │   │   ├── overview/  spreadsheets/  apis/[apiId]/  playground/
    │   │   ├── keys/  logs/  analytics/  settings/{profile,connections,security,preferences}/
    │   │   └── layout.tsx             # sidebar (permission-adaptive)
    │   ├── (app)/admin/               # role=owner: users/ invitations/ analytics/ settings/
    │   └── api/
    │       ├── health/route.ts
    │       ├── internal/…             # dashboard JSON endpoints (session auth)
    │       └── v1/[…path]/route.ts    # PUBLIC engine: GET/POST/PATCH/PUT/DELETE
    ├── components/                    # ui/ (shadcn), app/ (dashboard), marketing/
    ├── lib/                           # pure helpers: ids, crypto, format, env (zod)
    └── server/                        # server-only (import 'server-only')
        ├── auth/       session.ts (sign/verify cookie), google-oauth.ts, rbac.ts, guards.ts
        ├── invitations/ service.ts (generate, validate, redeem — atomic)
        ├── google/     connections.ts (encrypt/decrypt/refresh), sheets.ts (typed wrappers)
        ├── engine/     resolve.ts (api_id→config), records.ts (CRUD semantics),
        │               query.ts (filter/search/sort/pagination/range), ratelimit.ts
        ├── keys/       api-keys.ts (create/hash/verify/revoke)
        ├── logs/       request-log.ts (write) + analytics.ts (aggregate queries)
        ├── admin/      users.ts, audit.ts
        └── db/         schema.ts (Drizzle), client.ts, queries/*.ts
```

Rule of thumb for placement: if it reads `process.env` secrets or the DB, it lives under
`src/server/` with `import 'server-only'` — mirroring the portfolio's discipline.

## 3. The public API engine (`/api/v1`)

Request lifecycle for every verb:

```
1. Parse   path → { apiId, remainder } ; query params ; JSON body (≤1 MB)
2. Authn   Authorization: Bearer sz_live_… → SHA-256 → lookup hash
           key missing/revoked/expired → 401 ; key scope vs verb → 403
           key.api_restriction (if set) vs apiId → 403
3. Authz   api_configurations.enabled ; caller key owner == api owner (keys are per-user)
4. Rate    sliding-window counters (hour/day) per key → 429 with Retry-After
5. Token   load google_connection for api owner → decrypt refresh token →
           access token (cached in memory ≤50 min) → on 401 from Google: refresh once,
           retry once; refresh failure → 503 { error: "google_reauth_required" }
6. Execute sheets v4 call (read: values.get / batchGet; write: append/update/batchUpdate)
           PK resolution for PATCH/PUT/DELETE: values.get column → unique match → row index
           0 matches → 404 ; >1 matches → 409 { error: "ambiguous_record" }
7. Respond canonical JSON envelope (see backend-api-contract.md §2)
8. Log     insert api_request_logs (async-safe: awaited, but failures never break the
           response; never logs headers/body/keys)
```

**Record identity (D9).** Each API config stores `primary_key_column` (nullable).
PATCH/PUT/DELETE `/api/v1/{id}/{record}` resolve `{record}` by PK value → current row index
at request time. No row numbers are ever stored. Concurrency window between resolve and
write is inherent to Sheets (no conditional updates in the API); the failure mode is
documented (last-write-wins) and mitigated by 409 on ambiguous matches.

**Header row.** `header_row` (1-based, default 1) defines column names; data starts at
`header_row + 1`. Records are objects keyed by header cells; empty header cells become
`column_N`.

## 4. Authentication flows

Split out so the auth contract has one home. See **`authentication-flow.md`**:

- §1 sign-in / registration, including the `?error=` states and the pending-registration cookie
- §2 session cookie format, attributes, and the two validation rules that make disabling
  take effect immediately
- §3 the RBAC table and where each layer enforces it
- §4 invitation lifecycle and the owner bootstrap path

The short version for architecture purposes: identity is anchored on the verified Google `sub`;
registration is gated server-side on an invitation; sessions are HMAC-signed httpOnly cookies
that are re-validated against the database row on every guarded request; `proxy.ts` is UX only.

## 5. Google integration

Also split out. See **`google-integration.md`**: scopes, the refresh-token lifecycle
(AES-256-GCM at rest, access tokens never persisted), the verification boundary for
registered spreadsheets, the exact Sheets calls behind each engine verb, and the Picker
deferred with its prerequisites.

Two architectural constraints live there rather than here, but they shape the topology in §1:
`src/server/google/*` is the only place `googleapis` may be imported, and spreadsheet
registration is verified server-side with the registering user's own connection — a pasted id
or a picker selection is never treated as evidence of access.

## 6. Data plane details

- **Supabase pooled connection**: `postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres`,
  `sslmode=require`, Drizzle `node-postgres` driver, `max: 5` (Vercel function concurrency).
- Migrations: `drizzle-kit generate` → committed SQL → `drizzle-kit migrate` locally and in
  Phase 7 against prod (documented; not auto-run on deploy to keep the portfolio pipeline
  philosophy of explicit control).
- Log volume: `api_request_logs` is append-only, indexed by `(api_id, created_at)` and
  `(user_id, created_at)`; analytics are SQL aggregates, never hardcoded numbers. A
  retention setting (default 90 days) + `scripts/prune-logs.ts` keeps free-tier 500 MB safe.

## 7. Frontend architecture

- Route groups: `(marketing)` public; `(app)` session-gated with adaptive sidebar; `admin`
  nested under `(app)` visible only to owner.
- Server Components fetch via services directly (no client fetch for page data); client
  components only for interactivity (playground, charts, forms). Mutations = server actions
  that re-check session + RBAC and return typed results (`{ ok, error }`), mirroring the
  portfolio's 409/conflict discipline.
- Charts: lightweight SVG components (no chart lib) rendering real aggregates — request
  volume by day, status breakdown. No fake data ever; empty states are designed screens.
- Playground: client component calling the **real** `/api/v1` endpoint through an internal
  proxy route (`/api/internal/playground`) that injects the selected key server-side, so the
  secret never appears in browser JS; response status/time/body rendered verbatim; cURL +
  JS + Python snippet generators are pure functions of the request form (unit-tested).
- Design tokens (own identity, dark-first): base `#050607`, surfaces `#0b0d10`/`#12151a`,
  hairlines `#1e232b`, text `#e8eaed`/`#9aa3af`, accent **signal green `#3ddc84`** used
  only for primary actions/active state, status colors green/amber/red. Fonts: Space Grotesk
  (UI) + JetBrains Mono (code, IDs, tabular data). Motion: `motion` spring presets ≤300 ms,
  `prefers-reduced-motion` respected. 44px touch targets, focus-visible rings, one `h1`/page
  — same accessibility bar as the host repo.

## 8. Environments

| Env | DB | Google OAuth redirect | Notes |
|---|---|---|---|
| local | `pnpm db:local` → `embedded-postgres` PG16, ephemeral port, data in `.pg-local/` | `http://localhost:3001/auth/google/callback` | dev server on 3001 (3000 = portfolio); no Docker on this machine |
| test (vitest integration) | ephemeral `embedded-postgres` instance booted by `tests/helpers/db.ts`, migrations applied per run | n/a (Google API stubbed) | `docker-compose.test.yml` was never created; the helper is the documented path |
| production | Supabase free | `https://sheet.zaber.tech/auth/google/callback` | Vercel project 2 |

Environment validation: `src/lib/env.ts` parses with zod at startup; missing required vars
fail the boot with an exact message (dev degrades gracefully only for `GOOGLE_*`, showing a
"Google OAuth not configured" state on the login screen — everything else is mandatory).

## 9. Deployment

**Superseded: production deploys to Render. Follow `deployment-render.md`.** The Vercel steps below are kept for history.

1. Vercel → Add New Project → same GitHub repo → **Root Directory `sheet-zaber`** →
   framework Next.js → domain `sheet.zaber.tech` (DNS: CNAME `cname.vercel-dns.com`).
2. Env vars: `DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `OWNER_EMAIL`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXT_PUBLIC_SITE_URL=https://sheet.zaber.tech`.
3. `pnpm drizzle-kit migrate` against prod DB; run `scripts/seed-owner.ts`.
4. Google Cloud Console: OAuth client (Web application), authorized redirect URIs for prod
   + localhost:3001; consent screen in Testing with owner + invited users as test users (or
   personal-use exemption application).
5. Live verification: register as owner via invitation, connect Google, register a real
   spreadsheet, create key, exercise every verb from cURL, check logs/analytics.

The portfolio project's settings, domain, and pipeline are never touched; the only shared
surface is the repository itself and the DNS zone (one additive CNAME).
