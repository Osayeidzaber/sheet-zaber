import "server-only"

/*
 * The email barrel (`backend-api-contract.md` §4 style): outside `src/server/email/**` nothing
 * imports `./client` directly — the transport, its types and its config helpers arrive through
 * this file, so the Resend endpoint and the API key stay invisible to every other server module.
 */

export {
  DEFAULT_TIMEOUT_MS,
  emailSendConfigError,
  MAX_EMAIL_BODY_BYTES,
  readEmailSendConfig,
  RESEND_EMAILS_ENDPOINT,
  sendEmail,
  type EmailMessage,
  type EmailSendConfig,
  type EmailTransportDeps,
} from "./client"

export {
  buildInvitationEmail,
  formatInvitationExpiry,
  invitationSignInUrl,
  type InvitationEmailInput,
} from "./invitation"
