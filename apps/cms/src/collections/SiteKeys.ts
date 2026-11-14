import type {
  CollectionAfterChangeHook,
  CollectionAfterReadHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
} from 'payload'

import { superAdminAccess } from '../access'
import { generateSiteKey } from '../site-keys'

const RAW_KEY_CONTEXT = 'missionControlRawSiteKey'

/**
 * Create the key server-side. The raw value never travels through request data: it is
 * stashed on the request context so the afterChange hook can reveal it once.
 */
export const generateSiteKeyOnCreate: CollectionBeforeValidateHook = async ({
  data,
  operation,
  req,
}) => {
  if (operation !== 'create') return data

  const { key, keyHash } = await generateSiteKey()
  req.context[RAW_KEY_CONTEXT] = key

  return { ...data, keyHash }
}

/** Return the raw key in the create response only. Later reads never see it. */
export const revealSiteKeyOnce: CollectionAfterChangeHook = ({ doc, operation, req }) => {
  if (operation !== 'create') return doc

  const rawKey = req.context[RAW_KEY_CONTEXT]
  if (typeof rawKey !== 'string') return doc

  delete req.context[RAW_KEY_CONTEXT]

  return { ...doc, key: rawKey }
}

/**
 * Belt and braces: the field access already hides the digest, but local API calls with
 * `overrideAccess: true` skip field access. Strip it here so the digest is never returned.
 */
export const hideSiteKeyHash: CollectionAfterReadHook = ({ doc }) => {
  const result = { ...doc }
  delete (result as Record<string, unknown>).keyHash

  return result
}

export const SiteKeys: CollectionConfig = {
  slug: 'site-keys',
  admin: {
    defaultColumns: ['label', 'tenant', 'createdAt'],
    description: 'Keys public sites use to read their own tenant. The raw key is shown once.',
    group: 'Tenants',
    useAsTitle: 'label',
  },
  access: {
    create: superAdminAccess,
    delete: superAdminAccess,
    read: superAdminAccess,
    update: superAdminAccess,
  },
  hooks: {
    afterChange: [revealSiteKeyOnce],
    afterRead: [hideSiteKeyHash],
    beforeValidate: [generateSiteKeyOnCreate],
  },
  fields: [
    {
      name: 'label',
      type: 'text',
      required: true,
      admin: {
        description: 'Where this key is used, for example vanuatu-wok-web.',
      },
    },
    {
      name: 'tenant',
      type: 'relationship',
      relationTo: 'tenants',
      required: true,
      index: true,
      admin: {
        description: 'The only tenant this key can read.',
      },
    },
    {
      name: 'keyHash',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: {
        hidden: true,
        readOnly: true,
      },
      access: {
        read: () => false,
      },
    },
    {
      name: 'key',
      type: 'text',
      virtual: true,
      admin: {
        description: 'Copy this now. It is shown once and cannot be retrieved again.',
        position: 'sidebar',
        readOnly: true,
      },
    },
  ],
  versions: false,
}
