# Sheet Zaber — Google Integration

The contract between Sheet Zaber and Google. Everything in this file is owned by the backend;
the frontend consumes only the two surfaces marked "frontend-visible" (§6).

**Hard boundary:** `src/server/google/connections.ts` and `src/server/google/sheets.ts` are the
**only** modules allowed to import `googleapis`. No route handler, server action, or component
may construct an OAuth2 client, mint a token, or call a Google REST endpoint directly. If a
capability is not expressible through those two modules, it is added there — not worked around
in the calling layer.

## 1. Scopes

| Scope | Purpose | In v1? |
|---|---|---|
| `openid` | stable user id (`sub`) for identity anchoring | yes |
| `email` | verified email for the `users.email` column | yes |
| `profile` | display name + picture for `user_profiles` | yes |
| `https://www.googleapis.com/auth/spreadsheets` | read/write the spreadsheets the user registers | yes |
| `https://www.googleapis.com/auth/drive.readonly` | Picker/discovery UI (list files) | **no — deferred, §5** |

Consent request is `access_type=offline` + `prompt=consent` on the connect flow so a refresh
token is guaranteed to be returned. The identity-only login does **not** ask for
`spreadsheets`; it is requested on the first "Connect Google" action so a user can sign in
before granting data access.

`email_verified` from the ID token is mandatory: an unverified email aborts the flow with
`?error=email_unverified` (§authentication-flow.md §1). Identity is anchored on `sub`, never on
email.

## 2. Token storage and lifecycle

| Token | Where it lives | Lifetime |
|---|---|---|
| authorization `code` | in-memory, request scope only | single use, ≤ 10 min |
| `id_token` | parsed and discarded; only claims are persisted | n/a |
| `access_token` | **never persisted** — in-process cache keyed by connection id | until expiry, ≤ 50 min used |
| `refresh_token` | `google_connections.refresh_token_enc` | until revoked/expired |

`refresh_token_enc` is AES-256-GCM ciphertext: `base64(iv ‖ authTag ‖ plaintext)`, random
12-byte IV per encryption, key from the `TOKEN_ENCRYPTION_KEY` env var (32 bytes,
`scripts/make-env-keys.ts` generates it). Nothing else may hold a Google token — not the
session cookie, not a log row, not the browser.

**Refresh path (the only place Google 401 is handled):**

```
use a connection
  → cached access_token still valid?  use it
  → else decrypt refresh_token, getAccessToken()
  → Google call returns 401 → force refresh ONCE → retry ONCE
  → refresh itself fails (invalid_grant / decryption failure / revoked)
      → google_connections.status = 'reauth_required'
      → dashboard: reconnect banner (§6)
      → /api/v1:   503 { error: { code: "google_reauth_required", category: "google" } }
```

Decryption failure is treated as `reauth_required`, never as a crash and never with the
ciphertext or key material in the message. Rotating `TOKEN_ENCRYPTION_KEY` therefore invalidates
every connection — the documented consequence is "all users see the reconnect banner once".

Disconnect deletes the row and best-effort calls `oauth2client.revokeToken()` first; a revoke
failure does not block the deletion (the row is what enforces access).

Google Cloud "Testing" publish status caps refresh tokens at 7 days, so the
`reauth_required` path is expected behaviour, not an edge case. The pre-launch checklist in
README applies for the verification exemption.

## 3. Spreadsheet registration and verification

**Backend verification is required; the picker/URL is not evidence of access.**

```
1. user supplies a spreadsheet URL or id (frontend may also paste from a Picker later)
2. normalize → google_sheet_id        (accepts /spreadsheets/d/<id>/…, bare id, #gid=…)
3. sheets.getSpreadsheet(
     fields: "spreadsheetId,properties,sheets.properties")   ← the mask `google/sheets.ts` sends
   · `Sheet.properties` (`SheetProperties`) is where `sheetId`, `title` AND `gridProperties`
     live — there is no `sheetProperties` field on `Sheet`, and no `properties.sheetTitles` on
     `Spreadsheet`, in the v4 schema. The earlier text of this step asked for
     `sheets.sheetProperties`; it would have returned no dimensions at all.
   · `spreadsheetId` is in the mask so the response can be scope-checked against the id we asked
     for, rather than trusted.
   with THAT user's connection          ← this is the ownership/permission check
   ├─ 403 permissionDenial → "no access to that spreadsheet" (never created)
   ├─ 404 → "spreadsheet not found"
   └─ 429 → 503 rate_limited, no row written
4. build the tab snapshot       tabs: [{ id: gid, title, rows, columns }]
   (rows/columns from `sheets.properties.gridProperties.rowCount/columnCount` in the same
   response; no extra round trip)
5. INSERT registered_spreadsheets (user_id, connection_id, google_sheet_id, title, tabs,
   status='active') — UNIQUE (user_id, google_sheet_id) makes re-registering idempotent
```

Step 3 is the security boundary: the call is made with the connection belonging to the user
doing the registering, so a spreadsheet only readable by someone else cannot be added no matter
what id is pasted. `connection_id` is stored with the row precisely so later reads use the same
verified grant rather than re-picking a connection.

`registered_spreadsheets.tabs` is a **snapshot** taken at registration. The engine validates
`tab_title` and column names against it; a header the user added to the sheet afterwards is
invisible to the API until "Refresh tabs" re-runs §3 step 4. That is deliberate: it keeps
request-path validation to one DB read with no Google round trip.

## 4. Sheets operations used by the engine

| Engine verb | Google call | Notes |
|---|---|---|
| `GET` list | `spreadsheets.values.get` (`A1` range built from `header_row`) | header row → object keys; empty header cell → `column_N` |
| `GET` one | `spreadsheets.values.get` + PK resolution | client-side filter; Sheets has no query language |
| `POST` | `spreadsheets.values.append` (`valueInputOption=RAW`, `insertDataOption=INSERT_ROWS`) | returns `updatedRange` → the written row |
| `PATCH`/`PUT` | `spreadsheets.values.update` on the resolved single row | PUT replaces the whole row; PATCH merges by header |
| `DELETE` | `spreadsheets.batchUpdate` → `deleteDimension` (`dimension="ROWS"`, validated 0-based start/end index) | whole-row deletion; no partial deletes |

`RAW` is used because Sheet Zaber writes cell *values*, not formulas: user input that looks like
`=` or `@` must not be interpreted. The trade-off (a leading apostrophe is stored literally) is
documented in the API guide.

PK resolution for write verbs: read the PK column once, match `{record}` case-sensitively on the
stringified cell, then 0 matches → `404 record_not_found`, >1 → `409 ambiguous_record`. Row
indexes are computed at request time and **never persisted** (D9).

Batches: v1 writes one record per request. A `POST` array >1 record is rejected with
`400 validation_failed`; multi-row batch writes are a post-v1 extension and would need the same
resolve→write race semantics documented first.

## 5. Google Picker (deferred)

The user's ruling for v1 (2026-11-05): **paste URL/ID → backend verifies via
`spreadsheets.get` → tab picker from the returned snapshot** with a header/row preview. The
Google Picker widget is documented here as a deferred enhancement so adding it later does not
require re-deciding anything.

The Picker is a browser widget, so it cannot be layered on without three changes that are each
owned by a different party:

1. **Scope** — `drive.readonly` must be added to §1, which changes the consent screen text and
   re-prompts every existing user. Backend decision.
2. **A live access token in the browser** — the Picker JS needs a short-lived token client-side.
   That directly conflicts with §2 ("access_token never persisted, never in the browser") and
   with the data-minimisation rule in `security.md` §4. It would require a new internal route
   minting a *separate* Drive-only, 60-second token, returned to the browser and never stored.
   Backend + security review.
3. **CSP and frame relaxations** — `next.config.ts` currently ships `default-src 'self'`. The
   Picker needs `script-src`/`frame-src` for `apis.google.com`, `connect-src` for
   `www.googleapis.com`, and the `X-Frame-Options: DENY` header relaxed for the picker iframe.
   Frontend + backend jointly; the header change lives in a backend-owned file.

Until all three land, the paste flow stands and `docs/integration-status.md` carries the request.
Nothing in the registration contract changes when the Picker arrives: it would only prefill the
id that step 1 normalizes.

## 6. Frontend-visible surfaces

| Surface | Shape | Owner |
|---|---|---|
| `GET /api/internal/connections` | `{ connections: Connection[] }`, `Connection = { id, googleEmail, scope, status, connectedAt, lastUsedAt }` — **never** a token, never the ciphertext | backend |
| Reconnect banner | render when any connection has `status === 'reauth_required'`; CTA links to `/auth/google/connect` | frontend |
| "Connect Google" | `<a href="/auth/google/connect">` — a plain link, not a fetch | frontend |
| Register spreadsheet | server action `registerSpreadsheet(input)` → `ActionResult<{ id, title, tabs }>`; paste box + tab preview | backend provides, frontend renders |
| Refresh tabs | server action `refreshSpreadsheetTabs(id)` → `ActionResult<{ tabs }>` | backend |

`status` is the only Google-side state the frontend needs; it must render all four values
(`connected`, `reauth_required`, `disconnected`, plus an empty list meaning "never connected").
