import type { Field } from 'payload'

import {
  PUBLICATION_MODERATION_LABELS,
  PUBLICATION_MODERATION_MODES,
  PUBLICATION_TRIGGER_LABELS,
  PUBLICATION_TRIGGERS,
} from './publication'

/**
 * A tenant's publish and moderation settings (PJ-32): a `jobPublication` group on the tenants
 * collection (or the single-tenant settings global). The defaults are the generic ones from
 * `publication.ts`; the legacy Vanuatu Wok behaviour is the `vwok-publication` seed.
 */

const validateTrigger = (value: unknown): string | true => {
  if (value === null || value === undefined || value === '') return true
  return PUBLICATION_TRIGGERS.includes(value as never) || 'Pick one of the listed go-live rules'
}

/** A tenant's publish/moderation fields, shared by the tenants collection and the global. */
export const tenantPublicationField = (condition?: (data: Record<string, unknown>) => boolean): Field => ({
  name: 'jobPublication',
  type: 'group',
  admin: {
    ...(condition ? { condition } : {}),
    description:
      'When a job goes live and whether it needs a site manager’s approval. Every rule is per site.',
  },
  fields: [
    {
      name: 'moderation',
      type: 'select',
      defaultValue: 'never',
      options: PUBLICATION_MODERATION_MODES.map((value) => ({
        label: PUBLICATION_MODERATION_LABELS[value],
        value,
      })),
      admin: { description: 'Which jobs wait for a site manager before going live.' },
    },
    {
      name: 'trustedGoLive',
      type: 'select',
      defaultValue: 'on-submit',
      options: PUBLICATION_TRIGGERS.map((value) => ({ label: PUBLICATION_TRIGGER_LABELS[value], value })),
      validate: validateTrigger as never,
      admin: { description: 'For a trusted organisation’s jobs.' },
    },
    {
      name: 'newEmployerGoLive',
      type: 'select',
      defaultValue: 'after-approval',
      options: PUBLICATION_TRIGGERS.map((value) => ({ label: PUBLICATION_TRIGGER_LABELS[value], value })),
      validate: validateTrigger as never,
      admin: { description: 'For an organisation that is not trusted yet.' },
    },
    {
      name: 'trustOnApproval',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description:
          'Off by default (no automatic trust). When on, a tenant admin approving a job also marks its organisation as trusted, so its later jobs go live before payment.',
      },
    },
  ],
})
