# Sheet Zaber — Terms of Service

**STATUS: ready to publish once one migration lands.** Written from the shipped code and API behaviour,
not from a template. The Frontend Agent renders this into `/terms`.

The operator, the contact address and the jurisdiction were supplied on 6 November 2026 and are filled in
below. §8 also states that a closed account's request logs survive: that is the owner's decision of the
same day and is **not yet what the schema does** — both `api_id` and `user_id` cascade on
`api_request_logs` today, so removing an endpoint or closing an account deletes its history. Do not
publish this page before that migration runs.

## 1. What the service is

Sheet Zaber (`sheet.zaber.tech`) publishes one tab of one Google Sheet you own as one REST endpoint
under `/api/v1`, served with the Google permission of the account that registered the sheet. It is a
thin, authorized proxy in front of your own spreadsheet — not a database, backup or cache: your rows stay
in Google Sheets and we keep only account, configuration and log metadata (see `/privacy`). There is no
billing, subscription, trial or paid tier in the product, so there is nothing to pay and nothing to
refund; the service is free of charge.

## 2. Parties and roles

These terms are between you and Osayeed Zaber, who operates the platform through a single owner account
and is established in Dhaka, Bangladesh. Bangladeshi law governs; §11 states the forum.

Two roles exist. `owner` is one account, granted only to the configured owner email at first sign-in,
with no self-promotion path. Everyone else is `user`, and runs their own surface: register sheets, build
endpoints, issue and revoke their own keys, read their own logs and analytics. You are the operator of
your own endpoints and answerable for them.

## 3. Access is invited, and revocable

No account exists until you redeem an invitation code during registration; signing in with Google alone
creates none. Codes are single-use by default, can expire, can be revoked, and are known to the platform
only as a hash. A code is issued **to you**: one Google identity gets one account, and circulating an
invitation is a misuse of it, for which the operator's remedy is revocation of the code and of the
accounts that followed. The operator may stop issuing invitations, or end the service, at any time. No
entitlement to access is implied.

## 4. Your account, your keys, your responsibility

You are responsible for everything done under your account and with every key issued to it. A key
(`sz_live_` plus 32 hex characters) is shown exactly once; only its hash and a short preview are stored,
so **nobody can recover a lost key for you** — plan to rotate rather than to retrieve. Regenerating a
key revokes the old one and mints a new secret. Send the key in the `Authorization: Bearer` header; keys
in query strings are not accepted, because URLs leak into logs and referrers. Keep keys server-side, out
of browser code, mobile binaries, repositories and logs. You can scope a key to read or read-write,
restrict it to specific endpoints, set an expiry, and revoke it — revocation takes effect on the next
request.

## 5. Acceptable use

You agree not to:

- register or reach a sheet you have no right to read or write. The platform tests this instead of
  trusting you: registration calls the Sheets API with your own connection, and a sheet your account
  cannot access is never created.
- attempt to reach another user's data, tokens, keys or endpoints, or raise your own role. No path
  accepts a user-supplied token, and refused attempts are audited.
- publish personal data you have no right to expose through an endpoint you created, or share your keys.
- breach Google's terms for the Sheets API — your grant is the one being used, and Google's quotas sit in
  front of ours.
- attack, abuse or attempt to defeat the rate limits, authentication or logging of the service.
- put behind an endpoint anything you would not want the operator to see metadata about: tab titles and
  row and column counts are stored; cell contents are not.

## 6. Limits, semantics and refusals

- **Rate limits**, per key by default: 1000 requests/hour and 10000/day, in fixed windows, with a
  per-endpoint hourly override and an extra per-client-IP hourly window. Fixed windows can admit a burst
  at a boundary. Exceeding a limit answers `429` with `Retry-After`.
- **Body size**: at most 1,000,000 bytes, rejected with `413` before parsing.
- **Writes**: `POST` takes one JSON object or an array of up to 500 objects, each setting at least one
  real column. `PATCH`, `PUT` and `DELETE` take exactly one object.
- **Reads**: `limit` 1–1000 (absent means *all rows* — an unbounded read pulls the whole tab from Google),
  `offset`, `fields` projection, a full-text `q`, and `where[column]=value` filters. Row numbers are never
  returned.
- **Schema drift**: an endpoint validates columns against a snapshot taken when you registered the tab. A
  header you add later in Sheets is invisible until you refresh the tabs; an unknown column is refused
  with the list of real ones.
- **Google's quota** (roughly 60 read and 60 write requests per minute per user) applies upstream and
  surfaces as `503` with `Retry-After` passed through.

Refusals all use one shape, `{ "error": { "code", "message", "category" } }`: 400 malformed input, 401
missing or invalid key, 403 valid key but wrong endpoint/verb/disabled endpoint, 404 no such endpoint or
record, 409 ambiguous record, 413 body too large, 422 header or tab mismatch / sheet inaccessible, 429
rate limited, 503 Google-side, 500 internal error (never with internals in the message).

**Writes have no undo.** Updating or deleting a row addresses it through the primary-key column you
designate; an endpoint without one is read-and-append only and refuses writes with 403. Your key value is
matched exactly and case-sensitively against the cell: no match is `404`, more than one is
`409 ambiguous_record`, and the sheet is untouched either way — **keeping those values unique is your
job**. `PUT` replaces the whole row and clears every column you omit, including the primary key if you
leave it out; `PATCH` writes only what you send; `DELETE` removes that one row, and there is
deliberately no bulk delete by filter. Cells are written as values, not formulas, so text starting with
`=` or `@` is stored literally. This API has no restore, undo or versioning, and Google Sheets has no
conditional row update — if two writers race, the last write wins. That is a documented limitation of the
underlying API, not something these terms promise away. Use Google's own version history if you need a
safety net.

## 7. Availability: no promise is made

No uptime SLA, support-response window, incident notification or status page exists, so none is implied.
The deployment is one application and one single-region Postgres instance (Singapore) maintained by one
person.
Two states are expected behaviour rather than outages: while the OAuth client remains in Google's
*Testing* state, stored permissions expire after 7 days and calls answer `503` until reconnection; and a
sheet that becomes inaccessible to your permission answers `422`. Questions about an account or a
refusal: support@zaber.tech.

## 8. Suspension, and how you end it

The operator may disable an account, change a role, revoke an invitation or revoke a key. Disabling takes
effect on the next request: sessions are re-validated against the account row every time, so the
dashboard closes and the keys stop passing the ownership check. Each action is audited, including refused
attempts. Account closure is an owner action, not a button: it removes your account together with your
connections, registered sheets, endpoints and keys. What does **not** go with the account is its history —
the request-log rows and the operator's audit rows that describe it survive, because the platform exists
to answer later what happened to an API, how it happened and who used it (see §8 of `/privacy`). Closure
cannot be carried out on the account that issued invitations, on the operator's
own account, or on the only remaining owner. You can end your use at any time by revoking your keys,
removing your registered sheets, revoking the app's access in your own Google account, and asking
support@zaber.tech to delete the account. Removing our copy of a permission is not revoking it
at Google — do both.

## 9. Ownership

Your spreadsheet content stays yours and stays in your spreadsheet; the operator claims no ownership of
it and keeps no copy of it (see `/privacy`). The application, its code and its branding belong to
Osayeed Zaber. These terms grant you the right to use the service for its intended
purpose while your account is active — no resale, sublicence or right to republish the software.

## 10. No warranty, and the limit of liability

The service is provided **as is** and **as available**, without warranty of any kind, express or implied,
including merchantability, fitness for a particular purpose and non-infringement. The project
documentation is the specification you rely on; the operator does not warrant that the implementation
matches it in every respect, and asks you to report a difference rather than assume one. To the extent
the law allows, the operator is not liable for lost data, lost profit or any indirect or consequential
loss arising from use of the service — including losses from the last-write-wins behaviour, Google
outages and quotas, permissions expiring, rate limits, and misuse of a key you issued. The service is
provided free of charge, and that is the bargain offered.

## 11. Changes, and contact

These terms live in the same repository as the code they describe, so a change ships with the release
that makes it true, and the date at the top of the page is the date of the last change. There is no
mechanism to notify you in advance; continuing to use the platform after a change means you accept it,
and stopping is always available. **Bangladeshi law governs these terms and the courts of Dhaka have
jurisdiction** over disputes arising from them. Bangladesh has no general personal-data statute in force
comparable to the GDPR or CCPA, so no such regime is claimed here; what the privacy policy describes is
the operator's own practice, honoured on request. Contact: support@zaber.tech. Endpoint behaviour is
answered by the API documentation; what is stored about you is answered by the [privacy
policy](/privacy).

---

*Prepared from the Sheet Zaber codebase and its API behaviour rather than from a template. It is not legal
advice and has not been reviewed by a lawyer, and it is not sound as written while the schema still
contradicts §8. Have a qualified person read it before it is published for Google OAuth production
verification or for real users.*
