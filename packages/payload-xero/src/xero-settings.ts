import type { Access, CollectionBeforeValidateHook, CollectionConfig } from 'payload'

import {
  getUserTenantIDsByRole,
  isSuperAdmin,
  type MissionControlUser,
} from '@mission-control/payload-jobs'

export const XERO_SETTINGS_SLUG = 'xero-settings'

/**
 * Xero settings hold accounting configuration, so only super admins and tenant admins reach
 * them. Editors and employers do not. The multi-tenant plugin adds the per-tenant constraint
 * on top once the collection is registered with it.
 */
export const xeroSettingsAccess: Access = ({ req }) => {
  const user = req.user as MissionControlUser | null | undefined
  if (!user) return false

  return isSuperAdmin(user) || getUserTenantIDsByRole(user, ['tenant-admin']).length > 0
}

type TenantRef = null | number | string | { id: number | string } | undefined

const tenantIDOf = (tenant: TenantRef): null | number | string =>
  tenant === null || tenant === undefined ? null : typeof tenant === 'object' ? tenant.id : tenant

/** One settings row per tenant. A second create for the same tenant is rejected. */
export const onePerTenant: CollectionBeforeValidateHook = async ({ data, operation, req }) => {
  if (operation !== 'create') return data

  const tenantID = tenantIDOf(data?.tenant as TenantRef)
  if (tenantID === null) return data

  const existing = await req.payload.count({
    collection: XERO_SETTINGS_SLUG,
    overrideAccess: true,
    req,
    where: { tenant: { equals: tenantID } },
  })

  if (existing.totalDocs > 0) {
    throw new Error('This tenant already has Xero settings. Edit the existing row.')
  }

  return data
}

export const XeroSettings: CollectionConfig = {
  slug: XERO_SETTINGS_SLUG,
  admin: {
    defaultColumns: ['tenant', 'xeroTenantId', 'updatedAt'],
    description: 'Per-tenant Xero accounting settings. Tokens are stored encrypted, never here in plain text.',
    group: 'Tenants',
    useAsTitle: 'xeroTenantId',
  },
  access: {
    create: xeroSettingsAccess,
    delete: xeroSettingsAccess,
    read: xeroSettingsAccess,
    update: xeroSettingsAccess,
  },
  hooks: { beforeValidate: [onePerTenant] },
  fields: [
    {
      name: 'xeroTenantId',
      type: 'text',
      admin: { description: 'The Xero organisation (tenant) ID. Set when the tenant connects Xero.' },
    },
    {
      name: 'accountCodes',
      type: 'group',
      fields: [
        { name: 'plan', type: 'text', admin: { description: 'Sales account code for plan line items.' } },
        { name: 'discount', type: 'text', admin: { description: 'Account code for discount line items.' } },
      ],
    },
    { name: 'brandingThemeId', type: 'text', admin: { description: 'Xero branding theme ID for invoices.' } },
    {
      name: 'dueDays',
      type: 'number',
      defaultValue: 14,
      max: 365,
      min: 0,
      admin: { description: 'Days from invoice date until payment is due.' },
    },
    {
      name: 'reconciliationAccountCode',
      type: 'text',
      admin: { description: 'Bank account code used when reconciling payments.' },
    },
    {
      name: 'trackingCategory',
      type: 'group',
      fields: [
        { name: 'name', type: 'text', admin: { description: 'Xero tracking category name.' } },
        { name: 'option', type: 'text', admin: { description: 'Tracking option applied to invoices.' } },
      ],
    },
  ],
  versions: false,
}
