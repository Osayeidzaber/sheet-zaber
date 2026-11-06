import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { InvitationForm } from "@/components/app/invitation-form"
import { ShinyText } from "@/components/fx/shiny-text"
import { OzMark } from "@/components/marketing/marketing-header"
import { PillLink } from "@/components/ui/button"
import { Folio, Rings, TitleAside } from "@/components/ui/chapter"
import { ErrorState } from "@/components/ui/state"
import { env } from "@/lib/env"
import { readUser } from "@/server/auth/guards"

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Sheet Zaber with Google. Registration is invitation-only.",
  robots: { index: false, follow: true },
}

/*
 * `/login` is the frontend's page (docs/integration-status.md Ownership): the backend
 * supplies `/auth/google`, the invitation form endpoint and the query states below, and
 * tests them at route/service level — not through this file.
 *
 * Every error code rendered here is one a real route actually emits; the words are ours,
 * the codes are kept as a small mono detail so support can trace them:
 *  - oauth_not_configured  src/app/auth/google/route.ts:23, src/app/auth/google/connect/route.ts:26
 *  - oauth_denied          src/app/auth/google/callback/route.ts:63
 *  - oauth_state           src/app/auth/google/callback/route.ts:71
 *  - oauth_failed          src/app/auth/google/callback/route.ts:52,76
 *  - email_unverified      src/app/auth/google/callback/route.ts:81
 *  - disabled              src/app/auth/google/callback/route.ts:112
 * and `?step=invitation`    src/app/auth/google/callback/route.ts:104 (first Google sign-in,
 * `sz_pending` set — the invitation code comes next).
 */

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  oauth_not_configured: {
    title: "Google sign-in is not configured on this server",
    body: "This deployment has no Google OAuth credentials, so there is currently no way to sign in. In production the server refuses to start without them; on a development machine the operator must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
  },
  oauth_denied: {
    title: "Google sign-in was cancelled",
    body: "You returned from Google without granting access. Nothing was changed — start sign-in again whenever you are ready.",
  },
  oauth_state: {
    title: "That sign-in attempt no longer matches this browser",
    body: "The one-shot state Google echoes back was missing, tampered with, or expired. Start sign-in again; if it keeps happening, clear cookies for this site and retry.",
  },
  oauth_failed: {
    title: "Google sign-in could not be completed",
    body: "Google or Sheet Zaber did not finish the exchange. No account was created and nothing was changed. Try again; if it persists, tell the operator.",
  },
  email_unverified: {
    title: "Google says this email address is not verified",
    body: "Sheet Zaber only accepts Google identities with a verified email, as Google reports it. Verify the address with Google, then sign in again.",
  },
  disabled: {
    title: "This Sheet Zaber account is disabled",
    body: "Your sign-in worked, but an owner has disabled this account, so the session was refused. Ask an owner to re-enable it in Admin.",
  },
}

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  // Checked against the users row, so a disabled account stays here instead of looping.
  if (await readUser()) redirect("/overview")

  const params = await searchParams
  const errorCode = firstValue(params.error)
  const invitationStep = firstValue(params.step) === "invitation"
  const knownError = errorCode === undefined ? undefined : ERROR_COPY[errorCode]

  return (
    <main className="relative isolate grid min-h-screen overflow-hidden lg:grid-cols-[1.25fr_1fr]">
      <Rings at={["30%", "60%"]} className="-z-10" />

      <header className="gutter flex flex-col justify-between gap-12 py-8 lg:border-r lg:border-rule">
        <Link href="/" aria-label="Sheet Zaber, home" className="hero-fade flex w-fit flex-col gap-4">
          <OzMark height={72} />
          <ShinyText trigger="loop" speed={3} className="folio folio-strong" color="var(--mist)" shineColor="var(--press)">
            Sheet Zaber
          </ShinyText>
        </Link>
        <div className="flex flex-col gap-6">
          <Folio aside="Invitation only">00 — The door</Folio>
          <h1 className="display text-[clamp(64px,11vw,176px)] text-paper">
            <span className="hero-line">
              <span className="hero-rise whitespace-nowrap">
                Sign <TitleAside>in.</TitleAside>
              </span>
            </span>
          </h1>
          <ShinyText
            trigger="loop"
            speed={4}
            delay={1}
            className="aside block text-[clamp(22px,2.6vw,34px)] leading-[1.2]"
            color="var(--mist)"
            shineColor="var(--press)"
          >
            Your Google Sheet, as a private API.
          </ShinyText>
          <p className="max-w-[46ch] text-[15px] leading-[1.6] text-mist">
            Private, invitation-only Google Sheets API platform. There is no sign-up here:
            you sign in with Google, and an invitation code completes the registration.
          </p>
        </div>
      </header>

      <div className="reveal mx-auto flex w-full max-w-[520px] flex-col justify-center gap-8 px-4 py-10 sm:px-8">

        {errorCode !== undefined ? (
          knownError ? (
            <ErrorState title={knownError.title} body={knownError.body} code={errorCode} />
          ) : (
            <ErrorState
              title="Sign-in could not be completed"
              body="The sign-in flow returned an error this page does not recognise. Nothing was changed on your account; try signing in again."
              code={errorCode}
            />
          )
        ) : null}

        {env.googleOAuthConfigured ? (
          <div className="flex flex-col gap-3">
            <PillLink href="/auth/google" prefetch={false} variant="solid" size="lg" className="w-full">
              Sign in with Google
            </PillLink>
            <p className="text-center text-[13px] text-dust">
              The only way in. Google&apos;s account chooser opens; Sheet Zaber never sees
              your password.
            </p>
          </div>
        ) : (
          <ErrorState
            title="Google sign-in is not configured on this server"
            body="This dev deployment has no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, so the sign-in button is not shown — it would only bounce you back here with an error. Configure the credentials (see GOOGLE_OAUTH_SETUP.md) and restart."
          />
        )}

        {invitationStep ? (
          <section
            aria-labelledby="invitation-heading"
            className="panel flex flex-col gap-4 p-5"
          >
            <div>
              <h2 id="invitation-heading" className="text-[18px] font-semibold tracking-[-0.02em]">
                Enter your invitation code
              </h2>
              <p className="mt-1 text-[13px] leading-[1.6] text-dust">
                Google verified you, but this Sheet Zaber instance is invitation-only and
                your account does not exist yet. Paste the code its owner gave you. If you
                cancel or the sign-in goes stale, start over with Google.
              </p>
            </div>
            <InvitationForm />
          </section>
        ) : (
          <p className="border-t border-rule pt-5 text-center text-[13px] leading-[1.6] text-dust">
            Already have an invitation code? Sign in with Google first — the code is asked
            for on the step that follows.
          </p>
        )}

        <footer className="text-center">
          <p className="folio">Invitation-only · Google sign-in · No passwords stored</p>
        </footer>
      </div>
    </main>
  )
}
