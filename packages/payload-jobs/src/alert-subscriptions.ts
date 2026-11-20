import {
  ValidationError,
  type Access,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type Field,
  type PayloadRequest,
} from 'payload'

import { getUserTenantIDsByRole, isSuperAdmin, type MissionControlUser } from './access'

/**
 * Job alert subscriptions (PJ-26). Job seekers do not need an account: a subscription is an
 * email address plus filters, confirmed with a double opt-in.
 *
 * - `confirmToken` is emailed by the subscribe endpoint (PJ-47); the subscriber proves they own
 *   the address by following `/alerts/confirm/:token`. `manageToken` is the long-lived link to
 *   edit the filters or unsubscribe.
 * - Both tokens are bearer secrets: they are random, single purpose, and never returned by a
 *   read. The token endpoints look them up with `overrideAccess: true`, exactly as they set
 *   `confirmed` and `lastSentAt` (PJ-48's digest).
 * - The collection is read-only in the admin for tenant staff: every change a subscriber makes
 *   goes through those token endpoints, not through the REST collection.
 */

export const ALERT_SUBSCRIPTIONS_SLUG = 'alert-subscriptions'

/** 32 random bytes, base64url: 43 URL-safe characters, enough for a link in an email. */
export const ALERT_TOKEN_BYTES = 32
export const ALERT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Roles that may read a tenant's subscribers in the admin, for support. */
export const ALERT_READER_ROLES = ['tenant-admin'] as const

/** The filters a subscription matches jobs on. Empty means "any"; they must be the tenant's. */
export const ALERT_FILTER_FIELDS = [
  { path: 'categories', relationTo: 'job-categories' },
  { path: 'types', relationTo: 'job-types' },
  { path: 'locations', relationTo: 'locations' },
] as const satisfies { path: string; relationTo: CollectionSlug }[]

export const KEYWORDS_MAX_LENGTH = 200

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''

  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A fresh confirmation or manage token. */
export const generateAlertToken = (): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(ALERT_TOKEN_BYTES)))

/**
 * One subscription per address per tenant, so the address is stored lowercase and trimmed.
 * Payload's `email` field checks the format; this only makes comparisons stable.
 */
export const normalizeAlertEmail = (value: unknown): null | string => {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()

  return email === '' ? null : email
}

/** Keywords are one space-separated phrase; matching is case-insensitive in PJ-48. */
export const normalizeAlertKeywords = (value: unknown): null | string => {
  if (typeof value !== 'string') return null
  const keywords = value.trim().replace(/\s+/g, ' ')

  return keywords === '' ? null : keywords
}

const tenantIDOf = (tenant: unknown): null | number | string => {
  if (tenant === null || tenant === undefined) return null
  if (typeof tenant === 'object') return (tenant as { id?: number | string }).id ?? null
  return tenant as number | string
}

/** True when the data carries the key at all, even `null` or `undefined`. */
const submits = (data: unknown, key: string): boolean =>
  typeof data === 'object' && data !== null && Object.prototype.hasOwnProperty.call(data, key)

const userOf = (req: PayloadRequest): MissionControlUser | null =>
  (req.user as MissionControlUser | null | undefined) ?? null

/**
 * Read access: super admins see every subscriber, tenant admins the ones in their tenants.
 * Editors, employers, seekers and anonymous callers see none — a subscriber list is personal
 * data, and site keys never expose it. A single-tenant site has no memberships to scope by,
 * so there only super admins read.
 */
export const alertSubscriptionReadAccess =
  (tenantScoped: boolean): Access =>
  ({ req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true
    if (!tenantScoped) return false

    const tenantIDs = getUserTenantIDsByRole(user, ALERT_READER_ROLES)

    return tenantIDs.length === 0 ? false : { tenant: { in: tenantIDs } }
  }

/**
 * Write access: none. The admin is read only, as the task asks: the subscribe, confirm and
 * manage endpoints (PJ-47) and the digest (PJ-48) write with `overrideAccess`, and so does the
 * import (PJ-66). No signed-in user can create, edit or delete a subscriber over the API.
 */
export const alertSubscriptionWriteAccess: Access = () => false

/** Trim, lowercase the address and tidy the keywords before anything reads them. */
export const normalizeAlertSubscription: CollectionBeforeValidateHook = ({ data }) => {
  if (!data) return data

  const next = { ...data }

  if (submits(next, 'email')) next.email = normalizeAlertEmail(next.email) as never
  if (submits(next, 'keywords')) next.keywords = normalizeAlertKeywords(next.keywords) as never

  return next
}

/** Fill in the tokens on create; the import may pass its own, so an existing value wins. */
export const generateAlertTokensOnCreate: CollectionBeforeValidateHook = ({ data, operation }) => {
  if (operation !== 'create' || !data) return data

  return {
    ...data,
    confirmToken: data.confirmToken || generateAlertToken(),
    manageToken: data.manageToken || generateAlertToken(),
  }
}

/**
 * One subscription per address per tenant. The unique index still guards concurrent writes;
 * this turns the raw index error into a field error the endpoint can answer with.
 */
export const uniqueAlertEmailPerTenant =
  (tenantScoped: boolean): CollectionBeforeValidateHook =>
  async ({ data, originalDoc, req }) => {
    const email = normalizeAlertEmail(data?.email)
    if (!email) return data

    const tenantID = tenantIDOf(submits(data, 'tenant') ? data?.tenant : originalDoc?.tenant)
    // A tenantless subscription is rejected in beforeChange; in single-tenant mode there is
    // no tenant field to scope by.
    if (tenantScoped && tenantID === null) return data

    const matchesEmail = { email: { equals: email } }
    const { docs } = await req.payload.find({
      collection: ALERT_SUBSCRIPTIONS_SLUG,
      depth: 0,
      limit: 2,
      overrideAccess: true,
      pagination: false,
      req,
      where: tenantScoped
        ? { and: [matchesEmail, { tenant: { equals: tenantID } }] }
        : matchesEmail,
    })

    const selfID = originalDoc?.id
    if (docs.some((doc) => selfID === undefined || String(doc.id) !== String(selfID))) {
      throw new ValidationError({
        collection: ALERT_SUBSCRIPTIONS_SLUG,
        errors: [
          { message: `${email} is already subscribed on this site`, path: 'email' },
        ],
        req,
      })
    }

    return data
  }

const idsOf = (value: unknown): (number | string)[] =>
  (Array.isArray(value) ? value : [])
    .map((entry) => tenantIDOf(entry))
    .filter((id): id is number | string => id !== null)

/**
 * Delete a tenant's subscriptions before the tenant row goes. The tenant relationship is
 * nullable, so Postgres only detaches the rows (ON DELETE SET NULL) and they would keep a
 * subscriber's address and bearer tokens alive with no tenant to scope or expire them by.
 * The same reason `site-keys` and user memberships are removed in a hook.
 */
export const removeTenantAlertSubscriptions: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.delete({
    collection: ALERT_SUBSCRIPTIONS_SLUG,
    overrideAccess: true,
    req,
    where: {
      tenant: {
        equals: id,
      },
    },
  })
}

/**
 * A subscription belongs to exactly one tenant, and its filters must be that tenant's: the
 * multi-tenant plugin narrows the admin pickers, but a REST or local write could still name
 * another tenant's taxonomy or location.
 */
export const alertSubscriptionTenantGuard =
  (tenantScoped: boolean): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    if (!tenantScoped) return data

    const tenantID = tenantIDOf(submits(data, 'tenant') ? data?.tenant : originalDoc?.tenant)

    if (tenantID === null) {
      throw new ValidationError({
        collection: collection.slug,
        errors: [{ message: 'An alert subscription must belong to a tenant', path: 'tenant' }],
        req,
      })
    }

    const errors: { message: string; path: string }[] = []

    for (const { path, relationTo } of ALERT_FILTER_FIELDS) {
      const ids = idsOf(data?.[path] ?? originalDoc?.[path])
      if (ids.length === 0) continue

      const { totalDocs } = await req.payload.count({
        collection: relationTo,
        overrideAccess: true,
        req,
        where: { and: [{ id: { in: ids } }, { tenant: { equals: tenantID } }] },
      })
      if (totalDocs !== new Set(ids.map(String)).size) {
        errors.push({ message: 'Pick only filters from this subscription’s tenant', path })
      }
    }

    if (errors.length > 0) {
      throw new ValidationError({ collection: collection.slug, errors, req })
    }

    return data
  }

const filterField = (
  name: string,
  relationTo: CollectionSlug,
  label: string,
): Field => ({
  name,
  type: 'relationship',
  relationTo,
  hasMany: true,
  admin: {
    description: `Only jobs in these ${label}. Empty means any.`,
  },
})

const validateToken = (value: unknown): string | true => {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' && ALERT_TOKEN_PATTERN.test(value)) return true

  return 'Tokens are 43 URL-safe characters; generate one with generateAlertToken'
}

const fields = (tenantScoped: boolean): Field[] => [
  {
    name: 'email',
    type: 'email',
    required: true,
    // One address per tenant; the compound index covers the multi-tenant lookup instead.
    index: !tenantScoped,
    unique: !tenantScoped,
    admin: {
      description: 'Stored lowercase. The subscriber confirms it before any alert is sent.',
    },
  },
  {
    name: 'confirmed',
    type: 'checkbox',
    defaultValue: false,
    index: true,
    admin: {
      description:
        'Set when the subscriber follows the double opt-in link. Only confirmed subscribers get alerts.',
    },
  },
  {
    name: 'confirmToken',
    type: 'text',
    index: true,
    unique: true,
    validate: validateToken,
    access: {
      // Bearer secret: read by the token endpoints with overrideAccess, never by a read.
      read: () => false,
    },
    admin: { hidden: true },
  },
  {
    name: 'manageToken',
    type: 'text',
    index: true,
    unique: true,
    validate: validateToken,
    access: {
      read: () => false,
    },
    admin: { hidden: true },
  },
  {
    name: 'keywords',
    type: 'text',
    maxLength: KEYWORDS_MAX_LENGTH,
    admin: {
      description: 'Words a job must mention, separated by spaces. Empty means any job.',
    },
  },
  filterField('categories', 'job-categories', 'job categories'),
  filterField('types', 'job-types', 'job types'),
  filterField('locations', 'locations', 'locations'),
  {
    name: 'lastSentAt',
    type: 'date',
    admin: {
      description: 'When the daily digest last went out. The next digest starts from here.',
      readOnly: true,
    },
  },
  {
    name: 'legacyId',
    type: 'number',
    index: true,
    admin: {
      description: 'WordPress user id for the alert meta, so the importer can match it.',
    },
  },
]

export type AlertSubscriptionsOptions = {
  /** Set to `false` in single-tenant mode, where there is no `tenants` collection. */
  tenantScoped?: boolean
}

/**
 * Email-only job alert subscriptions. In multi-tenant mode the multi-tenant plugin adds the
 * `tenant` field this collection's access and indexes rely on.
 */
export const alertSubscriptionCollection = ({
  tenantScoped = true,
}: AlertSubscriptionsOptions = {}): CollectionConfig => ({
  slug: ALERT_SUBSCRIPTIONS_SLUG,
  access: {
    create: alertSubscriptionWriteAccess,
    delete: alertSubscriptionWriteAccess,
    read: alertSubscriptionReadAccess(tenantScoped),
    update: alertSubscriptionWriteAccess,
  },
  admin: {
    defaultColumns: ['email', 'confirmed', 'lastSentAt'],
    description:
      'Job alert subscribers. They confirm by email and manage themselves through their link; staff only read this list.',
    group: 'Job board',
    useAsTitle: 'email',
  },
  fields: fields(tenantScoped),
  hooks: {
    beforeChange: [alertSubscriptionTenantGuard(tenantScoped)],
    // Normalize before the uniqueness check, so it compares the form that will be stored.
    beforeValidate: [
      generateAlertTokensOnCreate,
      normalizeAlertSubscription,
      uniqueAlertEmailPerTenant(tenantScoped),
    ],
  },
  // One subscription per address per tenant. Tokens are unique on their own columns.
  indexes: tenantScoped ? [{ fields: ['tenant', 'email'], unique: true }] : [],
  versions: false,
})
