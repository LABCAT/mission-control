import type { DefaultParagraph, EmailTemplateEvent, EmailVariable } from './events'

/**
 * The job, order and organisation emails (PJ-51, decision 19 Nov: the legacy set, trimmed).
 * One event per email an action sends. Each has its own per-tenant on/off switch, so the
 * admin copy of "job submitted" is its own event with its own switch.
 *
 * Out of scope here: applications (PJ-45), alerts digest (PJ-48), expiry (PJ-52), sign-in,
 * welcome and reset (PJ-109), invite/join/duplicate (PJ-29) and the contact form (PJ-102).
 */

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const plain = (key: string, label: string, from: string = key): EmailVariable => ({
  key,
  label,
  resolve: (doc) => str(doc[from]),
})

const JOB_VARIABLES: EmailVariable[] = [
  plain('firstName', 'First name'),
  plain('jobTitle', 'Job title', 'title'),
  plain('organisationName', 'Organisation'),
  plain('jobUrl', 'Job link'),
]

/** What the employer is told about the order a job came with. Empty when the job has none. */
const ORDER_VARIABLES: EmailVariable[] = [
  plain('orderNumber', 'Order number'),
  plain('orderTotal', 'Order total'),
  plain('orderStatus', 'Order status'),
  plain('paymentMethod', 'Payment method'),
]

const ORDER_SUMMARY_PARAGRAPH: DefaultParagraph = [
  'Order ',
  { variable: 'orderNumber' },
  ': ',
  { variable: 'orderTotal' },
  ' (',
  { variable: 'orderStatus' },
  ').',
]

const hello: DefaultParagraph = ['Hello ', { variable: 'firstName' }, ',']

const recipientOf = (field: string) => (doc: Record<string, unknown>) => str(doc[field]) || undefined

export const NOTIFICATION_EVENTS: EmailTemplateEvent[] = [
  {
    slug: 'job-submitted',
    defaultBody: [
      hello,
      ['Thanks for submitting ', { variable: 'jobTitle' }, '. We will review it shortly.'],
      ORDER_SUMMARY_PARAGRAPH,
    ],
    defaultSubject: 'We received your job: {{jobTitle}}',
    label: 'Job submitted (employer)',
    recipient: recipientOf('employerEmail'),
    variables: [...JOB_VARIABLES, ...ORDER_VARIABLES],
  },
  {
    slug: 'job-submitted-admin',
    defaultBody: [
      ['A new job was submitted: ', { variable: 'jobTitle' }, ' by ', { variable: 'organisationName' }, '.'],
      ORDER_SUMMARY_PARAGRAPH,
    ],
    defaultSubject: 'New job submitted: {{jobTitle}}',
    label: 'Job submitted (site admin)',
    recipient: recipientOf('adminEmail'),
    variables: [...JOB_VARIABLES, ...ORDER_VARIABLES],
  },
  {
    slug: 'job-edited-pending',
    defaultBody: [
      ['The job ', { variable: 'jobTitle' }, ' by ', { variable: 'organisationName' }, ' was edited and is waiting for approval.'],
    ],
    defaultSubject: 'Edited job waiting for approval: {{jobTitle}}',
    label: 'Edited job waiting for approval (site admin)',
    recipient: recipientOf('adminEmail'),
    variables: JOB_VARIABLES,
  },
  {
    slug: 'job-approved',
    defaultBody: [hello, [{ variable: 'jobTitle' }, ' is now live.']],
    defaultSubject: 'Your job is live: {{jobTitle}}',
    label: 'Job approved and live (employer)',
    recipient: recipientOf('employerEmail'),
    variables: JOB_VARIABLES,
  },
  {
    slug: 'order-created',
    defaultBody: [hello, ['Thanks for your order.'], ORDER_SUMMARY_PARAGRAPH],
    defaultSubject: 'Your order {{orderNumber}}',
    label: 'Order created, no job (owner)',
    recipient: recipientOf('ownerEmail'),
    variables: [plain('firstName', 'First name'), plain('organisationName', 'Organisation'), ...ORDER_VARIABLES],
  },
  {
    slug: 'order-created-admin',
    defaultBody: [['A new order was placed by ', { variable: 'organisationName' }, '.'], ORDER_SUMMARY_PARAGRAPH],
    defaultSubject: 'New order {{orderNumber}}',
    label: 'Order created, no job (site admin)',
    recipient: recipientOf('adminEmail'),
    variables: [plain('organisationName', 'Organisation'), ...ORDER_VARIABLES],
  },
  {
    slug: 'order-paid',
    defaultBody: [hello, ['We received payment for order ', { variable: 'orderNumber' }, '. Thank you.']],
    defaultSubject: 'Payment received for order {{orderNumber}}',
    label: 'Order paid (owner)',
    recipient: recipientOf('ownerEmail'),
    variables: [plain('firstName', 'First name'), plain('organisationName', 'Organisation'), ...ORDER_VARIABLES],
  },
  {
    slug: 'order-cancelled',
    defaultBody: [hello, ['Order ', { variable: 'orderNumber' }, ' was cancelled.']],
    defaultSubject: 'Order {{orderNumber}} cancelled',
    label: 'Order cancelled (owner)',
    recipient: recipientOf('ownerEmail'),
    variables: [plain('firstName', 'First name'), plain('organisationName', 'Organisation'), ...ORDER_VARIABLES],
  },
  {
    slug: 'organisation-page-requested',
    defaultBody: [[{ variable: 'organisationName' }, ' has asked for a public page. Review it in the admin.']],
    defaultSubject: 'Organisation page requested: {{organisationName}}',
    label: 'Organisation page requested (site admin)',
    recipient: recipientOf('adminEmail'),
    variables: [plain('organisationName', 'Organisation')],
  },
  {
    slug: 'organisation-page-approved',
    defaultBody: [hello, ['The public page for ', { variable: 'organisationName' }, ' is now live.']],
    defaultSubject: 'Your organisation page is live: {{organisationName}}',
    label: 'Organisation page approved (owner)',
    recipient: recipientOf('ownerEmail'),
    variables: [plain('firstName', 'First name'), plain('organisationName', 'Organisation'), plain('pageUrl', 'Page link')],
  },
]
