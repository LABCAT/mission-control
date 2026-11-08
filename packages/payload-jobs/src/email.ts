import type { Payload } from 'payload'

/**
 * The tenant fields an outgoing email needs. A real tenant document carries more fields;
 * this keeps the email module decoupled from the CMS's generated types, and any object with
 * these two fields satisfies it.
 */
export type TenantEmailSender = {
  emailFromName?: null | string
  emailFromAddress?: null | string
}

/** A tenant email before the sender is applied. */
export type TenantEmailMessage = {
  tenant: TenantEmailSender
  to: string
  subject: string
  html: string
}

/**
 * A tenant email after the sender is applied — a Payload/nodemailer message whose `from`
 * comes from the tenant rather than a hardcoded sender.
 */
export type MappedTenantEmail = {
  from: { name?: string; address: string }
  to: string
  subject: string
  html: string
}

/** The slice of the Payload API the tenant email sender needs. */
export type PayloadEmailClient = Pick<Payload, 'sendEmail'>

/**
 * Build the Payload/nodemailer message for a tenant email. The `from` name and address are
 * taken from the tenant, so every email is sent as that tenant.
 */
export const mapTenantEmailMessage = ({
  tenant,
  to,
  subject,
  html,
}: TenantEmailMessage): MappedTenantEmail => ({
  from: {
    ...(tenant.emailFromName ? { name: tenant.emailFromName } : {}),
    address: tenant.emailFromAddress ?? '',
  },
  to,
  subject,
  html,
})

/**
 * Create a tenant email sender bound to a Payload client. The payload is injected here (an
 * internal boundary) so callers use the task's contract directly:
 *
 *   const sendTenantEmail = createTenantEmailSender(payload)
 *   await sendTenantEmail({ tenant, to, subject, html })
 *
 * The sender delegates to the configured Payload email adapter, which uses the Cloudflare
 * Email Sending binding in Workers and logs to the console in dev.
 */
export const createTenantEmailSender =
  (payload: PayloadEmailClient) =>
  (message: TenantEmailMessage): Promise<unknown> =>
    payload.sendEmail(mapTenantEmailMessage(message))
