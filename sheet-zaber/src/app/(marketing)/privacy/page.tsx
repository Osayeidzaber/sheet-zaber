import type { Metadata } from "next"

import {
  BulletList,
  Em,
  LegalDocument,
  Para,
  type LegalSection,
} from "@/components/marketing/legal-doc"

// Transcribed from docs/legal/privacy-policy.md.
// Keep the legal wording in sync with that source; legacy fragment ids remain available.
export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What Sheet Zaber stores about you — Google identity, encrypted refresh tokens, spreadsheet metadata, key hashes and request logs — and what it never stores.",
}

const SECTIONS: LegalSection[] = [
  {
    id: "scope",
    index: "01",
    heading: "What this covers",
    body: (
      <>
        <Para>
          Sheet Zaber (<code className="inline">sheet.zaber.tech</code>) is a private, invitation-only application that turns one tab of one
          Google Sheet you own into one REST endpoint. It is an authorized proxy in front of your own Google
          account, not a store: your rows stay in Google Sheets. This policy says what we record about you,
          what we never record, and how to get it removed. Browsing these pages records nothing — there is no
          visitor or analytics table for anonymous traffic.
        </Para>
      </>
    ),
  },
  {
    id: "operator",
    index: "02",
    heading: "Who operates it",
    body: (
      <>
        <Para>
          Osayeed Zaber operates Sheet Zaber and is the sole data controller. Postal address for statutory
          requests: Sector 18, Uttara, Dhaka 1230, Bangladesh. Data requests go to <a href="mailto:support@zaber.tech" className="text-paper underline decoration-edge underline-offset-4">support@zaber.tech</a>.
        </Para>
        <Para>
          Technically there is one operator account: the <code className="inline">owner</code> role, granted only to the single configured owner
          email at first sign-in, and the only role with platform-wide visibility of data.
        </Para>
      </>
    ),
  },
  {
    id: "access",
    index: "03",
    heading: "Invitation-only access",
    body: (
      <>
        <Para>
          Signing in does not create an account. An account exists only after you redeem an invitation code
          (<code className="inline">ZABER-XXXX-XXXX</code>, issued by the owner) during registration, in the same transaction as the account.
        </Para>
        <BulletList
          items={[
            <>
              We store only the SHA-256 hash of a code, never the code. Codes have a use limit (one by default),
              optional expiry, optional revocation, and an optional owner label — free text that may describe you.
            </>,
            <>
              A redemption record says which code, which account, when. One Google identity can never open a
              second account. There are no passwords: Google is the only credential.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: "kept",
    index: "04",
    heading: "What we store about you",
    body: (
      <div tabIndex={0} className="overflow-x-auto rounded-lg border border-rule">
        <table className="w-full min-w-[640px] border-collapse text-left text-[14px] leading-[1.7] text-mist">
          <thead className="border-b border-rule text-paper">
            <tr>
              <th scope="col" className="px-5 py-4 font-semibold">What</th>
              <th scope="col" className="px-5 py-4 font-semibold">Fields</th>
              <th scope="col" className="px-5 py-4 font-semibold">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            <tr>
              <th scope="row" className="px-5 py-4 align-top font-semibold text-paper">Identity</th>
              <td className="px-5 py-4 align-top">Google account id (<code className="inline">sub</code>), verified email, role, status, last login</td>
              <td className="px-5 py-4 align-top">the ID token Google issued</td>
            </tr>
            <tr>
              <th scope="row" className="px-5 py-4 align-top font-semibold text-paper">Profile</th>
              <td className="px-5 py-4 align-top">display name, avatar <Em>URL</Em> (not the image), theme, timezone, dashboard preferences</td>
              <td className="px-5 py-4 align-top">name and avatar seeded at registration and refreshed on later sign-ins; the theme, timezone and preferences columns exist but the app never writes them, so they stay at defaults</td>
            </tr>
            <tr>
              <th scope="row" className="px-5 py-4 align-top font-semibold text-paper">Google connection</th>
              <td className="px-5 py-4 align-top">connected email, granted scopes, encrypted refresh token, status, connected/last-used times</td>
              <td className="px-5 py-4 align-top">your consent</td>
            </tr>
            <tr>
              <th scope="row" className="px-5 py-4 align-top font-semibold text-paper">Your sheets</th>
              <td className="px-5 py-4 align-top">spreadsheet id, cached title, tab snapshot: numeric tab id, <Em>tab title</Em>, row count, column count</td>
              <td className="px-5 py-4 align-top">read from Google when you register</td>
            </tr>
            <tr>
              <th scope="row" className="px-5 py-4 align-top font-semibold text-paper">Your endpoints</th>
              <td className="px-5 py-4 align-top">name and optional description you type, tab title, header row number, primary-key column name, permitted verbs, enabled flag, hourly limit</td>
              <td className="px-5 py-4 align-top">your configuration</td>
            </tr>
            <tr>
              <th scope="row" className="px-5 py-4 align-top font-semibold text-paper">Your keys</th>
              <td className="px-5 py-4 align-top">label, SHA-256 hash, short preview, scopes, allowed endpoints, expiry, revocation, last used</td>
              <td className="px-5 py-4 align-top">generated by us, shown once</td>
            </tr>
            <tr>
              <th scope="row" className="px-5 py-4 align-top font-semibold text-paper">Request history</th>
              <td className="px-5 py-4 align-top">method, path, status, duration, request byte count, error category, and which key/endpoint/account the call resolved to</td>
              <td className="px-5 py-4 align-top">every <code className="inline">/api/v1</code> call, refusals included</td>
            </tr>
            <tr>
              <th scope="row" className="px-5 py-4 align-top font-semibold text-paper">Admin history</th>
              <td className="px-5 py-4 align-top">which owner account did which administrative action, to whom, when</td>
              <td className="px-5 py-4 align-top">the audit log</td>
            </tr>
          </tbody>
        </table>
      </div>
    ),
  },
  {
    id: "google",
    index: "05",
    heading: "Google sign-in, and the tokens we hold",
    body: (
      <>
        <div id="security" className="scroll-mt-6">
          <Para>
            Sign-in uses the authorization-code flow with PKCE (S256). <code className="inline">state</code> is a one-shot nonce bound to a
            signed HttpOnly cookie, and the ID token is verified server-side — issuer, audience, expiry, nonce,{" "}
            <code className="inline">email_verified</code> — before any account is touched; the token itself is read for its claims and
            discarded.
          </Para>
        </div>
        <Para>
          Consent asks for five scopes: <code className="inline">openid</code>, <code className="inline">email</code>, <code className="inline">profile</code>,{" "}
          <code className="inline">.../auth/spreadsheets</code> and <code className="inline">.../auth/drive.file</code>. All five are requested on every consent redirect, sign-in included: the app
          asks for spreadsheet access when it connects your account, because reading and writing your sheets is
          the product. The Drive scope only covers files you choose in Google&apos;s Picker, so the app cannot list or read the rest of your Drive.
        </Para>
        <Para>
          Consent uses <code className="inline">access_type=offline</code> + <code className="inline">prompt=consent</code>, so Google returns a refresh token — that is
          what lets an endpoint keep serving your sheet on later calls made by other people holding your API
          key. Storage of the grant:
        </Para>
        <BulletList
          items={[
            <>
              <Em>Refresh token</Em> — in our database encrypted with AES-256-GCM, random 12-byte IV per encryption,
              key from a server-only environment secret. Never sent to a browser, never logged.
            </>,
            <>
              <Em>Access token</Em> — never persisted: a short in-process cache (at most 50 minutes), gone on restart.
            </>,
            <>
              <Em>Authorization code</Em> — memory, for one request.
            </>,
            <>
              <Em>During registration</Em> — the grant sits in a signed, AES-encrypted, HttpOnly cookie for at most 10
              minutes until the code is redeemed. It grants no access and is not a session.
            </>,
          ]}
        />
        <div id="cookies" className="scroll-mt-6">
          <Para>
            Sign-in then leaves one first-party cookie: HMAC-SHA-256 signed, HttpOnly, Secure, SameSite=Lax, 7
            days, holding only your user id, role and expiry. No advertising, profiling or analytics cookies.
          </Para>
        </div>
        <Para>
          <Em>Withdrawing access is self-service.</Em> Settings → Connections lists each Google connection and
          disconnects it behind a typed confirmation (<code className="inline">disconnectGoogleAction</code>): the service asks Google to revoke
          the refresh token first, and a failed revoke still completes the deletion, because the row is what
          enforces access. Signing out is separate and always available, from the account menu or <code className="inline">/auth/logout</code>.
          Revoking from your side at Google works too: the next call fails and the connection is marked{" "}
          <code className="inline">reauth_required</code> instead of being used. Removing our copy is not revoking at Google — do both, and
          remove the app in your Google account permissions. While the OAuth client remains in Google&#39;s <em>Testing</em>{" "}
          state, Google expires refresh tokens after 7 days, so re-consent is expected behaviour.
        </Para>
      </>
    ),
  },
  {
    id: "sheets",
    index: "06",
    heading: "Your spreadsheet data is processed, not copied",
    body: (
      <>
        <Para>
          We read and write <Em>your</Em> spreadsheets through the Google Sheets API, with <Em>your</Em> grant, at the
          moment a request is made. No code path writes cell values or header names to our database: the engine
          reads the header row live from Google on each request, and the registration preview shows you a header
          row plus at most ten rows in your own browser and stores nothing from it.
        </Para>
        <Para>
          What we keep is structural — spreadsheet id, cached title, tab titles, row and column counts — plus
          two things you type yourself into an endpoint form: a tab title and a primary-key column name. No
          request body, response body or cell value is retained server-side.
        </Para>
        <Para>
          Consequence: every call transits our server between caller and Google. An API key can therefore read
          (and, with write scope, change) the sheet behind it.
        </Para>
      </>
    ),
  },
  {
    id: "keys",
    index: "07",
    heading: "API keys",
    body: (
      <Para>
        <code className="inline">sz_live_</code> plus 32 random hex characters, shown once and never stored: only its SHA-256 hash and a
        short preview (<code className="inline">sz_live_</code> + first 4 and last 4 characters). Nobody — you or the operator — can recover
        it afterwards. Keys can be scoped read or read-write, restricted to specific endpoints, given an
        expiry, revoked or regenerated at any time.
      </Para>
    ),
  },
  {
    id: "logs",
    index: "08",
    heading: "Logs",
    body: (
      <>
        <Para>
          Every <code className="inline">/api/v1</code> call is recorded, including refusals (bad key, unknown endpoint, disabled endpoint,
          rate-limited). A row holds: method, request path, status code, duration in ms, request body size in
          bytes, an error category, the key/endpoint/account the call resolved to, and a timestamp. Paths are
          recorded without query strings, so filter values, search terms and paging parameters are not logged.
        </Para>
        <Para>
          Never logged, because no column exists for them: request or response bodies, headers, cookies, API
          keys, Google tokens, cell values. <Em>No IP address is stored anywhere</Em> — the client IP is used only as
          a one-way hashed component of a transient rate-limit counter. The log also keeps the hostname from a
          request&apos;s Origin or Referer header when one is sent, never its path or query, and the account
          owner can see it in their usage figures.
        </Para>
        <Para>
          Administrative actions (disable, re-enable, role change, invitation create/revoke, key revocation,
          platform settings) write an audit row naming actor, action, subject and non-secret detail — including
          refused attempts — and audit rows are not deleted when the account they describe is.
        </Para>
        <Para>
          <Em>History is the point of the service, so it outlives the records it describes.</Em> By the operator&#39;s
          decision of 6 November 2026, a request log is not deleted when the endpoint it answered is removed, and
          not deleted when the account that owns that endpoint is closed. The row keeps a copy of the endpoint
          name and the account email so that later it can still be answered what happened to an API, how it
          happened and who used it. What does expire is age: rows older than the configured window (90 days by
          default) are removed by the prune sweep, and rate counters are pruned with them. The sweep exists as a
          scheduled job, and until it is running in the deployment rows may
          live longer than the stated window.
        </Para>
        <Para>
          Unexpected internal errors go to the host&#39;s log stream; that window is set by the hosting plan rather
          than by this application,. Those entries carry an error
          object, not request bodies or cell values.
        </Para>
      </>
    ),
  },
  {
    id: "who-sees",
    index: "09",
    heading: "Who can see your data, and who else is involved",
    body: (
      <>
        <Para>
          Cross-account access is prevented structurally, not by a check that could be forgotten: a call always
          walks key → key owner → endpoint owner → that owner&#39;s connection, and no path accepts a user-supplied
          token, so someone else&#39;s endpoint answers exactly like one that does not exist. Row-level security is
          enabled on every table with no policies, so a leaked database key reads nothing.
        </Para>
        <Para>
          The owner account can see the user list, per-account activity and request totals, all request logs,
          and connection/sheet/endpoint metadata. The operator has no product surface for reading your cell
          contents and cannot recover your key plaintext — but holds the database and the encryption secrets,
          which is why this service is invitation-only rather than open.
        </Para>
        <div id="third-parties" className="scroll-mt-6">
          <Para>
            Third parties, exhaustively: <Em>Resend</Em> (delivers invitation emails: the address, the message and the code in it, only when the owner invites someone by email), <Em>Google</Em> (identity verification and the Sheets API), <Em>Render</Em> (hosts
            the application) and <Em>Supabase</Em> (the managed Postgres holding the rows in <a href="#kept" className="text-paper underline decoration-edge underline-offset-4">§4</a>, in <Em>Singapore</Em>). No
            analytics, advertising, email-marketing or support-ticket processor is integrated and none is planned.
            So that the picture is complete rather than reassuring: the operator administers the service from
            Bangladesh, the rows live in Singapore, and the application runs on Render — which means your metadata crosses borders by design, even
            though the cell contents themselves never reach us.
          </Para>
        </div>
      </>
    ),
  },
  {
    id: "deletion",
    index: "10",
    heading: "No ads, no sale of data, no third-party analytics — and your choices",
    body: (
      <>
        <Para>
          This is a fact of the build, not a promise: no analytics or telemetry dependency exists, the only
          outbound network calls in server code go to Google APIs and, for invitation emails, Resend, there is no marketing email feature, and the
          Content-Security-Policy restricts scripts and network requests to this origin, so these pages cannot
          report to a tracker even by accident. Your data is not sold, shared with advertisers or used for
          profiling.
        </Para>
        <Para>
          <Em>Self-service today:</Em> sign out; disconnect a Google connection (<a href="#google" className="text-paper underline decoration-edge underline-offset-4">§5</a>); revoke or regenerate a key;
          remove a registered spreadsheet, which takes its endpoints with it; read your own logs and analytics.{" "}
          <Em>Not self-service:</Em> editing profile fields (they are re-seeded from Google at sign-in), exporting your
          data as a file, and closing your account.
        </Para>
        <Para>
          Account closure is an owner action. It removes your profile, Google connections, registered
          spreadsheets, endpoints and keys. It does <Em>not</Em> remove your request-log rows, and it does not remove
          the operator&#39;s audit history — see <a href="#logs" className="text-paper underline decoration-edge underline-offset-4">§8</a> for why, and note that the retained log rows carry your account
          email. Closure cannot be performed on the account that issued invitations, on the operator&#39;s own
          account, or on the only remaining owner.
        </Para>
        <Para>
          Email <a href="mailto:support@zaber.tech" className="text-paper underline decoration-edge underline-offset-4">support@zaber.tech</a> to ask what we hold, or to correct or export it. There is no request form, no
          automated workflow and no promised response deadline: the request reaches one person who holds the
          database.
        </Para>
      </>
    ),
  },
  {
    id: "children",
    index: "11",
    heading: "Jurisdiction, children, changes",
    body: (
      <>
        <Para>
          The operator is established in <Em>Dhaka, Bangladesh</Em>, and Bangladeshi law governs this policy.
          Bangladesh has no general personal-data statute in force comparable to the GDPR or CCPA, so this policy
          claims compliance with no regime; the access, correction and export routes in <a href="#deletion" className="text-paper underline decoration-edge underline-offset-4">§10</a> are the operator&#39;s own
          practice and are honoured on request rather than a statutory entitlement. The service is not directed at
          children and implements no age verification: admission requires a Google account plus a code the owner
          chose to hand over.
        </Para>
        <div id="changes" className="scroll-mt-6">
          <Para>
            This policy lives in the repository beside the code it describes and is republished when the code
            changes what is stored — last updated <Em>6 November 2026</Em>. The published page is the only notice of a
            change; there is no email or in-product notification mechanism. If this page and the schema disagree
            about what is stored, the schema is right and this page is wrong; tell the operator at{" "}
            <a href="mailto:support@zaber.tech" className="text-paper underline decoration-edge underline-offset-4">support@zaber.tech</a>.
          </Para>
        </div>
        <hr className="border-rule" />
      </>
    ),
  },
]

export default function PrivacyPage() {
  return (
    <LegalDocument
      folio="Legal · Public surface"
      title="Sheet Zaber — Privacy Policy"
      description="Operator facts supplied 2026-11-06 by Osayeed Zaber, who owns the service. Nothing here is a template filler: each clause is written from the shipped code and schema."
      facts={[
        { label: "Last updated", value: "6 November 2026" },
        { label: "Applies to", value: "sheet.zaber.tech" },
        { label: "Operator", value: "Osayeed Zaber" },
        { label: "Contact", value: "support@zaber.tech" },
      ]}
      sections={SECTIONS}
    />
  )
}
