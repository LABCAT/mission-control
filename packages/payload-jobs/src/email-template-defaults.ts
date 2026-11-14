/**
 * The email templates a job board sends, with their default subject, body and the
 * placeholders each one may use.
 *
 * The keys and text follow the legacy `appthemes-advanced-emails` set that replaced
 * JobRoller's emails on vanuatuwok.vu, restricted to the emails USAGE.md keeps. Emails for
 * dropped features (resume access and resume reminders, featured add-ons, the separate
 * volunteer flow, recurring payments, packs) are deliberately absent.
 *
 * Bodies are HTML fragments: PJ-50 wraps them in the shared layout and escapes the values
 * before it substitutes the placeholders. `{{total}}` is a formatted amount, built from the
 * order's integer minor units and the tenant currency.
 */

export const EMAIL_TEMPLATE_KEYS = [
  'new_user',
  'new_user_admin',
  'resend_confirmation',
  'new_job_admin',
  'new_job',
  'job_approved',
  'job_expiring',
  'expired_job',
  'job_canceled',
  'new_order',
  'order_complete',
  'new_application',
  'application_received',
  'organisation_listing_request',
  'organisation_live',
  'contact_form',
  'alert_confirm',
  'job_alerts_digest',
] as const

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number]

export type EmailTemplateDefinition = {
  body: string
  key: EmailTemplateKey
  /** Admin label for the template picker. */
  label: string
  /** Placeholders the sender fills, in first-use order, derived from the subject and body. */
  placeholders: readonly string[]
  subject: string
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g
const OPEN = /\{\{/g

/** The placeholder names in a string. Unclosed `{{` markers are skipped; see below. */
export const placeholdersIn = (value: string): string[] =>
  Array.from(value.matchAll(PLACEHOLDER), (match) => match[1] ?? '')

const define = (
  key: EmailTemplateKey,
  label: string,
  subject: string,
  body: string,
): EmailTemplateDefinition => ({
  body,
  key,
  label,
  placeholders: [...new Set([...placeholdersIn(subject), ...placeholdersIn(body)])],
  subject,
})

const signature = '<p>Regards,<br />{{siteName}}<br /><a href="{{siteUrl}}">{{siteUrl}}</a></p>'

export const EMAIL_TEMPLATE_DEFAULTS: readonly EmailTemplateDefinition[] = [
  // Account (AUDIT.md: register and confirm, resend confirmation, admin copy).
  define(
    'new_user',
    'New user welcome',
    'Welcome to {{siteName}}',
    '<p>Hi {{name}},</p>' +
      '<p>Thanks for registering with {{siteName}}. Confirm your email address to finish setting up your account:</p>' +
      '<p><a href="{{confirmUrl}}">{{confirmUrl}}</a></p>' +
      signature,
  ),
  define(
    'new_user_admin',
    'New user (admin)',
    '[{{siteName}}] New user registration',
    '<p>Dear Admin,</p>' +
      '<p>A new user has registered on {{siteName}}.</p>' +
      '<p>Name: {{name}}<br />Email: {{email}}<br />Role: {{role}}</p>' +
      '<p><a href="{{adminUrl}}">View the user in the admin</a></p>',
  ),
  define(
    'resend_confirmation',
    'Resend confirmation',
    'Confirm your {{siteName}} account',
    '<p>Hi {{name}},</p>' +
      '<p>You asked us to resend your confirmation link. Use it to finish setting up your account:</p>' +
      '<p><a href="{{confirmUrl}}">{{confirmUrl}}</a></p>' +
      signature,
  ),
  // Jobs (AUDIT.md: new job notice to the admin; submitted, approved, expiring, expired,
  // cancelled). The volunteer flow is a job type, so one approval email covers both.
  define(
    'new_job_admin',
    'New job (admin)',
    '[{{siteName}}] New job submitted',
    '<p>Dear Admin,</p>' +
      '<p>{{organisationName}} has submitted a job on {{siteName}}.</p>' +
      '<p>Title: {{jobTitle}}</p>' +
      '<p><a href="{{jobUrl}}">View the job</a><br /><a href="{{adminUrl}}">Edit the job</a></p>',
  ),
  define(
    'new_job',
    'Job submitted',
    '[{{siteName}}] Your job submission',
    '<p>Hi {{name}},</p>' +
      '<p>Thank you for your submission. We will let you know when "{{jobTitle}}" is live, or when it is ready for review.</p>' +
      '<p><a href="{{jobUrl}}">{{jobUrl}}</a></p>' +
      '<p>You can check the status of your jobs at any time from your dashboard:</p>' +
      '<p><a href="{{dashboardUrl}}">{{dashboardUrl}}</a></p>' +
      signature,
  ),
  define(
    'job_approved',
    'Job approved',
    '[{{siteName}}] Your job has been approved',
    '<p>Hi {{name}},</p>' +
      '<p>Your job listing, "{{jobTitle}}", has been approved and is now live.</p>' +
      '<p><a href="{{jobUrl}}">{{jobUrl}}</a></p>' +
      signature,
  ),
  define(
    'job_expiring',
    'Job expiring soon',
    '[{{siteName}}] Your job expires in {{daysRemaining}}',
    '<p>Hi {{name}},</p>' +
      '<p>Your job listing "{{jobTitle}}" is set to expire in {{daysRemaining}}, on {{expiresAt}}.</p>' +
      '<p><a href="{{jobUrl}}">{{jobUrl}}</a></p>' +
      '<p>You can relist it from your dashboard:</p>' +
      '<p><a href="{{dashboardUrl}}">{{dashboardUrl}}</a></p>' +
      signature,
  ),
  define(
    'expired_job',
    'Job expired',
    '[{{siteName}}] Your job has expired',
    '<p>Hi {{name}},</p>' +
      '<p>Your job listing, "{{jobTitle}}", has expired.</p>' +
      '<p>If you would like to relist it, go to the Ended tab in your dashboard and choose relist:</p>' +
      '<p><a href="{{dashboardUrl}}">{{dashboardUrl}}</a></p>' +
      signature,
  ),
  define(
    'job_canceled',
    'Job cancelled',
    '[{{siteName}}] Your job was cancelled',
    '<p>Hi {{name}},</p>' +
      '<p>Your job listing, "{{jobTitle}}", was cancelled.</p>' +
      '<p>You can still access it from your dashboard and submit it again if you wish:</p>' +
      '<p><a href="{{dashboardUrl}}">{{dashboardUrl}}</a></p>' +
      signature,
  ),
  // Commerce (AUDIT.md: submitted/published and order complete; invoice checkout is kept).
  define(
    'new_order',
    'Order received',
    '[{{siteName}}] Order #{{orderNumber}}',
    '<p>Hi {{name}},</p>' +
      '<p>Your order has been received and will be available as soon as the payment clears.</p>' +
      '<p>Order #{{orderNumber}}<br />Total: {{total}}<br />Payment method: {{paymentMethod}}</p>' +
      '<p><a href="{{dashboardUrl}}">View your orders</a></p>' +
      signature,
  ),
  define(
    'order_complete',
    'Order receipt',
    '[{{siteName}}] Receipt for order #{{orderNumber}}',
    '<p>Hi {{name}},</p>' +
      '<p>This email confirms that your payment has been received.</p>' +
      '<p>Order #{{orderNumber}}<br />Total paid: {{total}}</p>' +
      '<p><a href="{{dashboardUrl}}">View your orders</a></p>' +
      signature,
  ),
  // Applications (AUDIT.md: emailed to the employer, a copy to the applicant).
  define(
    'new_application',
    'New application',
    '[{{siteName}}] New application for {{jobTitle}}',
    '<p>Hello {{organisationName}},</p>' +
      '<p>{{applicantName}} ({{applicantEmail}}) has applied for "{{jobTitle}}".</p>' +
      '<p>Message:</p><p>{{message}}</p>' +
      '<p><a href="{{cvUrl}}">Download the CV</a><br /><a href="{{coverLetterUrl}}">Download the cover letter</a></p>' +
      signature,
  ),
  define(
    'application_received',
    'Application received',
    '[{{siteName}}] Your application for {{jobTitle}}',
    '<p>Hi {{name}},</p>' +
      '<p>Your application for "{{jobTitle}}" has been sent to {{organisationName}}.</p>' +
      '<p>If they need anything else, they will contact you directly.</p>' +
      signature,
  ),
  // Organisations (AUDIT.md: listing request to the admin, page live to the employer).
  define(
    'organisation_listing_request',
    'Organisation listing requested (admin)',
    '[{{siteName}}] Organisation page requested',
    '<p>Dear Admin,</p>' +
      '<p>{{organisationName}} has asked for an organisation page on {{siteName}}.</p>' +
      '<p><a href="{{adminUrl}}">Review the organisation</a></p>',
  ),
  define(
    'organisation_live',
    'Organisation page live',
    '[{{siteName}}] Your organisation page is live',
    '<p>Hi {{name}},</p>' +
      '<p>The page for {{organisationName}} is now live on {{siteName}}.</p>' +
      '<p><a href="{{organisationUrl}}">{{organisationUrl}}</a></p>' +
      signature,
  ),
  // Other (AUDIT.md: contact form; job alerts are kept).
  define(
    'contact_form',
    'Contact form message',
    '[{{siteName}}] Contact form message',
    '<p>Dear Admin,</p>' +
      '<p>{{name}} ({{email}}) sent a message through the contact form:</p>' +
      '<p>{{message}}</p>',
  ),
  define(
    'alert_confirm',
    'Job alert confirmation',
    '[{{siteName}}] Confirm your job alert',
    '<p>Hello,</p>' +
      '<p>Confirm that you want job alerts for {{email}} from {{siteName}}:</p>' +
      '<p><a href="{{confirmUrl}}">{{confirmUrl}}</a></p>' +
      '<p>If you did not ask for alerts, ignore this email and you will not receive any.</p>',
  ),
  define(
    'job_alerts_digest',
    'Job alerts digest',
    '[{{siteName}}] New jobs for you',
    '<p>Hello,</p>' +
      '<p>Here are the latest jobs that match your alert:</p>' +
      '{{jobList}}' +
      '<p>This alert was sent to {{email}}. ' +
      '<a href="{{manageUrl}}">Change your alert</a> · <a href="{{unsubscribeUrl}}">Unsubscribe</a></p>',
  ),
]

export const EMAIL_TEMPLATE_DEFAULT_BY_KEY: Record<EmailTemplateKey, EmailTemplateDefinition> =
  Object.fromEntries(
    EMAIL_TEMPLATE_DEFAULTS.map((template) => [template.key, template]),
  ) as Record<EmailTemplateKey, EmailTemplateDefinition>

export type PlaceholderCheck = { message: string } | { unknown: string[] }

/**
 * Check that every `{{placeholder}}` in the subject and body is one the template declares
 * and is closed. Catches typos such as `{{jobtitle}}`, which the renderer would otherwise
 * leave empty, and `{{name`, which it would send literally.
 */
export const checkTemplatePlaceholders = (template: {
  body: string
  key: null | string | undefined
  subject: string
}): PlaceholderCheck => {
  const definition = template.key
    ? EMAIL_TEMPLATE_DEFAULT_BY_KEY[template.key as EmailTemplateKey]
    : undefined

  if (!definition) return { unknown: [] }

  const text = `${template.subject}\n${template.body}`
  const used = placeholdersIn(text)
  const opens = (text.match(OPEN) ?? []).length

  if (opens !== used.length) {
    return { message: 'Close every {{placeholder}} with }}' }
  }

  const unknown = used.filter((name) => !definition.placeholders.includes(name))

  return unknown.length > 0 ? { unknown } : { unknown: [] }
}
