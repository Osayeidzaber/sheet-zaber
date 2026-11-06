# Google OAuth — Cloud Console Configuration

Reference for setting up the OAuth client used by the Google login flow
(see ARCHITECTURE.md §4.1, IMPLEMENTATION.md Phase 2 Task 2.4).

## Client type

**Web application**

## Authorized redirect URIs

| Env | URI |
|---|---|
| Production | `https://sheet.zaber.tech/auth/google/callback` |
| Local dev | `http://localhost:3001/auth/google/callback` |

- Dev server runs on **3001** (3000 is the portfolio).
- No trailing slash; exact match required by Google.

## Authorized JavaScript origins (optional, harmless to add)

- `https://sheet.zaber.tech`
- `http://localhost:3001`

## Authorized domains

- `zaber.tech`

Apex domain covers all subdomains (`sheet.zaber.tech` included). Bare
hostname only — no scheme, no paths.

## Consent screen

While in **Testing** mode Google does not verify these pages exist:

| Field | Value |
|---|---|
| Application home page | `https://sheet.zaber.tech` |
| Privacy policy link | `https://sheet.zaber.tech/privacy` |
| Terms of service link | `https://sheet.zaber.tech/terms` |

- Consent screen: **Testing** mode + add test users (owner email first).
- Before production verification: `/privacy` and `/terms` pages must exist
  and be publicly reachable (add to the Phase 6/7 checklist).

## After creating the client

Copy credentials into `sheet-zaber/.env.local`, the file Next.js actually loads and
`.gitignore` keeps out of the repository. `.env.example` is a committed template: leave its
placeholders empty or the secret is in git history the moment anyone stages it.

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

OAuth is optional in dev (login screen shows "Google OAuth not configured"),
mandatory in production.

## APIs to enable

- Sheets API (for the spreadsheet sync feature)
