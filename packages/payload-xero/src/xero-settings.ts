import type {
  Access,
  CollectionAfterErrorHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Field,
} from 'payload'

export const DEFAULT_SETTINGS_SLUG = 'xero-settings'
export const DEFAULT_TENANT_FIELD = 'tenant'
export const SINGLETON_VALUE = 'xero'

/** `global`: one settings row for the whole site. `tenant`: one row per tenant. */
export type XeroScope = 'global' | 'tenant'

export type XeroSettingsAccess = {
  create?: Access
  delete?: Access
  read?: Access
  update?: Access
}

export type XeroSettingsOptions = {
  /**
   * Access rules for the settings collection. Anything left out uses the default: an
   * authenticated user who can access the admin panel.
   */
  access?: XeroSettingsAccess
  /** Admin panel group for the collection. */
  group?: string
  /** `global` (default) or `tenant`. */
  scope?: XeroScope
  /** Collection slug. Defaults to `xero-settings`. */
  settingsSlug?: string
  /**
   * `tenant` scope only: the field that holds the tenant. Your tenancy layer (for example
   * `@payloadcms/plugin-multi-tenant`) must add it to the collection. Defaults to `tenant`.
   */
  tenantField?: string
}

/**
 * Default access: the request has a user, and that user's auth collection lets them into the
 * admin panel (its `access.admin`, when it defines one).
 */
export const authenticatedAdminAccess: Access = async (args) => {
  const { req } = args
  const user = req.user as ({ collection?: string } & Record<string, unknown>) | null

  if (!user) return false

  const collections = req.payload?.collections as
    | Record<string, undefined | { config?: { access?: { admin?: Access } } }>
    | undefined
  const adminAccess = collections?.[user.collection ?? '']?.config?.access?.admin

  return adminAccess ? Boolean(await adminAccess(args)) : true
}

type RelationRef = null | number | string | { id: number | string } | undefined

const idOf = (value: RelationRef): null | number | string =>
  value === null || value === undefined ? null : typeof value === 'object' ? value.id : value

export const duplicateMessage = (scope: XeroScope): string =>
  scope === 'tenant'
    ? 'This tenant already has Xero settings. Edit the existing row.'
    : 'Xero settings already exist. Edit the existing row.'

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
export const mapUniqueViolation = (error: unknown, scope: XeroScope = 'global'): unknown =>
  isUniqueViolation(error) ? new Error(duplicateMessage(scope), { cause: error }) : error

/**
 * Sequential duplicates get a clear error here. The unique index (below) is what makes the
 * rule atomic: concurrent creates cannot both pass this count.
 */
const onePerScope =
  (slug: string, scope: XeroScope, tenantField: string): CollectionBeforeValidateHook =>
  async ({ data, operation, req }) => {
    if (operation !== 'create') return data

    let where: Record<string, unknown> | undefined

    if (scope === 'tenant') {
      const tenantID = idOf(data?.[tenantField] as RelationRef)
      if (tenantID === null) return data
      where = { [tenantField]: { equals: tenantID } }
    }

    const existing = await req.payload.count({
      collection: slug,
      overrideAccess: true,
      req,
      ...(where ? { where } : {}),
    } as never)

    if (existing.totalDocs > 0) throw new Error(duplicateMessage(scope))

    return data
  }

const duplicateErrorResponse =
  (scope: XeroScope): CollectionAfterErrorHook =>
  ({ error }) =>
    isUniqueViolation(error)
      ? { response: { errors: [{ message: duplicateMessage(scope) }] }, status: 400 }
      : undefined

/** Build the settings collection. Exported for tests and for apps that register it by hand. */
export const buildXeroSettingsCollection = (options: XeroSettingsOptions = {}): CollectionConfig => {
  const scope = options.scope ?? 'global'
  const slug = options.settingsSlug ?? DEFAULT_SETTINGS_SLUG
  const tenantField = options.tenantField ?? DEFAULT_TENANT_FIELD

  // Global scope has no tenant to key on, so a constant unique column enforces one row.
  // The value is server-controlled: the field hook overwrites whatever the request sent, so
  // an API caller cannot dodge the unique index by supplying a different value.
  const singletonField: Field = {
    name: 'singleton',
    type: 'text',
    admin: { hidden: true, readOnly: true },
    defaultValue: SINGLETON_VALUE,
    hooks: { beforeChange: [() => SINGLETON_VALUE], beforeValidate: [() => SINGLETON_VALUE] },
    unique: true,
  }

  return {
    slug,
    admin: {
      defaultColumns: scope === 'tenant' ? [tenantField, 'xeroTenantId', 'updatedAt'] : ['xeroTenantId', 'updatedAt'],
      description: 'Xero accounting settings. Tokens are stored encrypted, never here in plain text.',
      ...(options.group ? { group: options.group } : {}),
      useAsTitle: 'xeroTenantId',
    },
    access: {
      create: options.access?.create ?? authenticatedAdminAccess,
      delete: options.access?.delete ?? authenticatedAdminAccess,
      read: options.access?.read ?? authenticatedAdminAccess,
      update: options.access?.update ?? authenticatedAdminAccess,
    },
    hooks: {
      afterError: [duplicateErrorResponse(scope)],
      beforeValidate: [onePerScope(slug, scope, tenantField)],
    },
    // The tenant field is added by your tenancy layer; the migration for this collection
    // creates the index.
    ...(scope === 'tenant' ? { indexes: [{ fields: [tenantField], unique: true }] } : {}),
    fields: [
      ...(scope === 'global' ? [singletonField] : []),
      {
        name: 'xeroTenantId',
        type: 'text',
        admin: { description: 'The Xero organisation (tenant) ID. Set when Xero is connected.' },
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
}

export const mapDuplicateError = duplicateErrorResponse
