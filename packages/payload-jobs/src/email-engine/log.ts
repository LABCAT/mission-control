import type { CollectionConfig, CollectionSlug, Field } from 'payload'

import { authenticatedAccess, isSeekerOnly, tenantContentWriteAccess } from '../access'
import { deliverabilityStats } from './deliverability'
import { mergeCollectionAccess, type CollectionAccess } from '../slugs'

export const EMAIL_LOG_SLUG = 'email-log'

/**
 * `sent` means handed to the transport. The rest after `skipped` come from the transport's
 * delivery events (PJ-107) and only ever move a row forward (see `STATUS_RANK` in deliverability).
 */
export const EMAIL_LOG_STATUSES = [
  'sent',
  'failed',
  'skipped',
  'deferred',
  'delivered',
  'bounced',
  'rejected',
  'complained',
] as const
export type EmailLogStatus = (typeof EMAIL_LOG_STATUSES)[number]

export type EmailLogOptions = {
  access?: CollectionAccess
  slug?: string
  templatesSlug?: string
  tenantScoped?: boolean
}

const readOnly = { admin: { readOnly: true } } as const

/**
 * The email log (PJ-50). It records that an email happened, never what it said: no body, no
 * subject and no attachments are stored. The recipient is shown for the tenant's visible period,
 * then masked by the nightly job; rows are deleted after the tenant's delete period.
 *
 * Only the system writes to it (`overrideAccess`); staff can read their own site's rows.
 */
export const emailLogCollection = ({
  access,
  slug = EMAIL_LOG_SLUG,
  templatesSlug = 'email-templates',
  tenantScoped = true,
}: EmailLogOptions = {}): CollectionConfig => ({
  slug,
  access: mergeCollectionAccess(
    {
      create: () => false,
      delete: () => false,
      read: (args) => (isSeekerOnly(args.req.user as never) ? false : authenticatedAccess(args)),
      update: () => false,
    },
    access,
  ),
  admin: {
    defaultColumns: ['sentAt', 'event', 'recipient', 'status'],
    description: 'Every email the site sent or skipped. Message text is never stored.',
    group: 'Settings',
    useAsTitle: 'event',
  },
  defaultSort: '-sentAt',
  // PJ-107: `GET /api/<log slug>/deliverability?days=30` for the admin numbers. The user's own
  // read access decides which tenants' rows are counted.
  endpoints: [
    {
      handler: async (req) => {
        if (!tenantContentWriteAccess({ req } as never)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const days = Math.min(Math.max(Number(req.searchParams.get('days')) || 30, 1), 365)

        return Response.json(await deliverabilityStats({ days, logSlug: slug, payload: req.payload, req, tenantID: null }))
      },
      method: 'get',
      path: '/deliverability',
    },
  ],
  fields: [
    { name: 'event', type: 'text', required: true, index: true, ...readOnly },
    {
      name: 'template',
      type: 'relationship',
      relationTo: templatesSlug as CollectionSlug,
      admin: { description: 'Empty when the standard text was used.', readOnly: true },
    },
    { name: 'linkedCollection', type: 'text', ...readOnly },
    { name: 'linkedID', type: 'text', ...readOnly },
    { name: 'recipient', type: 'text', ...readOnly },
    {
      name: 'recipientMasked',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: { description: 'Set by the nightly job once the visible period has passed.', readOnly: true },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      index: true,
      options: EMAIL_LOG_STATUSES.map((value) => ({ label: value, value })),
      ...readOnly,
    },
    {
      name: 'messageId',
      type: 'text',
      index: true,
      admin: { description: 'The transport’s id for the message (no angle brackets). Matches delivery events.', readOnly: true },
    },
    {
      name: 'bounceType',
      type: 'select',
      options: ['hard', 'soft'].map((value) => ({ label: value, value })),
      admin: { description: 'Set when the message bounced.', readOnly: true },
    },
    { name: 'statusAt', type: 'date', admin: { description: 'When the last delivery event arrived.', readOnly: true } },
    { name: 'reason', type: 'text', admin: { description: 'Why it was skipped or failed.', readOnly: true } },
    {
      name: 'redirected',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: 'Sent to the test inbox instead of the recipient (non-production).', readOnly: true },
    },
    { name: 'sentAt', type: 'date', required: true, index: true, ...readOnly },
  ] as Field[],
  indexes: tenantScoped ? [{ fields: ['tenant', 'sentAt'] }] : [],
  versions: false,
})
