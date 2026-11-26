import type { Payload } from 'payload'

import {
  sendTemplate,
  type EmailTemplateEvent,
  type EmailVariable,
  type SendTemplateResult,
} from '@mission-control/payload-jobs'

/**
 * The alert emails (PJ-47). Everything goes out through PJ-50's `sendTemplate`: the tenant's
 * template and layout, its on/off switch for the event, the non-production redirect, and the
 * email log. This package only declares the two events and maps an alert to a record.
 *
 * Host wiring: add `ALERT_EMAIL_TEMPLATE_EVENTS` to `payloadJobs({ email: { events } })` so
 * site managers can edit them. A host that sends mail some other way can pass its own
 * `sendEmail` to `payloadJobsAlerts`; it has the same shape as `sendTemplate` plus the context.
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

/** What a sender needs besides the record: the Payload instance and the alerts collection. */
export type AlertEmailContext = { alertsSlug: string; payload: Payload }

export type AlertEmailSender = (
  event: AlertEmailEvent,
  doc: AlertEmailDoc,
  context: AlertEmailContext,
) => Promise<unknown> | unknown

const variable = (key: string, label: string): EmailVariable => ({
  key,
  label,
  resolve: (doc) => {
    const value = doc[key]

    return typeof value === 'string' ? value : ''
  },
})

/** The events and variables for `payloadJobs({ email: { events } })`. */
export const ALERT_EMAIL_TEMPLATE_EVENTS: EmailTemplateEvent[] = [
  {
    defaultBody: [
      ['Confirm your job alert for ', { variable: 'alertSummary' }, ' (', { variable: 'frequency' }, '):'],
      [{ variable: 'confirmUrl' }],
      ['If you did not ask for this, ignore this email and nothing will be sent.'],
    ],
    defaultSubject: 'Confirm your job alert on {{siteName}}',
    label: 'Job alert: confirm subscription',
    recipient: (doc) => (typeof doc.email === 'string' ? doc.email : undefined),
    slug: 'alert-confirm',
    variables: [
      variable('siteName', 'Site name'),
      variable('alertSummary', 'What the alert searches for'),
      variable('frequency', 'How often it is sent (daily or weekly)'),
      variable('confirmUrl', 'Confirmation link'),
      variable('manageUrl', 'Manage my alerts link'),
    ],
  },
  {
    defaultBody: [
      ['Manage your job alerts on ', { variable: 'siteName' }, ':'],
      [{ variable: 'manageUrl' }],
      ['The link works for 30 days. If you did not ask for it, ignore this email.'],
    ],
    defaultSubject: 'Manage your job alerts on {{siteName}}',
    label: 'Job alerts: manage my alerts link',
    recipient: (doc) => (typeof doc.email === 'string' ? doc.email : undefined),
    slug: 'alert-manage-link',
    variables: [variable('siteName', 'Site name'), variable('manageUrl', 'Manage my alerts link')],
  },
]

type SendTemplateFn = (
  payload: Payload,
  event: string,
  doc: Record<string, unknown>,
  options?: { linked?: { collection: string; id: number | string }; tenant?: number | string; to?: string },
) => Promise<SendTemplateResult>

/**
 * The default sender: PJ-50's `sendTemplate`. The record is the variables plus the address and
 * tenant, the alert is the linked record in the email log (a pointer, never content), and a
 * failed send throws so the visitor is told. A skipped one (the tenant switched the email off,
 * or a preview has nowhere to redirect it) is not an error.
 */
export const createAlertTemplateSender =
  (send: SendTemplateFn = sendTemplate as SendTemplateFn): AlertEmailSender =>
  async (event, doc, { alertsSlug, payload }) => {
    const result = await send(
      payload,
      event,
      { ...doc.variables, email: doc.email, tenant: doc.tenant },
      {
        ...(doc.id === undefined ? {} : { linked: { collection: alertsSlug, id: doc.id } }),
        tenant: doc.tenant,
        to: doc.email,
      },
    )

    if (result.status === 'failed') throw new Error(result.error ?? 'the alert email was not sent')
  }
