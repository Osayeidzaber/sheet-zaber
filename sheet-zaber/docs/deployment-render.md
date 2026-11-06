# Deploying to Render

`render.yaml` at the repository root defines the web service and a nightly log-cleanup job. This
replaces the Vercel steps in `architecture.md` §9. The Blueprint has not yet been run on Render.

## 1. Before the first deploy

1. **Database.** Use Supabase's Session pooler URL (it has an IPv4 endpoint). Download the CA from
   Database Settings > SSL Configuration.
2. **Keys.** Run `pnpm make-keys` and copy the values. Generate new ones for production. Keep them:
   a new `TOKEN_ENCRYPTION_KEY` makes every stored Google token unreadable.
3. **Google.** Add `https://<your-domain>/auth/google/callback` to the OAuth client's redirect URIs.
4. **Email (optional).** Verify a sender domain in Resend. Invite-by-email stays off without it.

## 2. Create the services

In Render, choose New > Blueprint and select this repository. Enter these when asked:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the pooler URL; any `sslmode` in it is ignored |
| `DATABASE_CA_CERT` | the CA's PEM; `\n` in place of line breaks is fine |
| `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` | from step 1 |
| `OWNER_EMAIL` | the first Google account with this email becomes owner |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from Google Cloud |
| `NEXT_PUBLIC_SITE_URL` | `https://<your-domain>` with no trailing slash; read at build time, so redeploy after changing it |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | optional |

The database connection always verifies its certificate, so without the right CA the release fails at
the migration step. That is intended. Do not work around it by disabling verification.

## 3. What each deploy does

1. Build: installs dev dependencies too, because the build and scripts need them.
2. Pre-deploy: `pnpm db:deploy` applies `drizzle/`. A failure stops the release.
3. Start: `next start` listens on Render's `PORT`. `/api/health` is the health check, and it does not
   touch the database.

The cron job runs `pnpm db:prune` daily at 03:30 UTC. On a free plan, which has neither pre-deploy nor
cron, run `pnpm db:deploy` and `pnpm db:prune` yourself with production env values, and remove those
entries from `render.yaml`.

## 4. Check after the first deploy

Replace `$SITE` with your URL.

```bash
curl -i $SITE/api/health
```

Expect 200 and the security headers.

```bash
curl -i $SITE/api/v1/anything
```

Expect 401 `missing_key`.

**Client IP spoof test.** Rate limits rely on `CLIENT_IP_HEADER=true-client-ip`. Render's platform docs
do not guarantee that header, so confirm it: temporarily log `clientIp(req)`, then send a request with
`-H "True-Client-IP: 1.2.3.4" -H "X-Forwarded-For: 1.2.3.4"`. The log must show your real address. If it
is empty, every caller shares one bucket and legitimate traffic gets throttled. If it shows `1.2.3.4`,
callers can dodge limits. In either case set the variable to a header Render does control.

**Then, by hand, with your own Google account:** sign in, redeem an invitation, connect Google, register
a sheet, create an API and a key, call every verb with `curl`, and confirm the logs show each call. This
has never been run against real Google.

## 5. Scaling note

Google access tokens are cached per process, which only costs an extra token refresh with more than one
instance. Rate limits live in Postgres, so they hold across instances.
