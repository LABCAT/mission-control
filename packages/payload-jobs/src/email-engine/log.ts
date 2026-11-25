import type { CollectionConfig, CollectionSlug, Field } from 'payload'

import { authenticatedAccess, isSeekerOnly } from '../access'
import { mergeCollectionAccess, type CollectionAccess } from '../slugs'

export const EMAIL_LOG_SLUG = 'email-log'

/** `sent` means handed to the transport. PJ-107 adds delivery states (delivered, bounced). */
export const EMAIL_LOG_STATUSES = ['sent', 'failed', 'skipped'] as const
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
