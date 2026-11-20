import {
  ValidationError,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type Field,
  type PayloadRequest,
  type Validate,
} from 'payload'

import { authenticatedAccess, isSeekerOnly } from '../access'
import { mergeCollectionAccess, type CollectionAccess } from '../slugs'
import { pageWriteAccess } from './pages'

export const MENUS_SLUG = 'menus'

/**
 * Menus (PJ-103). WordPress keeps navigation in three theme locations; the CMS keeps the same
 * three menus, one of each per site, with ordered items. Launchpad renders them (PJ-39) and
 * the WordPress import fills them (PJ-67).
 */

export const MENU_LOCATIONS = ['top', 'primary', 'footer'] as const

export type MenuLocation = (typeof MENU_LOCATIONS)[number]

const locationLabels: Record<MenuLocation, string> = {
  footer: 'Footer',
  primary: 'Primary',
  top: 'Top bar',
}

export const menuLocationOptions = MENU_LOCATIONS.map((value) => ({
  label: locationLabels[value],
  value,
}))

const MAX_LABEL_LENGTH = 80

/** The path a menu item points at, plus the schemes a public page may link to. */
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

/**
 * A menu item's URL must be one a public page may link to. The value goes straight into an
 * `href`, so a `javascript:` or `data:` value there would be stored XSS on every page of the
 * site. Relative paths and anchors are the normal case; absolute URLs and `mailto:`/`tel:` are
 * allowed for third-party and contact links. Mirrors rocketship's `safeHref`.
 */
export const validateMenuUrl = (value: null | string | undefined): string | true => {
  const trimmed = value?.trim()
  if (!trimmed) return 'A menu item needs a link'

  // Browsers ignore whitespace and control characters inside a scheme, so strip them before
  // deciding what this value is.
  const compact = [...trimmed]
    .filter((char) => char.charCodeAt(0) > 0x20 && !(char.charCodeAt(0) >= 0x7f && char.charCodeAt(0) <= 0x9f))
    .join('')
    .toLowerCase()
    .replace(/\\/g, '/')

  if (compact.startsWith('//')) return 'Use /path, https://… or mailto:…, not a protocol-relative URL'
  if (compact.startsWith('/') || compact.startsWith('#') || compact.startsWith('?')) return true

  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compact)?.[1]

  return scheme && ALLOWED_SCHEMES.has(scheme)
    ? true
    : 'Use a path starting with /, or an http, https, mailto or tel link'
}

const itemFields = (pagesSlug: string): Field[] => [
  {
    name: 'label',
    type: 'text',
    required: true,
    validate: (value: null | string | undefined) => {
      const trimmed = value?.trim()
      if (!trimmed) return 'A menu item needs a label'

      return trimmed.length <= MAX_LABEL_LENGTH
        ? true
        : `Keep the label to ${MAX_LABEL_LENGTH} characters or fewer`
    },
  },
  {
    name: 'linkType',
    type: 'radio',
    admin: { description: 'Link to a page in this site, or to any allowed URL.' },
    defaultValue: 'custom',
    options: [
      { label: 'Page on this site', value: 'page' },
      { label: 'Custom URL', value: 'custom' },
    ],
  },
  {
    name: 'page',
    type: 'relationship',
    admin: {
      condition: (_data, siblingData) => siblingData?.linkType === 'page',
      description: 'The page to link to.',
    },
    relationTo: pagesSlug as CollectionSlug,
    validate: ((value: unknown, options: { siblingData?: { linkType?: null | string } }) =>
      options.siblingData?.linkType === 'page' && !value
        ? 'Choose the page to link to'
        : true) as Validate,
  },
  {
    name: 'url',
    type: 'text',
    admin: {
      condition: (_data, siblingData) => siblingData?.linkType !== 'page',
      description: 'For example /jobs, https://example.com or mailto:hello@example.com.',
    },
    validate: ((value: null | string | undefined, options: { siblingData?: { linkType?: null | string } }) =>
      options.siblingData?.linkType === 'page' ? true : validateMenuUrl(value)) as Validate,
  },
  {
    name: 'newTab',
    type: 'checkbox',
    defaultValue: false,
    admin: { description: 'Open the link in a new tab. Use it for other sites.' },
  },
]

/**
 * A page item must name a page, and a custom item a URL; the field's own `condition` only
 * hides the input. A page item's page must also belong to the menu's tenant: the admin picker
 * is narrowed by the plugin, but a REST write could name another site's page.
 */
export const menuItemsValid =
  ({ pagesSlug, tenantScoped }: { pagesSlug: CollectionSlug; tenantScoped: boolean }): CollectionBeforeValidateHook =>
  async ({ data, operation, originalDoc, req }) => {
    const items = Array.isArray(data?.items) ? data.items : undefined
    if (!items) return data

    const tenantID = (() => {
      const value = data?.tenant ?? originalDoc?.tenant
      if (value === null || value === undefined) return null
      if (typeof value === 'object') return (value as { id?: number | string }).id ?? null
      return value as number | string
    })()

    const errors: { message: string; path: string }[] = []

    for (const [index, item] of items.entries()) {
      const row = item as { linkType?: null | string; page?: unknown; url?: null | string }
      const path = `items.${index}`

      if (row.linkType === 'page') {
        const pageID =
          row.page === null || row.page === undefined
            ? null
            : typeof row.page === 'object'
              ? ((row.page as { id?: number | string }).id ?? null)
              : row.page

        if (pageID === null) {
          errors.push({ message: 'Choose the page to link to', path: `${path}.page` })
          continue
        }

        if (!tenantScoped) continue

        const page = await req.payload
          .findByID({
            collection: pagesSlug,
            depth: 0,
            id: pageID as never,
            overrideAccess: true,
            req,
          })
          .catch(() => null)

        if (!page) {
          errors.push({ message: 'The page does not exist', path: `${path}.page` })
          continue
        }

        const pageTenant = (page as { tenant?: unknown }).tenant
        const pageTenantID =
          pageTenant === null || pageTenant === undefined
            ? null
            : typeof pageTenant === 'object'
              ? ((pageTenant as { id?: number | string }).id ?? null)
              : pageTenant

        if (String(pageTenantID) !== String(tenantID)) {
          errors.push({ message: 'The page belongs to another site', path: `${path}.page` })
        }
      } else if (!row.url?.trim()) {
        errors.push({ message: 'A custom item needs a URL', path: `${path}.url` })
      }
    }

    if (errors.length > 0) {
      throw new ValidationError({ collection: MENUS_SLUG, errors, req })
    }

    void operation

    return data
  }

export type MenusOptions = {
  /** Overrides the collection's `access`, operation by operation. */
  access?: CollectionAccess
  /** Slug of the pages collection, for page items. */
  pagesSlug?: string
  slug?: string
  /** `false` in single-tenant mode, where there is no tenants collection. */
  tenantScoped?: boolean
}

export const menusCollection = ({
  access,
  pagesSlug = 'pages',
  slug = MENUS_SLUG,
  tenantScoped = true,
}: MenusOptions = {}): CollectionConfig => ({
  slug,
  access: mergeCollectionAccess(
    {
      create: pageWriteAccess(tenantScoped),
      delete: pageWriteAccess(tenantScoped),
      // Public sites read menus through a site key, like pages.
      read: (args) => (isSeekerOnly(args.req.user as never) ? false : authenticatedAccess(args)),
      update: pageWriteAccess(tenantScoped),
    },
    access,
  ),
  admin: {
    defaultColumns: ['name', 'location', 'updatedAt'],
    description:
      'Site navigation: one menu per location, with items in display order. Drag the items to reorder them.',
    group: 'Content',
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
      admin: { description: 'Shown in the admin only, for example Main menu.' },
    },
    {
      name: 'location',
      type: 'select',
      index: true,
      options: menuLocationOptions,
      required: true,
      admin: {
        description: 'Where the theme shows this menu. Each location has one menu per site.',
        position: 'sidebar',
      },
    },
    {
      name: 'items',
      type: 'array',
      admin: {
        description: 'Menu items, in the order they appear. Drag to reorder.',
        initCollapsed: true,
      },
      fields: itemFields(pagesSlug),
    },
    {
      name: 'legacyId',
      type: 'number',
      index: true,
      admin: {
        description: 'WordPress menu term ID, so the importer can match an existing menu.',
        position: 'sidebar',
      },
    },
  ],
  hooks: {
    beforeValidate: [
      menuItemsValid({ pagesSlug: pagesSlug as CollectionSlug, tenantScoped }),
    ],
  },
  indexes: tenantScoped
    ? [
        // One menu per location per site, so the theme never has to choose between two.
        { fields: ['tenant', 'location'], unique: true },
      ]
    : [{ fields: ['location'], unique: true }],
  versions: false,
})

/**
 * Delete a tenant's menus before the tenant row goes, like the pages cleanup. The tenant
 * relationship is nullable, so Postgres would otherwise only detach the menus (ON DELETE SET
 * NULL) and leave orphans behind.
 */
export const removeTenantMenus =
  ({ collectionSlug = MENUS_SLUG }: { collectionSlug?: string } = {}) =>
  async ({ id, req }: { id: number | string; req: PayloadRequest }): Promise<void> => {
    await req.payload.delete({
      collection: collectionSlug as never,
      overrideAccess: true,
      req,
      where: { tenant: { equals: id } },
    })
  }
