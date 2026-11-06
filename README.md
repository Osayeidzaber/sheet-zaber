# Sheet Zaber

![Sheet Zaber wordmark](sheet-zaber/docs/readme-cover.svg)

A private, invitation-only platform that turns one tab of a Google Sheet into a REST API. People sign in with Google, redeem an invitation, register a sheet, and call it with an API key. It is one Next.js 16 app with Postgres and Drizzle behind it. Your rows stay in Google Sheets; only account, configuration and log metadata is stored.

> This repository holds the code running Sheet Zaber. It is not packaged as a general self-hosted product, and no license is granted (see [License](#license)).

## Features

| Area | What's included |
| --- | --- |
| REST API | List, filter, search, sort and paginate; single-record read, create, update, replace and delete by primary key; raw A1 ranges; a choice of which columns each endpoint exposes |
| Access | Google sign-in, invitation codes, owner and user roles, API keys with read/write scopes, endpoint restrictions and expiry |
| Limits | Per-account daily quotas plus hourly, per-key and per-IP windows, all stored in Postgres |
| Dashboard | Overview, spreadsheets, endpoints, keys, playground with cURL/JS/Python snippets, request logs, analytics, settings |
| Admin | Accounts, roles, daily limits and deletion; invitation codes, invite by email and redemption history; platform totals |
| Security | Keys and codes stored only as hashes, refresh tokens encrypted with AES-256-GCM, sessions re-checked on every request, audit log |

## Quick start

To run it locally (Node.js 22 and pnpm; Docker isn't needed):

```sh
cd sheet-zaber
pnpm install
cp .env.example .env.local
pnpm make-keys
pnpm db:local      # terminal 1: Postgres on port 5433
pnpm db:deploy     # terminal 2: apply migrations
pnpm dev           # http://localhost:3001
```

Set `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/sheet_zaber` and `OWNER_EMAIL` in `.env.local` before running migrations. Signing in needs a Google OAuth client; see [GOOGLE_OAUTH_SETUP.md](sheet-zaber/GOOGLE_OAUTH_SETUP.md).

## Using the API

```sh
curl https://sheet.zaber.tech/api/v1/<api-id> \
  -H "Authorization: Bearer sz_live_..."
```

Responses are `{ data, meta }` on success and `{ error: { code, message, category } }` on failure. Full details are on the site's `/docs` pages and in the [API contract](sheet-zaber/docs/backend-api-contract.md).

## Commands

Run these from `sheet-zaber/`.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on port 3001 |
| `pnpm build` · `pnpm start` | Production build and server |
| `pnpm typecheck` · `pnpm lint` | Static checks |
| `pnpm test` | Unit and integration tests; starts its own temporary Postgres |
| `pnpm test:e2e` | Browser tests; needs `pnpm build` and `pnpm db:local` first |
| `pnpm smoke` | HTTP checks against a production server; needs the same two |
| `pnpm db:generate` | Create a migration after changing the schema |
| `pnpm db:deploy` | Apply migrations, verifying TLS on remote databases |
| `pnpm db:prune` | Delete request logs past `LOG_RETENTION_DAYS` and old rate counters |

Browser and smoke tests use throwaway databases and never call Google.

## Repository layout

```text
render.yaml            Render services: the web app and the nightly log cleanup
sheet-zaber/
  src/app/             Pages and routes: marketing, dashboard, admin, /auth, /api
  src/server/          Services, API engine, Google client, database queries
  src/components/      UI components
  src/lib/             Helpers shared with the browser
  drizzle/             SQL migrations
  scripts/             Migrate, prune, local database, key generator, smoke test
  tests/ · e2e/        Vitest and Playwright tests
  docs/                Architecture, API contract, security, legal text
```

## Deployment

Production runs on Render from [render.yaml](render.yaml). Each deploy builds the app, applies migrations, then starts it; a failed migration stops the release. Follow [the deployment guide](sheet-zaber/docs/deployment-render.md), including its checks after the first deploy.

While the Google consent screen is in **Testing**, only listed test users can sign in and their refresh tokens expire after 7 days. For lasting connections, publish the app or apply for the personal-use exemption.

## Documentation

| Guide | Covers |
| --- | --- |
| [deployment-render.md](sheet-zaber/docs/deployment-render.md) | Deploying to Render and checking the result |
| [backend-api-contract.md](sheet-zaber/docs/backend-api-contract.md) | Public and internal APIs, errors and limits |
| [architecture.md](sheet-zaber/docs/architecture.md) · [database-schema.md](sheet-zaber/docs/database-schema.md) | How the app fits together and what it stores |
| [authentication-flow.md](sheet-zaber/docs/authentication-flow.md) · [google-integration.md](sheet-zaber/docs/google-integration.md) | Sign-in, sessions, invitations and Google tokens |
| [security.md](sheet-zaber/docs/security.md) | Threat model and mitigations |
| [privacy-policy.md](sheet-zaber/docs/legal/privacy-policy.md) · [terms-of-service.md](sheet-zaber/docs/legal/terms-of-service.md) | Source text of the site's legal pages |

## License

No license is granted; all rights are reserved by the owner. Third-party packages keep their own licenses.
