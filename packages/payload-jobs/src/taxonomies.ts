import {
  ValidationError,
  type Access,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type Field,
} from 'payload'

import {
  authenticatedAccess,
  getUserTenantIDsByRole,
  isSuperAdmin,
  type MissionControlUser,
} from './access'
import {
  mergeCollectionAccess,
  type CollectionAccess,
  type PayloadJobsCollectionSlugs,
} from './slugs'

/**
 * Job-board taxonomies. They replace the WordPress term taxonomies `job_cat`, `job_type`
 * and `job_salary` (see AUDIT.md). `job_tag` and the `area-of-focus` user taxonomy are no
 * longer imported; their collections were removed in PJ-80 because no terms exist.
 */

export const TAXONOMY_SLUGS = ['job-categories', 'job-types', 'salary-bands'] as const

export type TaxonomySlug = (typeof TAXONOMY_SLUGS)[number]

/** Roles that maintain a tenant's taxonomies. Employers only pick from them when posting. */
export const TAXONOMY_EDITOR_ROLES = ['tenant-admin', 'editor'] as const

export const TAXONOMY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const validateTaxonomySlug = (value: null | string | undefined): string | true =>
  value && TAXONOMY_SLUG_PATTERN.test(value)
    ? true
    : 'Use lowercase letters, numbers and single hyphens, for example hospitality-tourism'

/**
 * Public sites read taxonomies for listing filters. They authenticate with a site key, which
 * grants anonymous access to a tenant's documents; the CMS plugs that in as the
 * collection's `accessResultOverride`.
 */
export const taxonomyReadAccess: Access = authenticatedAccess

const tenantIDOf = (tenant: unknown): null | number | string => {
  if (tenant === null || tenant === undefined) return null
  if (typeof tenant === 'object') return (tenant as { id?: number | string }).id ?? null
  return tenant as number | string
}

/**
 * Only a tenant-admin or editor writes taxonomies, and only inside a tenant where they hold
 * that role. Create checks the submitted `tenant` explicitly, because a `where` result does
 * not filter create data.
 */
export const taxonomyWriteAccess: Access = ({ data, req }) => {
  const user = req.user as MissionControlUser | null | undefined

  if (!user) return false
  if (isSuperAdmin(user)) return true

  const tenantIDs = getUserTenantIDsByRole(user, TAXONOMY_EDITOR_ROLES)
  if (tenantIDs.length === 0) return false

  const submitted = tenantIDOf((data as { tenant?: unknown } | undefined)?.tenant)
  if (submitted !== null && !tenantIDs.some((id) => String(id) === String(submitted))) return false

  // Payload ignores a `where` on create, so the check above is what gates a new document.
  return { tenant: { in: tenantIDs } }
}

/**
 * Reject a slug another document in the same tenant already uses, as a field error rather
 * than a raw unique-index failure. The index still guards against concurrent writes.
 */
export const uniqueSlugPerTenant =
  (collectionSlug: CollectionSlug): CollectionBeforeValidateHook =>
  async ({ data, originalDoc, req }) => {
    const slug = typeof data?.slug === 'string' ? data.slug.trim() : ''
    const tenantID = tenantIDOf(data?.tenant ?? originalDoc?.tenant)

    if (!slug || tenantID === null) return data

    const selfID = originalDoc?.id
    const { docs } = await req.payload.find({
      collection: collectionSlug as CollectionSlug,
      depth: 0,
      limit: 2,
      overrideAccess: true,
      pagination: false,
      req,
      where: {
        and: [{ slug: { equals: slug } }, { tenant: { equals: tenantID } }],
      },
    })

    const conflict = docs.some((doc) => selfID === undefined || String(doc.id) !== String(selfID))
    if (conflict) {
      throw new ValidationError({
        collection: collectionSlug as CollectionSlug,
        errors: [{ message: `Slug "${slug}" is already used in this tenant`, path: 'slug' }],
        req,
      })
    }

    return data
  }

type TaxonomyOptions = {
  /** Overrides the collection's default access, operation by operation. */
  access?: CollectionAccess
  /** Extra fields that only one taxonomy needs, such as `isVolunteer` on job types. */
  extraFields?: Field[]
  labels: { plural: string; singular: string }
  /** `false` drops the tenant scope, for single-tenant setups with no tenants collection. */
  tenantScoped?: boolean
  slug: string
}

/**
 * Shared taxonomy shape: a localized `name`, a `slug` that is unique per tenant, and an
 * indexed optional `legacyId` for the WordPress import.
 */
export const taxonomyCollection = ({
  access,
  extraFields = [],
  labels,
  slug,
  tenantScoped = true,
}: TaxonomyOptions): CollectionConfig => ({
  slug,
  access: mergeCollectionAccess(
    {
      create: taxonomyWriteAccess,
      delete: taxonomyWriteAccess,
      read: taxonomyReadAccess,
      update: taxonomyWriteAccess,
    },
    access,
  ),
  admin: {
    defaultColumns: ['name', 'slug', 'legacyId'],
    group: 'Job board',
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      localized: true,
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      index: !tenantScoped,
      required: true,
      unique: !tenantScoped,
      validate: validateTaxonomySlug,
      admin: {
        description: 'Used in listing URLs and filters. Unique within the tenant.',
      },
    },
    {
      name: 'legacyId',
      type: 'number',
      index: true,
      admin: {
        description: 'WordPress term id, for the import.',
      },
    },
    ...extraFields,
  ],
  hooks: {
    beforeValidate: [uniqueSlugPerTenant(slug as CollectionSlug)],
  },
  // The unique index spans the tenant, so the same slug may exist on two tenants.
  indexes: tenantScoped ? [{ fields: ['tenant', 'slug'], unique: true }] : [],
  labels,
  versions: false,
})

const isVolunteerField: Field = {
  name: 'isVolunteer',
  type: 'checkbox',
  defaultValue: false,
  admin: {
    description:
      'Volunteer job types are kept out of the main listing and can be posted for free.',
  },
}

export type TaxonomyCollectionOptions = {
  /** Access overrides keyed by taxonomy, applied on top of the defaults. */
  access?: {
    jobCategories?: CollectionAccess
    jobTypes?: CollectionAccess
    salaryBands?: CollectionAccess
  }
  /** Resolved collection slugs. Defaults to the plugin's own names. */
  slugs?: Pick<PayloadJobsCollectionSlugs, 'jobCategories' | 'jobTypes' | 'salaryBands'>
  /** Set to `false` in single-tenant mode, where there is no `tenants` collection. */
  tenantScoped?: boolean
}

/**
 * The three job-board taxonomies. In multi-tenant mode the multi-tenant plugin scopes each one
 * and adds the `tenant` field that the unique index relies on.
 */
export const taxonomyCollections = ({
  access = {},
  slugs = {
    jobCategories: 'job-categories',
    jobTypes: 'job-types',
    salaryBands: 'salary-bands',
  },
  tenantScoped = true,
}: TaxonomyCollectionOptions = {}): CollectionConfig[] => [
  taxonomyCollection({
    access: access.jobCategories,
    labels: { plural: 'Job categories', singular: 'Job category' },
    slug: slugs.jobCategories,
    tenantScoped,
  }),
  taxonomyCollection({
    access: access.jobTypes,
    extraFields: [isVolunteerField],
    labels: { plural: 'Job types', singular: 'Job type' },
    slug: slugs.jobTypes,
    tenantScoped,
  }),
  taxonomyCollection({
    access: access.salaryBands,
    labels: { plural: 'Salary bands', singular: 'Salary band' },
    slug: slugs.salaryBands,
    tenantScoped,
  }),
]
