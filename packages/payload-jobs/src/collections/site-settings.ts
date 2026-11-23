import {
  ValidationError,
  type BlocksField,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type Field,
  type PayloadRequest,
} from 'payload'

import { authenticatedAccess, isSeekerOnly } from '../access'
import { mergeCollectionAccess, type CollectionAccess } from '../slugs'
import { pageWriteAccess } from './pages'

export const SITE_SETTINGS_SLUG = 'site-settings'

/**
 * Site settings (PJ-67): the site chrome that is the same on every page, kept once per site.
 *
 * The home page, the pages and the menus are documents a site manager edits page by page; the
 * site name, the logo, the footer line, the `lang` attribute and the header banner belong to the
 * site as a whole, so they live in one document per tenant instead of in a page.
 *
 * A collection rather than a global: a global has one row for the whole installation, and the
 * platform serves several sites. The multi-tenant plugin treats a collection listed with
 * `isGlobal: true` as a singleton per tenant (unique tenant field, no "create new" button), and
 * `enforceOneSiteSettings` keeps that invariant for hosts that do not opt in.
 */
export type SiteSettingsOptions = {
  /** Overrides the collection's `access`, operation by operation. */
  access?: CollectionAccess
  /**
   * Block slugs the header banner field offers. Defaults to `['banner']`, the generic banner
   * block from rocketship-payload (PJ-84). Empty leaves the field out.
   */
  bannerBlockSlugs?: readonly string[]
  /** Slug of the host's upload collection for the logo. `null` drops the field. */
  mediaSlug?: null | string
  slug?: string
  /** `false` in single-tenant mode, where there is no tenants collection. */
  tenantScoped?: boolean
}

/** A BCP 47 language tag: `en`, `fr`, `en-VU`, `zh-Hant`. */
const LANG_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

export const validateLang = (value: null | string | undefined): string | true => {
  const trimmed = value?.trim()
  if (!trimmed) return true

  return LANG_PATTERN.test(trimmed) ? true : 'Use a language tag, for example en or en-VU'
}

const asID = (value: unknown): null | number | string => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id?: number | string }).id ?? null
  return value as number | string
}

/**
 * One settings document per tenant. The multi-tenant plugin's `isGlobal` option makes the tenant
 * field unique, but only when the host opts in, so this guard keeps the invariant for every
 * caller: a second create for a site that already has settings is refused instead of splitting
 * the site chrome in two.
 */
export const enforceOneSiteSettings =
  ({ slug = SITE_SETTINGS_SLUG }: { slug?: string } = {}): CollectionBeforeValidateHook =>
  async ({ data, operation, req }) => {
    if (operation !== 'create') return data

    const tenantID = asID(data?.tenant)
    if (tenantID === null) return data

    const { totalDocs } = await req.payload.count({
      collection: slug as CollectionSlug,
      overrideAccess: true,
      req,
      where: { tenant: { equals: tenantID } },
    })

    if (totalDocs > 0) {
      throw new ValidationError({
        collection: slug as CollectionSlug,
        errors: [
          {
            message: 'This site already has settings. Edit the existing document instead.',
            path: 'tenant',
          },
        ],
        req,
      })
    }

    return data
  }

const fieldsFor = ({
  bannerBlockSlugs = ['banner'],
  mediaSlug = 'media',
}: SiteSettingsOptions): Field[] => [
  {
    name: 'siteName',
    type: 'text',
    admin: { description: 'The site name, used in the browser title and email footers.' },
  },
  ...(mediaSlug
    ? ([
        {
          name: 'logo',
          type: 'upload',
          relationTo: mediaSlug,
          admin: { description: 'Shown in the site header and used for share images.' },
        },
      ] as Field[])
    : []),
  {
    name: 'tagline',
    type: 'textarea',
    admin: { description: 'One line under the site name, for example in the footer.' },
  },
  {
    name: 'footerText',
    type: 'textarea',
    admin: { description: 'Shown at the bottom of every page.' },
  },
  {
    name: 'lang',
    type: 'text',
    defaultValue: 'en',
    admin: {
      description: 'The `lang` attribute of every page, for example en or en-VU.',
      position: 'sidebar',
    },
    validate: validateLang,
  },
  ...(bannerBlockSlugs.length > 0
    ? ([
        {
          name: 'headerBanner',
          type: 'blocks',
          label: 'Header banner',
          // One banner, above the content on every page (STATUS.md, 19 Nov).
          maxRows: 1,
          blocks: [...bannerBlockSlugs] as BlocksField['blocks'],
          admin: { description: 'Rendered above the content on every page of the site.' },
        },
      ] as Field[])
    : []),
  {
    name: 'legacyId',
    type: 'number',
    index: true,
    admin: {
      description: 'WordPress option row id, so the importer can match existing settings.',
      position: 'sidebar',
    },
  },
]

export const siteSettingsCollection = (options: SiteSettingsOptions = {}): CollectionConfig => {
  const { access, slug = SITE_SETTINGS_SLUG, tenantScoped = true } = options

  return {
    slug,
    access: mergeCollectionAccess(
      {
        create: pageWriteAccess(tenantScoped),
        delete: pageWriteAccess(tenantScoped),
        // Public sites read the settings through a site key, which the plugin's
        // `accessResultOverride` narrows to the key's tenant.
        read: (args) => (isSeekerOnly(args.req.user as never) ? false : authenticatedAccess(args)),
        update: pageWriteAccess(tenantScoped),
      },
      access,
    ),
    admin: {
      description:
        'Site name, logo, footer, language and the header banner. One document per site.',
      group: 'Settings',
      useAsTitle: 'siteName',
    },
    fields: fieldsFor(options),
    hooks: {
      beforeValidate: [enforceOneSiteSettings({ slug })],
    },
    indexes: tenantScoped
      ? [
          // One settings document per site: the site chrome is not a list.
          { fields: ['tenant'], unique: true },
        ]
      : [],
    versions: false,
  }
}

/**
 * Give a new site its settings document, so the theme has something to read and a site manager
 * has a form to fill instead of a "create" button. Idempotent: a site that already has settings
 * keeps them, which makes a retried tenant create, a test boot and a re-run import safe.
 */
export const seedTenantSiteSettings =
  ({ collectionSlug = SITE_SETTINGS_SLUG, tenantScoped = true }: { collectionSlug?: string; tenantScoped?: boolean } = {}) =>
  async ({ doc, operation, req }: { doc: Record<string, unknown>; operation: string; req: PayloadRequest }): Promise<void> => {
    if (!tenantScoped || operation !== 'create') return
    // The aggregate tenant is a directory, not a site.
    if (doc?.isAggregate === true) return

    const tenantID = doc.id as number | string
    const { totalDocs } = await req.payload.count({
      collection: collectionSlug as CollectionSlug,
      overrideAccess: true,
      req,
      where: { tenant: { equals: tenantID } },
    })
    if (totalDocs > 0) return

    await req.payload.create({
      collection: collectionSlug as never,
      data: { lang: 'en', tenant: tenantID } as never,
      overrideAccess: true,
      req,
    })
  }

/**
 * Delete a tenant's settings before the tenant row goes, like the pages and menus cleanup. The
 * tenant relationship is nullable, so Postgres would otherwise only detach the document and
 * leave an orphan behind.
 */
export const removeTenantSiteSettings =
  ({ collectionSlug = SITE_SETTINGS_SLUG }: { collectionSlug?: string } = {}) =>
  async ({ id, req }: { id: number | string; req: PayloadRequest }): Promise<void> => {
    await req.payload.delete({
      collection: collectionSlug as never,
      overrideAccess: true,
      req,
      where: { tenant: { equals: id } },
    })
  }
