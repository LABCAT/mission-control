import {
  ValidationError,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type Field,
  type GlobalConfig,
} from 'payload'

import { authenticatedAccess, contentWriteAccess } from './access'
import { validateAnalyticsId, validateLinkHref } from './validation'

const asID = (tenant: unknown): null | number | string => {
  if (tenant === null || tenant === undefined) return null
  if (typeof tenant === 'object') {
    const id = (tenant as { id?: number | string }).id
    return id ?? null
  }
  return tenant as number | string
}

/**
 * One settings document per tenant. The multi-tenant plugin's `isGlobal` option makes the
 * tenant field unique, but that only holds when the host config opts in, so this guard keeps
 * the invariant for every caller: a second create for a tenant that already has settings is
 * rejected instead of silently splitting the home page in two.
 */
export const enforceOneSiteSettingsPerTenant =
  ({ slug = 'site-settings' }: { slug?: CollectionSlug } = {}): CollectionBeforeValidateHook =>
  async ({ data, operation, req }) => {
    if (operation !== 'create') return data

    const tenantID = asID(data?.tenant)
    if (tenantID === null) return data

    const { totalDocs } = await req.payload.count({
      collection: slug,
      overrideAccess: true,
      req,
      where: { tenant: { equals: tenantID } },
    })

    if (totalDocs > 0) {
      throw new ValidationError({
        collection: slug,
        errors: [
          {
            message: 'This tenant already has site settings. Edit the existing document instead.',
            path: 'tenant',
          },
        ],
      })
    }

    return data
  }

const linkHrefField = (name: string, description: string, required = false): Field => ({
  name,
  type: 'text',
  required,
  admin: { description },
  validate: validateLinkHref,
})

const heroFields = (mediaSlug: CollectionSlug): Field => ({
  name: 'hero',
  type: 'group',
  admin: { description: 'The banner at the top of the home page.' },
  fields: [
    {
      name: 'image',
      type: 'upload',
      relationTo: mediaSlug,
      admin: { description: 'Wide image behind the hero text.' },
    },
    { name: 'heading', type: 'text' },
    { name: 'subheading', type: 'textarea' },
    { name: 'ctaLabel', type: 'text', admin: { description: 'Call-to-action button text.' } },
    linkHrefField('ctaHref', 'Where the call-to-action button goes.'),
  ],
})

const promoBlockFields = (mediaSlug: CollectionSlug): Field => ({
  name: 'promoBlocks',
  type: 'array',
  admin: { description: 'Cards shown on the home page, in order.' },
  fields: [
    { name: 'heading', type: 'text', required: true },
    { name: 'body', type: 'textarea' },
    { name: 'image', type: 'upload', relationTo: mediaSlug },
    { name: 'linkLabel', type: 'text' },
    linkHrefField('linkHref', 'Where the card links to.'),
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      admin: { description: 'Untick to keep a block without showing it on the site.' },
    },
  ],
})

const navLinkFields = (): Field => ({
  name: 'navLinks',
  type: 'array',
  admin: { description: 'Header navigation, in order.' },
  fields: [
    { name: 'label', type: 'text', required: true },
    linkHrefField('href', 'Site path or full URL.', true),
    {
      name: 'openInNewTab',
      type: 'checkbox',
      defaultValue: false,
    },
  ],
})

/**
 * Home page and site chrome for one tenant (PJ-20): hero, promo blocks, navigation, footer and
 * the analytics ID. Keeping this in the CMS means a new site is a tenant row plus content, with
 * no deploy.
 */
const siteSettingsFields = (mediaSlug: CollectionSlug): Field[] => [
  heroFields(mediaSlug),
  promoBlockFields(mediaSlug),
  navLinkFields(),
  {
    name: 'footerText',
    type: 'textarea',
    admin: { description: 'Shown at the bottom of every page.' },
  },
  {
    name: 'analyticsId',
    type: 'text',
    admin: {
      description:
        'GA4 measurement ID (G-XXXXXXXXXX) or Cloudflare Web Analytics token. Leave empty for none.',
    },
    validate: validateAnalyticsId,
  },
]

export type SiteSettingsOptions = {
  /** Slug of the collection that hero and promo images reference. Defaults to `media`. */
  mediaSlug?: CollectionSlug
  slug?: CollectionSlug
}

const fieldsFor = ({ mediaSlug = 'media' }: SiteSettingsOptions): Field[] =>
  siteSettingsFields(mediaSlug)

/**
 * Tenant-scoped settings as a collection. Use it with the multi-tenant plugin's `isGlobal`
 * option so the tenant field is unique and the admin hides "create new".
 */
export const siteSettingsCollection = (options: SiteSettingsOptions = {}): CollectionConfig => {
  const { slug = 'site-settings' } = options

  return {
    slug,
    admin: {
      group: 'Settings',
      useAsTitle: 'footerText',
    },
    access: {
      // Public sites read this through a site key; the plugin narrows a key to its tenant.
      read: authenticatedAccess,
      create: contentWriteAccess(),
      delete: contentWriteAccess(),
      update: contentWriteAccess(),
    },
    fields: fieldsFor(options),
    hooks: {
      beforeValidate: [enforceOneSiteSettingsPerTenant({ slug })],
    },
    versions: false,
  }
}

/** The same settings for a single-tenant host, where one global covers the only site. */
export const siteSettingsGlobal = (options: SiteSettingsOptions = {}): GlobalConfig => {
  const { slug = 'site-settings' } = options

  return {
    slug,
    admin: {
      group: 'Settings',
    },
    access: {
      read: authenticatedAccess,
      update: contentWriteAccess({ allowAnyAuthenticated: true }),
    },
    fields: fieldsFor(options),
    versions: false,
  }
}

/** Multi-tenant plugin options for the settings collection. */
export const siteSettingsMultiTenantOptions = (slug = 'site-settings') => ({
  [slug]: { isGlobal: true },
})
