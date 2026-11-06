# Sheet Zaber — Database Design

Supabase Postgres 16. Drizzle ORM is the source of truth (`src/server/db/schema.ts`);
`drizzle/` holds committed SQL migrations. This document describes the schema the migrations
must produce. All ids are UUIDv7-style text (`crypto.randomUUID()` v4 acceptable; text PKs
keep Drizzle simple). All timestamps are `timestamptz` defaulting to `now()`.

**Conventions**

- Soft state via explicit `status` columns; hard deletes only where cascade is correct.
- Secrets stored **only** as hashes/ciphertext: `invitations.code_hash`,
  `api_keys.key_hash`, `google_connections.refresh_token_enc`.
- RLS enabled on every table with **no policies** (deny-by-default). The app role owns the
  tables (bypasses RLS); any leaked `anon`/`authenticated` key reads nothing.
- FKs use `ON DELETE CASCADE` for owned child data, `SET NULL` where history must survive
  (request logs snapshot `api_name` and outlive the API and the account; audit logs never cascade).

## ER overview

```
users 1──1 user_profiles              (display name, picture, theme, dashboard prefs;
                                       preferences live here — there is no user_settings table)
users 1──* google_connections     users 1──* registered_spreadsheets
users 1──* api_configurations     users 1──* api_keys
users 1──* api_request_logs       users 1──* audit_logs (actor or subject)
invitations 1──* invitation_redemptions *──1 users (redeemed_by)
registered_spreadsheets 1──* api_configurations
api_configurations 1──* api_request_logs
api_keys 1──* api_request_logs (nullable: dashboard playground calls)
rate_limit_buckets (standalone counters)
```

## Tables

### users
| column | type | notes |
|---|---|---|
| id | text PK | uuid |
| google_sub | text **UNIQUE NOT NULL** | verified `sub` claim — the real identity anchor |
| email | text **UNIQUE NOT NULL** | from verified ID token |
| role | text NOT NULL default `'user'` | `'user' | 'owner'` (CHECK) |
| status | text NOT NULL default `'active'` | `'active' | 'disabled'` (CHECK) |
| invitation_id | text FK→invitations NULL | how they got in (owner: NULL) |
| last_login_at | timestamptz NULL | |
| created_at / updated_at | timestamptz | |

Index: `(status)`. Login lookup by `google_sub`.

### user_profiles
| column | type | notes |
|---|---|---|
| user_id | text PK FK→users CASCADE | |
| display_name | text NOT NULL | seeded from Google name, editable |
| picture_url | text NULL | Google avatar |
| timezone | text NULL | IANA name |
| theme | text NOT NULL default `'dark'` | `'dark' | 'light' | 'system'` |
| dashboard_prefs | jsonb NOT NULL default `'{}'` | e.g. default landing tab |

(Preferences live here rather than a separate table — one row per user, read together.
This table is the whole settings surface: the schema has no `user_settings` table, and the
spec's "user settings" requirement is satisfied by `user_profiles` plus `users.status`.)

### invitations
| column | type | notes |
|---|---|---|
| id | text PK | |
| code_hash | text **UNIQUE NOT NULL** | SHA-256 hex of `ZABER-XXXX-XXXX` |
| label | text NULL | owner's memo ("for Rahim") |
| max_uses | int NOT NULL default 1 | CHECK ≥1 |
| uses | int NOT NULL default 0 | CHECK ≥0, ≤ max_uses |
| expires_at | timestamptz NULL | |
| revoked_at | timestamptz NULL | |
| created_by | text FK→users NOT NULL | owner |
| created_at | timestamptz | |

Partial index: `(code_hash) WHERE revoked_at IS NULL`.
**Redemption (race-safe, single statement):**
```sql
UPDATE invitations
   SET uses = uses + 1
 WHERE code_hash = $1
   AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > now())
   AND uses < max_uses
RETURNING id;
```
0 rows → invalid/expired/revoked/exhausted (user-facing message stays generic:
"invitation code is not valid"). Insert into `users` + `invitation_redemptions` in the same
transaction; transaction abort rolls the counter back.

### invitation_redemptions
| column | type | notes |
|---|---|---|
| id | text PK | |
| invitation_id | text FK→invitations CASCADE NOT NULL | |
| redeemed_by | text FK→users CASCADE NOT NULL | |
| redeemed_at | timestamptz NOT NULL | |

UNIQUE `(invitation_id, redeemed_by)`; also enforces "one account per redemption".
Duplicate-registration guard: `users.google_sub UNIQUE` + unique partial index
`(email) WHERE status <> 'deleted'` — a second sign-in by the same Google account can never
create a second user.

### google_connections
| column | type | notes |
|---|---|---|
| id | text PK | |
| user_id | text FK→users CASCADE NOT NULL | |
| google_email | text NOT NULL | may differ from login email |
| refresh_token_enc | text NOT NULL | AES-256-GCM: `base64(iv ‖ tag ‖ ciphertext)` |
| scope | text NOT NULL | granted scopes |
| status | text NOT NULL default `'connected'` | `'connected' | 'reauth_required' | 'disconnected'` |
| last_used_at | timestamptz NULL | |
| connected_at / updated_at | timestamptz | |

UNIQUE `(user_id, google_email)`. Index `(status)`. Multiple Google accounts per user =
multiple rows (spec §6 "if practical" — supported).

### registered_spreadsheets
| column | type | notes |
|---|---|---|
| id | text PK | |
| user_id | text FK→users CASCADE NOT NULL | |
| connection_id | text FK→google_connections CASCADE NOT NULL | which Google account can read it |
| google_sheet_id | text NOT NULL | from the URL |
| title | text NOT NULL | cached metadata |
| tabs | jsonb NOT NULL | `[{ id, title, rows, columns }]` snapshot at registration |
| status | text NOT NULL default `'active'` | `'active' | 'inaccessible'` |
| created_at / updated_at | timestamptz | |

UNIQUE `(user_id, google_sheet_id)`. Index `(user_id)`.

### api_configurations
| column | type | notes |
|---|---|---|
| id | text PK | **this is the public `{api_id}`** — uuid, unguessable |
| user_id | text FK→users CASCADE NOT NULL | owner of the API |
| spreadsheet_id | text FK→registered_spreadsheets CASCADE NOT NULL | |
| name | text NOT NULL | |
| description | text NULL | |
| tab_title | text NOT NULL | worksheet |
| header_row | int NOT NULL default 1 | CHECK ≥1 |
| primary_key_column | text NULL | required for PATCH/PUT/DELETE (D9) |
| permissions | text NOT NULL default `'read'` | `'read' | 'read_write'` (CHECK) |
| allowed_operations | jsonb NOT NULL | `["GET","POST","PATCH","PUT","DELETE"]` subset |
| enabled | boolean NOT NULL default true | |
| rate_limit_per_hour | int NULL | NULL = platform default (1000/h, 10000/day) |
| created_at / updated_at | timestamptz | |

Indexes: `(user_id)`, `(enabled)`. Public lookup: PK only.
Write verbs are rejected at the engine when `permissions='read'` or the verb ∉
`allowed_operations`; PATCH/PUT/DELETE additionally require `primary_key_column IS NOT NULL`.

### api_keys
| column | type | notes |
|---|---|---|
| id | text PK | |
| user_id | text FK→users CASCADE NOT NULL | |
| name | text NOT NULL | |
| key_hash | text **UNIQUE NOT NULL** | SHA-256 hex of `sz_live_…` |
| key_preview | text NOT NULL | `sz_live_ab12…last4` — safe to display |
| scopes | jsonb NOT NULL default `'["read"]'` | `["read"]` or `["read","write"]` |
| allowed_api_ids | jsonb NULL | NULL = all of the user's APIs |
| expires_at | timestamptz NULL | |
| revoked_at | timestamptz NULL | |
| last_used_at | timestamptz NULL | updated at most 1×/min (batched write to avoid hot row) |
| created_at | timestamptz | |

Indexes: `(user_id)`, `(key_hash) WHERE revoked_at IS NULL`.
"Regenerate" = revoke old row + create new row (preserves history), never mutate a hash.

### api_request_logs
| column | type | notes |
|---|---|---|
| id | bigint GENERATED ALWAYS AS IDENTITY PK | append-only, high volume |
| api_id | text FK→api_configurations SET NULL NULL | NULL for 404-on-unknown-api and after the API is deleted |
| api_name | text NULL | the API's name when the request was served; survives its deletion |
| user_id | text FK→users SET NULL NULL | resolved api owner; NULL after the account is deleted |
| user_email | text NULL | the owner's email when the request was served; survives account deletion until the retention sweep |
| api_key_id | text FK→api_keys SET NULL NULL | |
| method | text NOT NULL | GET/POST/PATCH/PUT/DELETE |
| path | text NOT NULL | `/api/v1/{id}/…` — **no query strings containing data** |
| status_code | int NOT NULL | |
| duration_ms | int NOT NULL | |
| request_bytes | int NULL | |
| error_category | text NULL | `auth | rate_limit | validation | google | not_found | internal` |
| origin | text NULL | Origin/Referer header host only |
| created_at | timestamptz NOT NULL default now() | |

Indexes: `(api_id, created_at DESC)`, `(user_id, created_at DESC)`, `(created_at)` for
pruning. **Never stored:** headers, bodies, API keys, tokens, cell contents (spec §10).
Retention: `pnpm db:prune` (`scripts/prune-logs.mts`) deletes rows older than `LOG_RETENTION_DAYS`
(default 90). Nothing schedules it yet; the deployment must.

### audit_logs
| column | type | notes |
|---|---|---|
| id | text PK | |
| actor_id | text FK→users SET NULL NULL | |
| action | text NOT NULL | `user.disable`, `user.enable`, `invitation.create`, `invitation.revoke`, `api_key.revoke_admin`, `settings.update`, `owner.bootstrap` |
| subject_type / subject_id | text | `user`, `invitation`, … |
| detail | jsonb NOT NULL default `'{}'` | non-secret context |
| created_at | timestamptz | |

Index `(actor_id, created_at DESC)`, `(subject_type, subject_id)`. Never cascades —
history outlives the record.

### rate_limit_buckets
| column | type | notes |
|---|---|---|
| bucket_key | text PK | `{scope}:{id}:{window}` e.g. `key:<keyId>:h` |
| count | int NOT NULL | |
| window_start | timestamptz NOT NULL | |

Upsert: `INSERT … ON CONFLICT (bucket_key) DO UPDATE SET count = count + 1, window_start =
CASE WHEN now() - window_start > interval THEN now() ELSE window_start END` — single
round-trip fixed-window counter; good enough at this scale (D13), pruned nightly with logs.

## Migration & seed plan

1. `0000_init.sql` — all tables above (one migration; the schema ships as a unit).
2. Seed: `scripts/seed-owner.ts` — upserts owner only if `OWNER_EMAIL` user already signed in
   (promotes role); normal path is role assignment at first login (D12). No demo data ever.
3. Local + test DB: there is no Docker or system Postgres on the development machine.
   `pnpm db:local` (`scripts/db-local.ts`) boots `embedded-postgres` — real PostgreSQL 16
   binaries, in-process, no admin rights — on an ephemeral port with data in `.pg-local/`, and
   prints the `DATABASE_URL` to paste. The Vitest integration suite boots its own ephemeral
   instance (`tests/helpers/db.ts`), applies every committed migration, and truncates between
   files. `docker-compose.test.yml` was never created; this helper is the documented path.

## Data-volume sanity (free tier 500 MB)

~200 bytes/log row → 90-day retention at 10k requests/day ≈ 180 MB worst case; realistic
private usage (≤500 req/day) ≈ 9 MB. All other tables are tiny. Prune script keeps headroom.
