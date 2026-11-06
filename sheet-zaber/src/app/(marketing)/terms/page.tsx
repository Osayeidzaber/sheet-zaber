import type { Metadata } from "next"

import { StatusCode } from "@/components/ui/badge"
import { Panel, Row } from "@/components/ui/panel"
import {
  BulletList,
  Em,
  LegalDocument,
  Para,
  type LegalSection,
} from "@/components/marketing/legal-doc"

// Transcribed from docs/legal/terms-of-service.md.
// Keep the legal wording in sync with that source; legacy fragment ids remain available.
export const metadata: Metadata = {
  title: "Terms",
  description:
    "The rules for using Sheet Zaber: invitation codes, API keys, rate limits, primary-key write semantics and the limits of what the platform promises.",
}

const REFUSALS: Array<{ code: number; meaning: string }> = [
  { code: 400, meaning: "malformed input," },
  { code: 401, meaning: "missing or invalid key," },
  { code: 403, meaning: "valid key but wrong endpoint/verb/disabled endpoint," },
  { code: 404, meaning: "no such endpoint or record," },
  { code: 409, meaning: "ambiguous record," },
  { code: 413, meaning: "body too large," },
  { code: 422, meaning: "header or tab mismatch / sheet inaccessible," },
  { code: 429, meaning: "rate limited," },
  { code: 503, meaning: "Google-side," },
  { code: 500, meaning: "internal error (never with internals in the message)." },
]

const SECTIONS: LegalSection[] = [
  {
    id: "service",
    index: "01",
    heading: "What the service is",
    body: (
      <>
        <Para>
          Sheet Zaber (<code className="inline">sheet.zaber.tech</code>) publishes one tab of one Google Sheet you own as one REST endpoint
          under <code className="inline">/api/v1</code>, served with the Google permission of the account that registered the sheet. It is a
          thin, authorized proxy in front of your own spreadsheet — not a database, backup or cache: your rows stay
          in Google Sheets and we keep only account, configuration and log metadata (see <a href="/privacy" className="text-paper underline decoration-edge underline-offset-4"><code className="inline">/privacy</code></a>). There is no
          billing, subscription, trial or paid tier in the product, so there is nothing to pay and nothing to
          refund; the service is free of charge.
        </Para>
      </>
    ),
  },
  {
    id: "parties",
    index: "02",
    heading: "Parties and roles",
    body: (
      <>
        <Para>
          These terms are between you and Osayeed Zaber, who operates the platform through a single owner account
          and is established in Dhaka, Bangladesh. Bangladeshi law governs; <a href="#changes" className="text-paper underline decoration-edge underline-offset-4">§11</a> states the forum.
        </Para>
        <Para>
          Two roles exist. <code className="inline">owner</code> is one account, granted only to the configured owner email at first sign-in,
          with no self-promotion path. Everyone else is <code className="inline">user</code>, and runs their own surface: register sheets, build
          endpoints, issue and revoke their own keys, read their own logs and analytics. You are the operator of
          your own endpoints and answerable for them.
        </Para>
      </>
    ),
  },
  {
    id: "access",
    index: "03",
    heading: "Access is invited, and revocable",
    body: (
      <Para>
        No account exists until you redeem an invitation code during registration; signing in with Google alone
        creates none. Codes are single-use by default, can expire, can be revoked, and are known to the platform
        only as a hash. A code is issued <Em>to you</Em>: one Google identity gets one account, and circulating an
        invitation is a misuse of it, for which the operator&#39;s remedy is revocation of the code and of the
        accounts that followed. The operator may stop issuing invitations, or end the service, at any time. No
        entitlement to access is implied.
      </Para>
    ),
  },
  {
    id: "account-keys",
    index: "04",
    heading: "Your account, your keys, your responsibility",
    body: (
      <Para>
        You are responsible for everything done under your account and with every key issued to it. A key
        (<code className="inline">sz_live_</code> plus 32 hex characters) is shown exactly once; only its hash and a short preview are stored,
        so <Em>nobody can recover a lost key for you</Em> — plan to rotate rather than to retrieve. Regenerating a
        key revokes the old one and mints a new secret. Send the key in the <code className="inline">Authorization: Bearer</code> header; keys
        in query strings are not accepted, because URLs leak into logs and referrers. Keep keys server-side, out
        of browser code, mobile binaries, repositories and logs. You can scope a key to read or read-write,
        restrict it to specific endpoints, set an expiry, and revoke it — revocation takes effect on the next
        request.
      </Para>
    ),
  },
  {
    id: "use",
    index: "05",
    heading: "Acceptable use",
    body: (
      <>
        <Para>You agree not to:</Para>
        <BulletList
          items={[
            <>
              register or reach a sheet you have no right to read or write. The platform tests this instead of
              trusting you: registration calls the Sheets API with your own connection, and a sheet your account
              cannot access is never created.
            </>,
            <>
              attempt to reach another user&#39;s data, tokens, keys or endpoints, or raise your own role. No path
              accepts a user-supplied token, and refused attempts are audited.
            </>,
            <>
              publish personal data you have no right to expose through an endpoint you created, or share your keys.
            </>,
            <>
              breach Google&#39;s terms for the Sheets API — your grant is the one being used, and Google&#39;s quotas sit in
              front of ours.
            </>,
            <>
              attack, abuse or attempt to defeat the rate limits, authentication or logging of the service.
            </>,
            <>
              put behind an endpoint anything you would not want the operator to see metadata about: tab titles and
              row and column counts are stored; cell contents are not.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: "limits",
    index: "06",
    heading: "Limits, semantics and refusals",
    body: (
      <>
        <BulletList
          items={[
            <>
              <Em>Rate limits</Em>, per key by default: 1000 requests/hour and 10000/day, in fixed windows, with a
              per-endpoint hourly override and an extra per-client-IP hourly window. Fixed windows can admit a burst
              at a boundary. Exceeding a limit answers <code className="inline">429</code> with <code className="inline">Retry-After</code>.
            </>,
            <>
              <Em>Body size</Em>: at most 1,000,000 bytes, rejected with <code className="inline">413</code> before parsing.
            </>,
            <>
              <Em>Writes</Em>: <code className="inline">POST</code> takes one JSON object or an array of up to 500 objects, each setting at least one
              real column. <code className="inline">PATCH</code>, <code className="inline">PUT</code> and <code className="inline">DELETE</code> take exactly one object.
            </>,
            <>
              <Em>Reads</Em>: <code className="inline">limit</code> 1–1000 (absent means <em>all rows</em> — an unbounded read pulls the whole tab from Google),{" "}
              <code className="inline">offset</code>, <code className="inline">fields</code> projection, a full-text <code className="inline">q</code>, and <code className="inline">where[column]=value</code> filters. Row numbers are never
              returned.
            </>,
            <>
              <Em>Schema drift</Em>: an endpoint validates columns against a snapshot taken when you registered the tab. A
              header you add later in Sheets is invisible until you refresh the tabs; an unknown column is refused
              with the list of real ones.
            </>,
            <>
              <Em>Google&#39;s quota</Em> (roughly 60 read and 60 write requests per minute per user) applies upstream and
              surfaces as <code className="inline">503</code> with <code className="inline">Retry-After</code> passed through.
            </>,
          ]}
        />
        <Para>
          Refusals all use one shape, <code className="inline">{'{ "error": { "code", "message", "category" } }'}</code>:
        </Para>
        <Panel as="div" className="overflow-hidden">
          <ul>
            {REFUSALS.map((item) => (
              <Row key={item.code} as="li" className="items-start gap-x-5">
                <StatusCode code={item.code} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1 text-[14px] leading-[1.6] text-mist">
                  {item.meaning}
                </span>
              </Row>
            ))}
          </ul>
        </Panel>
        <div id="writes" className="scroll-mt-6">
          <Para>
            <Em>Writes have no undo.</Em> Updating or deleting a row addresses it through the primary-key column you
            designate; an endpoint without one is read-and-append only and refuses writes with 403. Your key value is
            matched exactly and case-sensitively against the cell: no match is <code className="inline">404</code>, more than one is{" "}
            <code className="inline">409 ambiguous_record</code>, and the sheet is untouched either way — <Em>keeping those values unique is your
            job</Em>. <code className="inline">PUT</code> replaces the whole row and clears every column you omit, including the primary key if you
            leave it out; <code className="inline">PATCH</code> writes only what you send; <code className="inline">DELETE</code> removes that one row, and there is
            deliberately no bulk delete by filter. Cells are written as values, not formulas, so text starting with{" "}
            <code className="inline">=</code> or <code className="inline">@</code> is stored literally. This API has no restore, undo or versioning, and Google Sheets has no
            conditional row update — if two writers race, the last write wins. That is a documented limitation of the
            underlying API, not something these terms promise away. Use Google&#39;s own version history if you need a
            safety net.
          </Para>
        </div>
      </>
    ),
  },
  {
    id: "availability",
    index: "07",
    heading: "Availability: no promise is made",
    body: (
      <Para>
        No uptime SLA, support-response window, incident notification or status page exists, so none is implied.
        The deployment is one application and one single-region Postgres instance (Singapore) maintained by one
        person.
        Two states are expected behaviour rather than outages: while the OAuth client remains in Google&#39;s{" "}
        <em>Testing</em> state, stored permissions expire after 7 days and calls answer <code className="inline">503</code> until reconnection; and a
        sheet that becomes inaccessible to your permission answers <code className="inline">422</code>. Questions about an account or a
        refusal: <a href="mailto:support@zaber.tech" className="text-paper underline decoration-edge underline-offset-4">support@zaber.tech</a>.
      </Para>
    ),
  },
  {
    id: "ending",
    index: "08",
    heading: "Suspension, and how you end it",
    body: (
      <Para>
        The operator may disable an account, change a role, revoke an invitation or revoke a key. Disabling takes
        effect on the next request: sessions are re-validated against the account row every time, so the
        dashboard closes and the keys stop passing the ownership check. Each action is audited, including refused
        attempts. Account closure is an owner action, not a button: it removes your account together with your
        connections, registered sheets, endpoints and keys. What does <Em>not</Em> go with the account is its history —
        the request-log rows and the operator&#39;s audit rows that describe it survive, because the platform exists
        to answer later what happened to an API, how it happened and who used it (see <a href="/privacy#logs" className="text-paper underline decoration-edge underline-offset-4">§8 of <code className="inline">/privacy</code></a>). Closure
        cannot be carried out on the account that issued invitations, on the operator&#39;s
        own account, or on the only remaining owner. You can end your use at any time by revoking your keys,
        removing your registered sheets, revoking the app&#39;s access in your own Google account, and asking{" "}
        <a href="mailto:support@zaber.tech" className="text-paper underline decoration-edge underline-offset-4">support@zaber.tech</a> to delete the account. Removing our copy of a permission is not revoking it
        at Google — do both.
      </Para>
    ),
  },
  {
    id: "your-data",
    index: "09",
    heading: "Ownership",
    body: (
      <Para>
        Your spreadsheet content stays yours and stays in your spreadsheet; the operator claims no ownership of
        it and keeps no copy of it (see <a href="/privacy" className="text-paper underline decoration-edge underline-offset-4"><code className="inline">/privacy</code></a>). The application, its code and its branding belong to
        Osayeed Zaber. These terms grant you the right to use the service for its intended
        purpose while your account is active — no resale, sublicence or right to republish the software.
      </Para>
    ),
  },
  {
    id: "warranty",
    index: "10",
    heading: "No warranty, and the limit of liability",
    body: (
      <Para>
        The service is provided <Em>as is</Em> and <Em>as available</Em>, without warranty of any kind, express or implied,
        including merchantability, fitness for a particular purpose and non-infringement. The project
        documentation is the specification you rely on; the operator does not warrant that the implementation
        matches it in every respect, and asks you to report a difference rather than assume one. To the extent
        the law allows, the operator is not liable for lost data, lost profit or any indirect or consequential
        loss arising from use of the service — including losses from the last-write-wins behaviour, Google
        outages and quotas, permissions expiring, rate limits, and misuse of a key you issued. The service is
        provided free of charge, and that is the bargain offered.
      </Para>
    ),
  },
  {
    id: "changes",
    index: "11",
    heading: "Changes, and contact",
    body: (
      <>
        <div id="questions" className="scroll-mt-6">
          <Para>
            These terms live in the same repository as the code they describe, so a change ships with the release
            that makes it true, and the date at the top of the page is the date of the last change. There is no
            mechanism to notify you in advance; continuing to use the platform after a change means you accept it,
            and stopping is always available. <Em>Bangladeshi law governs these terms and the courts of Dhaka have
            jurisdiction</Em> over disputes arising from them. Bangladesh has no general personal-data statute in force
            comparable to the GDPR or CCPA, so no such regime is claimed here; what the privacy policy describes is
            the operator&#39;s own practice, honoured on request. Contact: <a href="mailto:support@zaber.tech" className="text-paper underline decoration-edge underline-offset-4">support@zaber.tech</a>. Endpoint behaviour is
            answered by the <a href="/docs" className="text-paper underline decoration-edge underline-offset-4">API documentation</a>; what is stored about you is answered by the <a href="/privacy" className="text-paper underline decoration-edge underline-offset-4">privacy
            policy</a>.
          </Para>
        </div>
        <hr className="border-rule" />
      </>
    ),
  },
]

export default function TermsPage() {
  return (
    <LegalDocument
      folio="Legal · Public surface"
      title="Sheet Zaber — Terms of Service"
      description="STATUS: ready to publish once one migration lands. Written from the shipped code and API behaviour, not from a template. The Frontend Agent renders this into /terms."
      facts={[
        { label: "Last updated", value: "6 November 2026" },
        { label: "Applies to", value: "sheet.zaber.tech" },
        { label: "Operator", value: "Osayeed Zaber" },
        { label: "Governing law", value: "Bangladeshi law; courts of Dhaka" },
      ]}
      sections={SECTIONS}
    />
  )
}
