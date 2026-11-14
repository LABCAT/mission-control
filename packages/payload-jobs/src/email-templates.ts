import type { Access, CollectionConfig, Field } from 'payload'

import { hasAnyTenantRole, isSuperAdmin, type MissionControlUser } from './access'
import { checkTemplatePlaceholders, EMAIL_TEMPLATE_DEFAULTS } from './email-template-defaults'

/** Tenant roles that may read and change a tenant's email templates. */
export const EMAIL_TEMPLATE_EDITOR_ROLES = ['tenant-admin', 'editor'] as const

const canManageTemplates: Access = ({ req }) => {
  const user = req.user as MissionControlUser | null | undefined

  return isSuperAdmin(user) || hasAnyTenantRole(user, EMAIL_TEMPLATE_EDITOR_ROLES)
}

/**
 * System code (senders, seeds) reads templates with `overrideAccess: true`; the plugin
 * scopes these callbacks to the user's tenants.
 */
const validateSubject = (
  value: null | string | undefined,
  { siblingData }: { siblingData?: Record<string, unknown> },
): string | true => {
  if (!value) return 'Subject is required'

  const check = checkTemplatePlaceholders({
    body: '',
    key: siblingData?.key as string | undefined,
    subject: value,
  })

  if ('message' in check) return check.message
  if (check.unknown.length > 0) {
    return `Unknown placeholder: {{${check.unknown[0]}}}. Use the placeholders listed for this template.`
  }

  return true
}

const validateBody = (
  value: null | string | undefined,
  { siblingData }: { siblingData?: Record<string, unknown> },
): string | true => {
  if (!value) return 'Body is required'

  const check = checkTemplatePlaceholders({
    body: value,
    key: siblingData?.key as string | undefined,
    subject: '',
  })

  if ('message' in check) return check.message
  if (check.unknown.length > 0) {
    return `Unknown placeholder: {{${check.unknown[0]}}}. Use the placeholders listed for this template.`
  }

  return true
}

const fieldsFor = (tenantScoped: boolean): Field[] => [
  {
    name: 'key',
    type: 'select',
    required: true,
    index: true,
    // A tenant-scoped collection gets a compound unique index on (tenant, key) instead.
    unique: !tenantScoped,
    options: EMAIL_TEMPLATE_DEFAULTS.map((template) => ({
      label: template.label,
      value: template.key,
    })),
    admin: {
      description: 'Which email this template sends. One per key, per tenant.',
    },
  },
  {
    name: 'subject',
    type: 'text',
    required: true,
    admin: {
      description: 'May use {{placeholders}}.',
    },
    validate: validateSubject,
  },
  {
    name: 'body',
    type: 'textarea',
    required: true,
    admin: {
      description:
        'HTML with {{placeholders}}. Values are escaped when it is rendered, so do not wrap them in tags.',
    },
    validate: validateBody,
  },
  {
    name: 'enabled',
    type: 'checkbox',
    defaultValue: true,
    admin: {
      description: 'Turn off to stop sending this email.',
    },
  },
]

export type EmailTemplatesCollectionOptions = {
  slug?: string
  /**
   * Whether the multi-tenant plugin adds the `tenant` field. The plugin must also list the
   * slug in its `collections` option; this only controls the tenant-scoped unique index.
   */
  tenantScoped?: boolean
}

/**
 * Email templates. Each tenant edits its own subject and body; `seedEmailTemplates` fills
 * in the defaults. In multi-tenant mode `key` is unique per tenant, so a tenant cannot end
 * up with two templates for the same email.
 */
export const emailTemplatesCollection = ({
  slug = 'email-templates',
  tenantScoped = true,
}: EmailTemplatesCollectionOptions = {}): CollectionConfig => ({
  slug,
  admin: {
    defaultColumns: ['key', 'enabled', 'updatedAt'],
    description: 'The emails this tenant sends. One entry per email key.',
    group: 'Job board',
    useAsTitle: 'key',
  },
  access: {
    create: canManageTemplates,
    delete: canManageTemplates,
    read: canManageTemplates,
    update: canManageTemplates,
  },
  fields: fieldsFor(tenantScoped),
  indexes: tenantScoped ? [{ fields: ['tenant', 'key'], unique: true }] : undefined,
  versions: false,
})
