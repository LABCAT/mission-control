/**
 * The one place alert emails leave through (PJ-47). The email engine is PJ-50's
 * `sendTemplate(event, doc)`; until it is merged this package only knows the seam, so the host
 * passes `sendEmail` in through the plugin options and the tests use a fake. The signature
 * matches `sendTemplate`, so wiring is `payloadJobsAlerts({ sendEmail: sendTemplate })`.
 */

export const ALERT_EMAIL_EVENTS = ['alert-confirm', 'alert-manage-link'] as const
export type AlertEmailEvent = (typeof ALERT_EMAIL_EVENTS)[number]

/** The record an alert email is about. `variables` are exactly the chips the event declares. */
export type AlertEmailDoc = {
  /** The alert the email is about, when there is one. */
  id?: number | string
  /** The recipient. Alert emails go to exactly one subscriber. */
  email: string
  tenant: number | string
  variables: Record<string, string>
}

export type AlertEmailSender = (event: AlertEmailEvent, doc: AlertEmailDoc) => Promise<unknown> | unknown

/** The events and variables PJ-50/PJ-51 build templates for. Built-in text is a plain fallback. */
export const ALERT_EMAIL_EVENT_DEFINITIONS = [
  {
    addOn: 'alerts',
    defaults: {
      body: 'Confirm your job alert for {{alertSummary}} ({{frequency}}): {{confirmUrl}}\n\nIf you did not ask for this, ignore this email and nothing will be sent.',
      subject: 'Confirm your job alert on {{siteName}}',
    },
    key: 'alert-confirm',
    label: 'Job alert: confirm subscription',
    recipients: ['subscriber'],
    variables: [
      { key: 'siteName', label: 'Site name' },
      { key: 'alertSummary', label: 'What the alert searches for' },
      { key: 'frequency', label: 'How often it is sent (daily or weekly)' },
      { key: 'confirmUrl', label: 'Confirmation link' },
      { key: 'manageUrl', label: 'Manage my alerts link' },
    ],
  },
  {
    addOn: 'alerts',
    defaults: {
      body: 'Manage your job alerts on {{siteName}}: {{manageUrl}}\n\nThe link works for 30 days. If you did not ask for it, ignore this email.',
      subject: 'Manage your job alerts on {{siteName}}',
    },
    key: 'alert-manage-link',
    label: 'Job alerts: manage my alerts link',
    recipients: ['subscriber'],
    variables: [
      { key: 'siteName', label: 'Site name' },
      { key: 'manageUrl', label: 'Manage my alerts link' },
    ],
  },
] as const
