# Deploying to Vercel for free

This setup uses Vercel Hobby, Supabase Free and GitHub Actions. Hobby is for personal, non-commercial
use. It has not yet been run end to end. `deployment-render.md` remains the paid alternative.

## 1. Before the first deploy

1. **Database.** Create a Supabase project and download the CA from Database Settings > SSL
   Configuration. Copy two connection strings: the **Transaction pooler** (port 6543) for Vercel, and
   the **Session pooler** for migrations and the cleanup job.
2. **Keys.** Run `pnpm make-keys` and generate new values for production. Keep them: a new
   `TOKEN_ENCRYPTION_KEY` makes every stored Google token unreadable.
3. **Migrations.** From `sheet-zaber`, with the Session pooler URL and CA in your environment, run
   `pnpm db:deploy`. Repeat this before deploying any change that adds a migration.

## 2. Create the project

In Vercel, choose Add New > Project, import this repository, and set **Root Directory** to
`sheet-zaber`. Add these environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Transaction pooler URL |
| `DATABASE_CA_CERT` | the CA's PEM; `\n` in place of line breaks is fine |
| `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` | from step 1 |
| `OWNER_EMAIL` | the first Google account with this email becomes owner |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from Google Cloud |
| `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` | optional; empty hides the Picker button |
| `NEXT_PUBLIC_SITE_URL` | `https://<your-domain>` with no trailing slash; read at build time, so redeploy after changing it |
| `CLIENT_IP_HEADER` | `x-real-ip` |
| `LOG_RETENTION_DAYS` | `90` |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | optional |

Then add `https://<your-domain>/auth/google/callback` to the Google OAuth client's redirect URIs.

## 3. Turn on daily cleanup

In GitHub, open Settings > Secrets and variables > Actions and add `DATABASE_URL` (the Session pooler
URL) and `DATABASE_CA_CERT`. Push the workflow, then run **Prune logs** once from the Actions tab.

GitHub can disable scheduled workflows after 60 days without repository activity. If that happens,
re-enable it from the Actions tab.

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

**Client IP spoof test.** Temporarily log `clientIp(req)`, then send a request with
`-H "X-Real-IP: 1.2.3.4" -H "X-Forwarded-For: 1.2.3.4"`. The log must show your real address, not
`1.2.3.4` and not empty.

**Then, by hand:** sign in, connect Google, register a sheet, create an API and a key, call every verb
with `curl`, and confirm the logs show each call.

## 5. Free-plan limits

Supabase Free pauses inactive projects, and the API fails until you restore the project from its
dashboard. Vercel Hobby has monthly usage limits; see its dashboard for current usage.
