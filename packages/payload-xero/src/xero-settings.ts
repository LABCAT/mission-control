import type {
  Access,
  CollectionAfterErrorHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
} from 'payload'

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

export const DUPLICATE_TENANT_MESSAGE = 'This tenant already has Xero settings. Edit the existing row.'

const PG_UNIQUE_VIOLATION = '23505'

/** True for a Postgres unique violation, however deep the driver error is wrapped. */
export const isUniqueViolation = (error: unknown): boolean => {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current !== 'object') return false
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true
    current = (current as { cause?: unknown }).cause
  }

  return false
}

/** Turn a unique-index violation (two concurrent creates) into the same clear error. */
export const mapUniqueViolation = (error: unknown): unknown =>
  isUniqueViolation(error) ? new Error(DUPLICATE_TENANT_MESSAGE, { cause: error }) : error

export const mapDuplicateTenantError: CollectionAfterErrorHook = ({ error }) =>
  isUniqueViolation(error) ? { response: { errors: [{ message: DUPLICATE_TENANT_MESSAGE }] }, status: 400 } : undefined

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
    throw new Error(DUPLICATE_TENANT_MESSAGE)
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
  // The hook gives a clear error for sequential duplicates. The unique index is what makes
  // it atomic: concurrent creates cannot both pass the hook's count. The `tenant` field is
  // added by the multi-tenant plugin; the wiring task's migration creates the index.
  hooks: { afterError: [mapDuplicateTenantError], beforeValidate: [onePerTenant] },
  indexes: [{ fields: ['tenant'], unique: true }],
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
