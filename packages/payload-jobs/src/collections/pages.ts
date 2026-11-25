import {
  ValidationError,
  type Access,
  type BlocksField,
  type CollectionBeforeDeleteHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type PayloadRequest,
  type Where,
} from 'payload'

import {
  authenticatedAccess,
  hasAnyTenantRole,
  isSeekerOnly,
  isSuperAdmin,
  type MissionControlUser,
  type TenantRole,
} from '../access'
import {
  PAGES_WITHOUT_CHILDREN,
  SYSTEM_PAGE_CLEANUP_CONTEXT,
  pageRoleOptions,
  systemPageError,
  type PageRole,
} from '../system-pages'
import { mergeCollectionAccess, type CollectionAccess } from '../slugs'
import { seoTab } from '../seo-fields'
import { uniqueSlugPerTenant } from '../taxonomies'

export const PAGES_SLUG = 'pages'

/** Roles that write a site's pages. Employers and seekers do not. */
export const PAGE_EDITOR_ROLES = ['tenant-admin', 'editor'] as const satisfies readonly TenantRole[]

/** The organisations page owns the `/organisations` branch, so its address is fixed. */
export const ORGANISATIONS_PAGE_SLUG = 'organisations'

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SLUG_LENGTH = 120

/** Lowercase ASCII words joined by single hyphens: `About Us!` becomes `about-us`. */
export const slugifyPageTitle = (title: string): string =>
  title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')

export const validatePageSlug = (value: null | string | undefined): string | true => {
  const trimmed = value?.trim()
  if (!trimmed) return true

  return trimmed.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(trimmed)
    ? true
    : 'Use lowercase letters, numbers and single hyphens, for example about-us'
}

const idOf = (value: unknown): null | number | string => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id?: number | string }).id ?? null
  return value as number | string
}

const hasKey = (data: unknown, key: string): boolean =>
  typeof data === 'object' && data !== null && Object.prototype.hasOwnProperty.call(data, key)

/**
 * True when walking `parent` links up from `startID` reaches `targetID`. Saving a page under one
 * of its own descendants would turn the tree into a loop, so breadcrumb and URL builders that
 * follow parents would never terminate. The `seen` set also stops the walk if the data is
 * somehow already cyclic.
 */
const parentChainReaches = async ({
  collectionSlug,
  req,
  startID,
  targetID,
}: {
  collectionSlug: CollectionSlug
  req: PayloadRequest
  startID: number | string
  targetID: number | string
}): Promise<boolean> => {
  const seen = new Set<string>()
  let current: null | number | string = startID

  while (current !== null && !seen.has(String(current))) {
    seen.add(String(current))

    const doc = (await req.payload
      .findByID({
        collection: collectionSlug,
        depth: 0,
        id: current as never,
        overrideAccess: true,
        req,
      })
      .catch(() => null)) as PageData | null

    if (!doc) return false

    const next = idOf(doc.parent)
    if (next !== null && String(next) === String(targetID)) return true
    current = next
  }

  return false
}

type PageData = {
  id?: null | number | string
  parent?: unknown
  role?: null | PageRole
  slug?: null | string
  tenant?: unknown
  title?: null | string
}

/**
 * Pages hold a site's CMS content: the old WordPress pages (AUDIT.md) plus the four system
 * pages every site gets (PJ-103). The body is a block layout, so the home page, an
 * organisation directory and a plain text page are one kind of document; the block types come
 * from the host's `config.blocks` (rocketship-payload, PJ-84).
 */
export type PagesOptions = {
  /** Overrides the collection's `access`, operation by operation. */
  access?: CollectionAccess
  blockSlugs?: readonly string[]
  /** Slug of the host's upload collection for the SEO image. `null` drops the field. */
  mediaSlug?: null | string
  slug?: string
  /** `false` in single-tenant mode, where there is no tenants collection. */
  tenantScoped?: boolean
}

/**
 * Write access: super admins and the tenant-admin/editor memberships of at least one tenant.
 * The multi-tenant plugin narrows the result to the user's own tenants. Single-tenant hosts
 * have no memberships to check, so there any signed-in user may edit.
 */
export const pageWriteAccess =
  (tenantScoped: boolean): Access =>
  ({ req }) => {
    const user = req.user as MissionControlUser | null | undefined
    if (!user || isSeekerOnly(user)) return false
    if (isSuperAdmin(user) || hasAnyTenantRole(user, PAGE_EDITOR_ROLES)) return true

    return !tenantScoped
  }

/** Read: signed-in staff, narrowed to their tenants by the plugin. Public sites use a site key. */
export const pageReadAccess: Access = (args) =>
  isSeekerOnly(args.req.user as never) ? false : authenticatedAccess(args)

/**
 * Delete is offered to the same people who may write, and the `beforeDelete` guard refuses the
 * system pages. Access control only sees the id, so the role check has to live in the hook.
 */
export const pageDeleteAccess = pageWriteAccess

/**
 * Validation for the URL rules the site depends on:
 *
 * - `home` is served at `/`: no slug, no parent, and nothing nests under it.
 * - `organisations` owns `/organisations/{slug}`: no parent, and no children, because those
 *   URLs are organisation profiles.
 * - Every other page needs a slug (derived from the title when empty) and may nest under any
 *   page except those two.
 * - A role is unique in its tenant: one home page per site, so `/` is never ambiguous.
 *
 * The messages name the rule, so an editor can fix the form instead of seeing a bare 403 or a
 * slug quietly becoming `about-2`.
 */
export const pageUrlRules =
  ({
    slug: collectionSlug,
    tenantScoped,
  }: {
    slug: CollectionSlug
    tenantScoped: boolean
  }): CollectionBeforeValidateHook =>
  async ({ data, originalDoc, req }) => {
    if (!data) return data

    const page = data as PageData
    const original = originalDoc as PageData | undefined
    const role = hasKey(page, 'role') ? (page.role ?? null) : (original?.role ?? null)
    const tenantID = idOf(page.tenant ?? original?.tenant)
    const selfID = original?.id
    const errors: { message: string; path: string }[] = []

    if (role === 'home') {
      page.slug = null
    } else if (role === 'organisations') {
      // `/organisations/{slug}` belongs to organisation profiles, so the directory keeps its
      // own address. Say so rather than silently overriding what the editor typed.
      const submitted = typeof page.slug === 'string' ? page.slug.trim() : ''
      if (submitted && submitted !== ORGANISATIONS_PAGE_SLUG) {
        errors.push({
          message: 'The organisations page keeps its /organisations address',
          path: 'slug',
        })
      }
      page.slug = ORGANISATIONS_PAGE_SLUG
    } else {
      const given = hasKey(page, 'slug')
      const submitted = typeof page.slug === 'string' ? page.slug.trim() : ''
      const current = typeof original?.slug === 'string' ? original.slug : ''

      // A submitted slug is the editor's choice and the field validator checks its shape.
      // Leaving the field out keeps the existing address, so renaming a title alone does not
      // move the page. An empty submission has no address to keep, so it takes the title's
      // slug exactly as a new page with no slug does.
      if (given && submitted) {
        page.slug = submitted
      } else if (!given && current) {
        page.slug = current
      } else {
        const title = typeof page.title === 'string' ? page.title : original?.title
        const derived = typeof title === 'string' ? slugifyPageTitle(title) : ''
        if (derived) page.slug = derived
        else errors.push({ message: 'Slug is required', path: 'slug' })
      }
    }

    const parentID = idOf(hasKey(page, 'parent') ? page.parent : original?.parent)
    if (parentID !== null) {
      if (role && PAGES_WITHOUT_CHILDREN.includes(role)) {
        // home is `/` and organisations is `/organisations`, so neither can sit under a page.
        page.parent = null
        errors.push({ message: `The ${role} page cannot have a parent`, path: 'parent' })
      } else if (selfID !== undefined && selfID !== null && String(parentID) === String(selfID)) {
        errors.push({ message: 'A page cannot be its own parent', path: 'parent' })
      } else if (
        selfID !== undefined &&
        selfID !== null &&
        // The parent must not sit below this page, or the pair would form a loop.
        (await parentChainReaches({
          collectionSlug,
          req,
          startID: parentID,
          targetID: selfID,
        }))
      ) {
        errors.push({ message: 'A page cannot be its own ancestor', path: 'parent' })
      } else {
        const parent = (await req.payload
          .findByID({
            collection: collectionSlug,
            depth: 0,
            id: parentID as never,
            overrideAccess: true,
            req,
          })
          .catch(() => null)) as PageData | null

        if (!parent) {
          errors.push({ message: 'The parent page does not exist', path: 'parent' })
        } else if (parent.role && PAGES_WITHOUT_CHILDREN.includes(parent.role)) {
          errors.push({ message: `The ${parent.role} page cannot have children`, path: 'parent' })
        } else if (tenantScoped && String(idOf(parent.tenant)) !== String(tenantID)) {
          errors.push({ message: 'The parent page belongs to another tenant', path: 'parent' })
        }
      }
    }

    if (role && PAGES_WITHOUT_CHILDREN.includes(role) && selfID !== undefined && selfID !== null) {
      const { totalDocs } = await req.payload.count({
        collection: collectionSlug,
        overrideAccess: true,
        req,
        where: { parent: { equals: selfID } },
      })
      if (totalDocs > 0) {
        errors.push({
          message: `The ${role} page cannot have children: move them to another page first`,
          path: 'parent',
        })
      }
    }

    if (role && tenantID !== null) {
      const { docs } = await req.payload.find({
        collection: collectionSlug,
        depth: 0,
        limit: 2,
        overrideAccess: true,
        pagination: false,
        req,
        where: { and: [{ role: { equals: role } }, { tenant: { equals: tenantID } }] },
      })
      const clash = (docs as PageData[]).some(
        (doc) =>
          doc.id === undefined ||
          doc.id === null ||
          selfID === undefined ||
          selfID === null ||
          String(doc.id) !== String(selfID),
      )
      if (clash) errors.push({ message: `This site already has a ${role} page`, path: 'role' })
    }

    if (errors.length > 0) throw new ValidationError({ collection: collectionSlug, errors, req })

    return page
  }

/**
 * A role is assigned once. The home page's URL, the organisation directory and the contact
 * route are what other tickets address by role, so moving one would silently re-point them.
 * Super admins, and system code with no signed-in user, may still change it to repair an
 * import.
 *
 * This runs in `beforeValidate`, before field access strips a field: a site manager who moves
 * a role gets an explanation instead of a save that quietly changes nothing.
 */
export const preventRoleChange: CollectionBeforeValidateHook = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (!data) return data

  const user = req.user as MissionControlUser | null | undefined
  // No signed-in user means system code: the seed, the importer or a task.
  if (!user || isSuperAdmin(user)) return data

  const original = (originalDoc as PageData | undefined)?.role ?? null
  const submitted = hasKey(data, 'role') ? ((data as PageData).role ?? null) : original

  if (submitted === original) return data

  throw systemPageError(
    operation === 'create'
      ? 'Only a super admin can create a page with a role'
      : 'Only a super admin can change a page’s role',
    'role',
  )
}

/**
 * A system page is unpublished, never deleted. Access control already refuses the request
 * from a user; this hook is what also holds for the local API, and it says what to do instead.
 * The tenant-delete cleanup removes a whole site's pages, so it passes the cleanup context;
 * that context is the only way past this guard, so a page cannot be detached from its site
 * and then deleted.
 */
export const preventDeletingSystemPage =
  (collectionSlug: CollectionSlug): CollectionBeforeDeleteHook =>
  async ({ id, req }) => {
    if (req.context?.[SYSTEM_PAGE_CLEANUP_CONTEXT] === true) return

    const page = (await req.payload
      .findByID({
        collection: collectionSlug,
        depth: 0,
        id: id as never,
        overrideAccess: true,
        req,
      })
      .catch(() => null)) as PageData | null

    if (!page?.role) return

    throw systemPageError(
      `The ${page.role} page is a system page: unpublish it instead of deleting it`,
      'role',
    )
  }

export const pagesCollection = ({
  access,
  blockSlugs = [],
  mediaSlug = 'media',
  slug = PAGES_SLUG,
  tenantScoped = true,
}: PagesOptions = {}): CollectionConfig => ({
  slug,
  access: mergeCollectionAccess(
    {
      create: pageWriteAccess(tenantScoped),
      delete: pageDeleteAccess(tenantScoped),
      // Public sites read through a site key, which the plugin's accessResultOverride
      // narrows to the key's tenant and to published documents.
      read: pageReadAccess,
      update: pageWriteAccess(tenantScoped),
    },
    access,
  ),
  admin: {
    defaultColumns: ['title', 'slug', 'role', 'parent', 'updatedAt'],
    description:
      'Content pages. Home, About, Contact and Organisations are created with the site; they can be unpublished but not deleted.',
    group: 'Content',
    useAsTitle: 'title',
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      index: true,
      admin: {
        description:
          'The path on this site. Leave empty to derive it from the title. The home page has none.',
        position: 'sidebar',
      },
      validate: validatePageSlug,
    },
    {
      name: 'role',
      type: 'select',
      admin: {
        description:
          'Marks a page the site structure relies on. Only a super admin can change it.',
        position: 'sidebar',
      },
      options: pageRoleOptions,
    },
    {
      name: 'parent',
      type: 'relationship',
      admin: {
        description: 'The page this one sits under. Home and Organisations have no children.',
        position: 'sidebar',
      },
      filterOptions: ({ id }): Where => ({
        and: [
          // Home and organisations reserve their branch for themselves; about and contact
          // (and normal pages) may take children.
          { or: [{ role: { exists: false } }, { role: { in: ['about', 'contact'] } }] },
          ...(id === undefined || id === null ? [] : [{ id: { not_equals: id } }]),
        ],
      }),
      relationTo: slug as CollectionSlug,
    },
    {
      name: 'layout',
      type: 'blocks',
      admin: { description: 'The page body, built from blocks in the order shown.' },
      // The host registers the block configs (PJ-84); the plugin only names them by slug.
      blocks: [...blockSlugs] as BlocksField['blocks'],
    },
    seoTab({ mediaSlug }),
    {
      name: 'legacyId',
      type: 'number',
      index: true,
      admin: {
        description: 'WordPress post ID, so the importer can match an existing page.',
        position: 'sidebar',
      },
    },
  ],
  hooks: {
    beforeDelete: [preventDeletingSystemPage(slug as CollectionSlug)],
    beforeValidate: [
      preventRoleChange,
      ...(tenantScoped ? [uniqueSlugPerTenant(slug as CollectionSlug)] : []),
      pageUrlRules({ slug: slug as CollectionSlug, tenantScoped }),
    ],
  },
  indexes: tenantScoped
    ? [
        // One page per role per site: a second home page would make `/` ambiguous. Postgres
        // treats NULL as distinct, so normal pages do not clash here.
        { fields: ['tenant', 'role'], unique: true },
        { fields: ['tenant', 'slug'], unique: true },
      ]
    : [
        { fields: ['role'], unique: true },
        { fields: ['slug'], unique: true },
      ],
  // Drafts are the publish switch: a system page is unpublished, never deleted.
  versions: { drafts: true },
})
