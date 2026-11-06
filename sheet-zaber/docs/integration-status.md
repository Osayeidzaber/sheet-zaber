# Sheet Zaber: integration status

## Ownership

| Area | Paths |
|---|---|
| Services and engine | `src/server/**`, `src/lib/**` |
| Routes | `src/app/api/**`, `src/app/auth/**` |
| Database | `drizzle/**`, `src/server/db/schema.ts` |
| Pages and components | `src/app/(app)/**`, `src/app/(marketing)/**`, `src/app/login/**`, `src/components/**` |

`src/proxy.ts` only redirects. Every page, route and action checks the session on the server.

## Contract version log

| Version | Change |
|---|---|
| v0.5 | Log rows keep `apiName` and `userEmail` after deletion. Invite deliveries report `accepted` and `invitationId`. Internal writes from another origin answer 403. |
| v0.6 | Render is the deploy target. New settings: `DATABASE_CA_CERT`, `CLIENT_IP_HEADER`. |
| v0.7 | Endpoints can limit which columns they expose. |

## Frontend → backend requests

None open.

## Backend → frontend requests

None open.

## Measured vs asserted

**Measured locally:** typecheck, lint, unit and integration tests, production build, browser tests at desktop
and phone width, and `pnpm smoke`.

**Not yet measured:** a live Google sign-in or Sheets call, a real email send, TLS against Supabase, the Render
Blueprint, and `CLIENT_IP_HEADER` behind Render's proxy. `deployment-render.md` §4 covers these.
