import type { CollectionConfig, CollectionSlug, Field } from 'payload'

import { authenticatedAccess, contentWriteAccess } from './access'
import { seoFields } from './seo'
import { slugifyTitle, validatePageSlug } from './validation'

type SlugFieldHookArgs = {
  data?: Record<string, unknown>
  value?: unknown
}

/**
 * Fill an empty slug from the title. The admin's slug component does this in the browser, but
 * the local API, the WordPress import and a REST client have no browser, so the value must be
 * derived server-side too. An explicit slug is slugified but never overwritten.
 */
export const derivePageSlug = ({ data, value }: SlugFieldHookArgs): unknown => {
  if (typeof value === 'string' && value.trim() !== '') {
    const slugified = slugifyTitle(value)
    // "!!!" slugifies to nothing, which would fail validation; fall back to the title.
    if (slugified) return slugified
  }

  const title = data?.title
  if (typeof title !== 'string') return value

  return slugifyTitle(title) || value
}

const slugField = (): Field => ({
  name: 'slug',
  type: 'text',
  required: true,
  index: true,
  admin: {
    description: 'The URL path on this tenant’s site. Leave empty to derive it from the title.',
    position: 'sidebar',
  },
  hooks: {
    beforeValidate: [derivePageSlug],
  },
  validate: validatePageSlug,
})

export type PagesOptions = {
  /** Slug of the collection that SEO images reference. Defaults to `media`. */
  mediaSlug?: CollectionSlug
  slug?: CollectionSlug
  /**
   * `true` (multi-tenant) adds a compound unique index on `tenant` + `slug`, so two tenants can
   * both own `/about-us`. `false` (single-tenant) makes the slug unique on its own.
   */
  tenantScoped?: boolean
}

/**
 * CMS pages for a tenant: the 34 published pages on the old WordPress site (AUDIT.md), such as
 * "About us" and "Terms". Blog posts are dropped (USAGE.md), so `pages` covers both the old
 * "pages" and any long-form content a tenant needs.
 *
 * Tenant scoping comes from the multi-tenant plugin in multi-tenant mode. `legacyId` carries the
 * WordPress post ID so the importer can upsert idempotently.
 */
export const pagesCollection = ({
  mediaSlug = 'media',
  slug = 'pages',
  tenantScoped = true,
}: PagesOptions = {}): CollectionConfig => ({
  slug,
  admin: {
    defaultColumns: ['title', 'slug', 'updatedAt'],
    group: 'Content',
    useAsTitle: 'title',
  },
  access: {
    // Public sites read pages through a site key, which the plugin's accessResultOverride
    // narrows to the tenant. Signed-in staff see their own tenant in the admin.
    read: authenticatedAccess,
    // Single-tenant hosts have no tenant memberships to check, so any signed-in user may
    // edit; multi-tenant hosts fall back to the plugin, which scopes to the user's tenants.
    create: contentWriteAccess({ allowAnyAuthenticated: !tenantScoped }),
    delete: contentWriteAccess({ allowAnyAuthenticated: !tenantScoped }),
    update: contentWriteAccess({ allowAnyAuthenticated: !tenantScoped }),
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      required: true,
    },
    slugField(),
    {
      name: 'content',
      type: 'richText',
      admin: {
        description: 'The page body.',
      },
    },
    seoFields(mediaSlug),
    {
      name: 'legacyId',
      type: 'number',
      index: true,
      admin: {
        description: 'WordPress post ID, kept so the importer can match an existing page.',
        position: 'sidebar',
      },
    },
  ],
  indexes: [{ fields: tenantScoped ? ['tenant', 'slug'] : ['slug'], unique: true }],
  versions: false,
})
