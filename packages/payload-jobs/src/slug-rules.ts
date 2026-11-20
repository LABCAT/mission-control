import { ValidationError, type CollectionBeforeValidateHook, type CollectionSlug, type PayloadRequest } from 'payload'

import type { PayloadJobsCollectionSlugs } from './slugs'

/**
 * Clean filter URLs (`/jobs/{slug}`) carry no `/in` or `/type` marker, so one segment has to
 * identify exactly one thing. Within a tenant a slug is therefore used at most once across job
 * categories, locations (every level of the tree) and job types, and is never a reserved word.
 */

/** Words that would collide with a route on a job site. A host can replace the list. */
export const DEFAULT_RESERVED_SLUGS: readonly string[] = [
  'account',
  'admin',
  'all',
  'api',
  'feed',
  'in',
  'jobs',
  'login',
  'new',
  'page',
  'rss',
  'search',
  'sitemap',
]

/** One collection that shares the slug namespace, with the name the admin error uses. */
export type SlugNamespace = { collection: string; label: string }

export type SlugRules = {
  namespaces: SlugNamespace[]
  reserved: readonly string[]
}

/** The three collections that share one slug namespace, from the resolved collection slugs. */
export const slugRulesFor = (
  slugs: Pick<PayloadJobsCollectionSlugs, 'jobCategories' | 'jobTypes' | 'locations'>,
  reserved: readonly string[] = DEFAULT_RESERVED_SLUGS,
): SlugRules => ({
  namespaces: [
    { collection: slugs.jobCategories, label: 'job category' },
    { collection: slugs.locations, label: 'location' },
    { collection: slugs.jobTypes, label: 'job type' },
  ],
  reserved,
})

type IDLike = null | number | string | undefined

export type AssertUniqueSlugArgs = {
  /** The collection the document belongs to; it must be one of `rules.namespaces`. */
  collection: string
  req: PayloadRequest
  rules: SlugRules
  /** The document being updated, so it does not clash with itself. */
  selfID?: IDLike
  slug: string
  /** `null` in single-tenant mode, where there is no tenant to scope to. */
  tenant: IDLike
}

/** A human-readable reason the slug cannot be used, or `null` when it is free. */
export const slugConflict = async ({
  collection,
  req,
  rules,
  selfID,
  slug,
  tenant,
}: AssertUniqueSlugArgs): Promise<null | string> => {
  if (rules.reserved.includes(slug)) {
    return `The slug "${slug}" is reserved and cannot be used`
  }

  const ownID = selfID === undefined || selfID === null ? null : String(selfID)
  const hasTenant = tenant !== null && tenant !== undefined

  for (const namespace of rules.namespaces) {
    // A host may leave a collection out (a feature switched off); nothing to clash with there.
    const registered = req.payload.collections as Record<string, unknown> | undefined
    if (registered && !registered[namespace.collection]) continue

    const { docs } = await req.payload.find({
      collection: namespace.collection as CollectionSlug,
      depth: 0,
      limit: 2,
      overrideAccess: true,
      pagination: false,
      req,
      where: {
        and: [
          { slug: { equals: slug } },
          ...(hasTenant ? [{ tenant: { equals: tenant } }] : []),
        ],
      },
    })

    // Ids repeat across collections, so only the document's own collection excludes itself.
    const clash = docs.some(
      (doc) => namespace.collection !== collection || String(doc.id) !== ownID,
    )
    if (clash) {
      return namespace.collection === collection
        ? `The slug "${slug}" is already used by another ${namespace.label} in this tenant`
        : `The slug "${slug}" is already used by a ${namespace.label} in this tenant. Job categories, locations and job types share one URL namespace`
    }
  }

  return null
}

/** Throws a field error on `slug` when {@link slugConflict} finds a clash. */
export const assertUniqueSlug = async (args: AssertUniqueSlugArgs): Promise<void> => {
  const message = await slugConflict(args)
  if (message) {
    throw new ValidationError({
      collection: args.collection as CollectionSlug,
      errors: [{ message, path: 'slug' }],
      req: args.req,
    })
  }
}

const tenantIDOf = (tenant: unknown): IDLike =>
  tenant !== null && typeof tenant === 'object'
    ? (tenant as { id?: number | string }).id
    : (tenant as IDLike)

/**
 * beforeValidate hook for a collection in the shared namespace. It runs when a slug or a tenant
 * is submitted, so a write that touches neither is never blocked by a later clash; renaming one
 * to a taken slug, or moving it to a tenant where its slug is taken, is.
 */
export const sharedSlugHook =
  (collection: string, rules: SlugRules): CollectionBeforeValidateHook =>
  async ({ data, originalDoc, req }) => {
    // Moving a document to another tenant changes where its stored slug has to be free, so a
    // write that submits only `tenant` is checked too, against the slug already stored.
    if (data?.slug === undefined && data?.tenant === undefined) return data

    const raw = data?.slug ?? originalDoc?.slug
    const slug = typeof raw === 'string' ? raw.trim() : ''
    if (!slug) return data

    await assertUniqueSlug({
      collection,
      req,
      rules,
      selfID: originalDoc?.id,
      slug,
      tenant: tenantIDOf(data?.tenant ?? originalDoc?.tenant),
    })
    return data
  }
