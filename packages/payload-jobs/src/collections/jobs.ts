import {
  ValidationError,
  type Access,
  type AccessResult,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type Field,
  type FieldAccess,
  type PayloadRequest,
  type Where,
} from 'payload'

import {
  getUserOrganisationID,
  getUserTenantIDsByRole,
  hasAnyTenantRole,
  hasTenantRole,
  isSeekerOnly,
  isSuperAdmin,
  type MissionControlUser,
  type TenantRole,
} from '../access'
import { idsOf, resultingTenantID, submitsTenant, tenantIDOf } from '../catalog'
import {
  datesForTransition,
  EMPLOYER_EDITABLE_STATUSES,
  isJobStatus,
  JOB_STATUS_LABELS,
  JOB_STATUSES,
  jobTransitionProblem,
  PUBLIC_JOB_FILTER,
  type JobActor,
  type JobStatus,
} from '../job-status'
import { jobPlacementsField } from '../placements'
import { assertPlanAllowsJob, PricingError, type QuoteJob } from '../pricing'
import { getSiteKeyHeader, resolveSiteKey } from '../site-keys'
import { TAXONOMY_SLUG_PATTERN, uniqueSlugPerTenant } from '../taxonomies'
import {
  DEFAULT_PAYLOAD_JOBS_SLUGS,
  mergeCollectionAccess,
  type CollectionAccess,
  type PayloadJobsCollectionSlugs,
} from '../slugs'
import { validateUrl } from './organisations'

/**
 * Jobs (PJ-19). A job belongs to one organisation in one tenant. Employers write their own
 * drafts and pending jobs (through the /account API or REST); checkout, moderation and the
 * expiry task move them on (`job-status.ts`); staff can do everything.
 *
 * TODO(PJ-23): `order` (relationship to orders) once the orders collection exists.
 */

export const JOBS_SLUG = 'jobs'

/** Staff roles that manage every job in their tenants. */
export const JOB_STAFF_ROLES = ['tenant-admin', 'editor'] as const satisfies readonly TenantRole[]

/** Roles that post jobs for their own organisation. */
export const JOB_EMPLOYER_ROLES = ['employer'] as const satisfies readonly TenantRole[]

/**
 * Set this on `req.context` to let trusted code (the job page view counter) change `views`.
 * Without it the count keeps its stored value, whoever writes.
 */
export const JOB_VIEWS_CONTEXT = 'jobViews'

const userOf = (req: PayloadRequest): MissionControlUser | null =>
  (req.user as MissionControlUser | null | undefined) ?? null

const hasCollection = (req: PayloadRequest, slug: string): boolean =>
  Boolean((req.payload?.collections as Record<string, unknown> | undefined)?.[slug])

const isStaffIn = (user: MissionControlUser, tenantID: null | number | string): boolean =>
  tenantID !== null && hasTenantRole(user, tenantID, JOB_STAFF_ROLES)

/** Who is acting on a job in `tenantID`: system code (no user), staff, or an employer. */
export const jobActorFor = (
  user: MissionControlUser | null,
  tenantID: null | number | string,
  tenantScoped: boolean,
): JobActor => {
  if (!user) return 'system'
  if (isSuperAdmin(user)) return 'staff'
  if (!tenantScoped) return hasAnyTenantRole(user, JOB_STAFF_ROLES) ? 'staff' : 'employer'
  return isStaffIn(user, tenantID) ? 'staff' : 'employer'
}

/** An employer's own organisation's jobs, in the tenants where they hold the employer role. */
const employerScope = (user: MissionControlUser, tenantScoped: boolean, extra: Where[] = []): null | Where => {
  const organisation = getUserOrganisationID(user)
  if (organisation === null) return null
  const tenants = getUserTenantIDsByRole(user, JOB_EMPLOYER_ROLES)
  if (tenantScoped && tenants.length === 0) return null
  if (!tenantScoped && !hasAnyTenantRole(user, JOB_EMPLOYER_ROLES)) return null

  return {
    and: [
      { organisation: { equals: organisation } },
      ...(tenantScoped ? [{ tenant: { in: tenants } }] : []),
      ...extra,
    ],
  }
}

const combine = (scopes: (null | Where)[]): AccessResult => {
  const present = scopes.filter((scope): scope is Where => scope !== null)
  if (present.length === 0) return false
  return present.length === 1 ? present[0] : { or: present }
}

/**
 * Read access.
 * - Super admins: every job. Staff: every job in their tenants.
 * - Employers: their own organisation's jobs, whatever the status.
 * - Anonymous with a valid site key: published and expired jobs of the key's tenant (every
 *   tenant for the aggregate key). Listings narrow that to live jobs (`liveJobsWhere`).
 * - Seekers and keyless requests: nothing.
 */
export const jobReadAccess =
  (tenantScoped: boolean): Access =>
  async ({ req }) => {
    const user = userOf(req)

    if (!user) {
      if (!tenantScoped || !getSiteKeyHeader(req) || !hasCollection(req, 'site-keys')) return false
      const siteKey = await resolveSiteKey(req)
      if (!siteKey) return false
      if (siteKey.isAggregate) return PUBLIC_JOB_FILTER
      return { and: [{ tenant: { equals: siteKey.tenantID } }, PUBLIC_JOB_FILTER] }
    }

    if (isSuperAdmin(user)) return true
    if (isSeekerOnly(user)) return false

    if (!tenantScoped) {
      if (hasAnyTenantRole(user, JOB_STAFF_ROLES)) return true
      return combine([employerScope(user, false)])
    }

    const staffTenants = getUserTenantIDsByRole(user, JOB_STAFF_ROLES)
    return combine([
      staffTenants.length > 0 ? { tenant: { in: staffTenants } } : null,
      employerScope(user, true),
    ])
  }

/**
 * Create: staff in the submitted tenant; an employer in a tenant where they are an employer,
 * for their own organisation only. A `where` result doesn't filter create data, so both are
 * checked against the submitted values here.
 */
export const jobCreateAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = userOf(req)
    if (!user || isSeekerOnly(user)) return false

    const submittedTenant = tenantIDOf((data as { tenant?: unknown } | undefined)?.tenant)
    if (tenantScoped && submittedTenant === null) return false
    if (isSuperAdmin(user)) return true

    if (tenantScoped ? isStaffIn(user, submittedTenant) : hasAnyTenantRole(user, JOB_STAFF_ROLES)) return true

    const organisation = getUserOrganisationID(user)
    const submittedOrganisation = tenantIDOf((data as { organisation?: unknown } | undefined)?.organisation)
    if (organisation === null || submittedOrganisation === null) return false
    if (String(organisation) !== String(submittedOrganisation)) return false

    return tenantScoped
      ? hasTenantRole(user, submittedTenant as number | string, JOB_EMPLOYER_ROLES)
      : hasAnyTenantRole(user, JOB_EMPLOYER_ROLES)
  }

/**
 * Update: staff anywhere in their tenants; employers only their own organisation's jobs while
 * still a draft or pending. A submitted tenant must be one the user may write in.
 */
export const jobUpdateAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = userOf(req)
    if (!user || isSeekerOnly(user)) return false
    if (isSuperAdmin(user)) return true

    const editable: Where = { status: { in: [...EMPLOYER_EDITABLE_STATUSES] } }

    if (!tenantScoped) {
      if (hasAnyTenantRole(user, JOB_STAFF_ROLES)) return true
      return combine([employerScope(user, false, [editable])])
    }

    const staffTenants = getUserTenantIDsByRole(user, JOB_STAFF_ROLES)
    const employerTenants = getUserTenantIDsByRole(user, JOB_EMPLOYER_ROLES)

    if (submitsTenant(data)) {
      const submitted = tenantIDOf((data as { tenant?: unknown }).tenant)
      const allowed = [...staffTenants, ...employerTenants]
      if (submitted === null || !allowed.some((id) => String(id) === String(submitted))) return false
    }

    return combine([
      staffTenants.length > 0 ? { tenant: { in: staffTenants } } : null,
      employerScope(user, true, [editable]),
    ])
  }

/** Deleting a job loses its history; staff only. Employers cancel instead. */
export const jobDeleteAccess =
  (tenantScoped: boolean): Access =>
  ({ req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true
    const staffTenants = getUserTenantIDsByRole(user, JOB_STAFF_ROLES)
    if (staffTenants.length === 0) return false
    return tenantScoped ? { tenant: { in: staffTenants } } : true
  }

/**
 * Fields only staff (and system code) may write: the publish dates, the plan, the legacy id.
 * Checked against the job's own tenant, so staff of an unrelated tenant decide nothing here.
 */
export const jobStaffFieldAccess =
  (tenantScoped: boolean): FieldAccess =>
  ({ data, doc, req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true
    if (!tenantScoped) return hasAnyTenantRole(user, JOB_STAFF_ROLES)
    return isStaffIn(user, tenantIDOf(doc?.tenant ?? (data as { tenant?: unknown } | undefined)?.tenant))
  }

/**
 * Read access for job fields the public site must never see (the applications email, the plan,
 * the view count, which add-on bought a placement): staff of the job's tenant, super admins, and
 * employers of the job's own organisation. Site keys, anonymous callers and seekers get the job
 * without them. System code reads with `overrideAccess`; application submission (PJ-45) resolves
 * the recipient server-side.
 */
export const jobPrivateFieldRead =
  (tenantScoped: boolean): FieldAccess =>
  ({ doc, req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true
    if (isSeekerOnly(user)) return false

    const tenantID = tenantIDOf((doc as { tenant?: unknown } | undefined)?.tenant)
    if (tenantScoped ? isStaffIn(user, tenantID) : hasAnyTenantRole(user, JOB_STAFF_ROLES)) return true

    const organisation = getUserOrganisationID(user)
    const jobOrganisation = tenantIDOf((doc as { organisation?: unknown } | undefined)?.organisation)
    if (organisation === null || jobOrganisation === null) return false
    if (String(organisation) !== String(jobOrganisation)) return false
    return tenantScoped
      ? tenantID !== null && hasTenantRole(user, tenantID, JOB_EMPLOYER_ROLES)
      : hasAnyTenantRole(user, JOB_EMPLOYER_ROLES)
  }

/** Turn a title into a slug: lowercase ASCII words joined by single hyphens. */
export const slugifyTitle = (title: string): string =>
  title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '') || 'job'

/**
 * Give a job without a slug one made from its title, unique in its tenant (`-2`, `-3`… on a
 * clash). An explicit slug is left alone; the unique-slug hook reports a clash for it.
 */
export const autoJobSlug =
  (tenantScoped: boolean, collectionSlug = JOBS_SLUG): CollectionBeforeValidateHook =>
  async ({ data, originalDoc, req }) => {
    if (!data) return data
    const current = typeof data.slug === 'string' ? data.slug.trim() : (originalDoc?.slug as string | undefined)
    if (current) return data

    const title = typeof data.title === 'string' ? data.title : (originalDoc?.title as string | undefined)
    if (!title) return data

    const base = slugifyTitle(title)
    const tenantID = tenantIDOf(data.tenant ?? originalDoc?.tenant)
    const { docs } = await req.payload.find({
      collection: collectionSlug as CollectionSlug,
      depth: 0,
      limit: 1000,
      overrideAccess: true,
      pagination: false,
      req,
      select: { slug: true },
      where: {
        and: [
          { slug: { like: base } },
          ...(tenantScoped && tenantID !== null ? [{ tenant: { equals: tenantID } }] : []),
          ...(originalDoc?.id !== undefined ? [{ id: { not_equals: originalDoc.id } }] : []),
        ],
      },
    })
    const taken = new Set(docs.map((doc) => (doc as { slug?: string }).slug))
    let slug = base
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`

    return { ...data, slug }
  }

export const validateJobSlug = (value: null | string | undefined): string | true =>
  value === null || value === undefined || value === '' || TAXONOMY_SLUG_PATTERN.test(value)
    ? true
    : 'Use lowercase letters, numbers and single hyphens, for example accountant-port-vila'

/** The relationship fields that must point inside the job's tenant, and what they relate to. */
const relationsFor = (
  documentsSlug: null | string,
  slugs: PayloadJobsCollectionSlugs,
): { label: string; path: string; relationTo: string }[] => [
  { label: 'organisation', path: 'organisation', relationTo: slugs.organisations },
  { label: 'job type', path: 'jobType', relationTo: slugs.jobTypes },
  { label: 'category', path: 'categories', relationTo: slugs.jobCategories },
  { label: 'salary band', path: 'salaryBand', relationTo: slugs.salaryBands },
  { label: 'location', path: 'location', relationTo: slugs.locations },
  { label: 'plan', path: 'plan', relationTo: slugs.plans },
  ...(documentsSlug ? [{ label: 'job description file', path: 'jobDescriptionPdf', relationTo: documentsSlug }] : []),
]

const valueAfterSave = (
  data: Record<string, unknown> | undefined,
  originalDoc: Record<string, unknown> | undefined,
  path: string,
): unknown => (data && Object.prototype.hasOwnProperty.call(data, path) ? data[path] : originalDoc?.[path])

/**
 * Every relation must point inside the job's tenant. The admin pickers are filtered by the
 * multi-tenant plugin, but a REST or local API write could still name another tenant's documents.
 */
export const jobRelationsInTenant =
  (
    tenantScoped: boolean,
    documentsSlug: null | string,
    slugs: PayloadJobsCollectionSlugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  ): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    if (!tenantScoped) return data
    const tenantID = resultingTenantID(data, originalDoc)
    if (tenantID === null) {
      throw new ValidationError({
        collection: collection.slug,
        errors: [{ message: 'A job must belong to a tenant', path: 'tenant' }],
        req,
      })
    }

    const errors: { message: string; path: string }[] = []
    for (const { label, path, relationTo } of relationsFor(documentsSlug, slugs)) {
      if (!hasCollection(req, relationTo)) continue
      const ids = idsOf([valueAfterSave(data, originalDoc, path)].flat())
      if (ids.length === 0) continue
      const { totalDocs } = await req.payload.count({
        collection: relationTo as CollectionSlug,
        overrideAccess: true,
        req,
        where: { and: [{ id: { in: ids } }, { tenant: { equals: tenantID } }] },
      })
      if (totalDocs !== new Set(ids.map(String)).size) {
        errors.push({ message: `Pick a ${label} from this job’s tenant`, path })
      }
    }

    if (errors.length > 0) throw new ValidationError({ collection: collection.slug, errors, req })
    return data
  }

/**
 * The status rules (`job-status.ts`): the move must be allowed for the actor, and the publish
 * dates follow from it. Dates written explicitly by staff or system code win over the computed
 * ones; an employer can't write them at all (field access).
 */
export const jobStatusRules =
  (tenantScoped: boolean, plansSlug = 'plans'): CollectionBeforeChangeHook =>
  async ({ collection, data, operation, originalDoc, req }) => {
    const from: JobStatus | null =
      operation === 'create' ? null : isJobStatus(originalDoc?.status) ? originalDoc.status : 'draft'
    const to = (data && 'status' in data ? data.status : (originalDoc?.status ?? 'draft')) as JobStatus
    const actor = jobActorFor(userOf(req), resultingTenantID(data, originalDoc), tenantScoped)

    const problem = jobTransitionProblem(from, to, actor)
    if (problem) {
      throw new ValidationError({ collection: collection.slug, errors: [{ message: problem, path: 'status' }], req })
    }
    if (from === to) return { ...data, status: to }

    // The listing duration comes from the plan the job is on, when it has one.
    let durationDays: null | number = null
    const planID = tenantIDOf(valueAfterSave(data, originalDoc, 'plan'))
    if (planID !== null && hasCollection(req, plansSlug)) {
      const plan = (await req.payload.findByID({
        collection: plansSlug as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id: planID,
        overrideAccess: true,
        req,
      })) as null | { durationDays?: number }
      durationDays = plan?.durationDays ?? null
    }

    const dates = datesForTransition({
      durationDays,
      expiresAt: (valueAfterSave(data, originalDoc, 'expiresAt') as null | string | undefined) ?? null,
      from,
      now: new Date(),
      to,
    })
    const explicit = (field: 'expiresAt' | 'publishedAt') =>
      actor !== 'employer' && data !== undefined && data[field] !== undefined && data[field] !== originalDoc?.[field]

    return {
      ...data,
      ...(dates.publishedAt !== undefined && !explicit('publishedAt') ? { publishedAt: dates.publishedAt } : {}),
      ...(dates.expiresAt !== undefined && !explicit('expiresAt') ? { expiresAt: dates.expiresAt } : {}),
      status: to,
    }
  }

/**
 * A job's plan must allow it: the same type, category and volunteer rules as `quote()`. The job
 * type is read from the database so its own `isVolunteer` flag decides, never the caller.
 */
export const jobPlanAllowsJobWith =
  (slugs: PayloadJobsCollectionSlugs = DEFAULT_PAYLOAD_JOBS_SLUGS): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    const planID = tenantIDOf(valueAfterSave(data, originalDoc, 'plan'))
    if (planID === null || !hasCollection(req, slugs.plans)) return data

    const plan = await req.payload.findByID({
      collection: slugs.plans as CollectionSlug,
      depth: 0,
      disableErrors: true,
      id: planID,
      overrideAccess: true,
      req,
    })
    if (!plan) return data // jobRelationsInTenant / Payload reject a missing relation.

    const typeID = tenantIDOf(valueAfterSave(data, originalDoc, 'jobType'))
    const type =
      typeID === null || !hasCollection(req, slugs.jobTypes)
        ? null
        : ((await req.payload.findByID({
            collection: slugs.jobTypes as CollectionSlug,
            depth: 0,
            disableErrors: true,
            id: typeID,
            overrideAccess: true,
            req,
          })) as null | { id: number | string; isVolunteer?: boolean | null })

    const job: QuoteJob = {
      categories: idsOf([valueAfterSave(data, originalDoc, 'categories')].flat()),
      type: type ? { id: type.id, isVolunteer: type.isVolunteer === true } : typeID,
    }

    try {
      assertPlanAllowsJob(plan as never, job)
    } catch (error) {
      if (!(error instanceof PricingError)) throw error
      throw new ValidationError({
        collection: collection.slug,
        errors: [{ message: error.message, path: 'plan' }],
        req,
      })
    }
    return data
  }

/** The task's default plan rule, for hosts that keep the default slugs. */
export const jobPlanAllowsJob: CollectionBeforeChangeHook = jobPlanAllowsJobWith()

/**
 * Employers keep a job in their own organisation: they can't move one to another organisation.
 * Staff may (an employer joining another organisation, say). A new job's company name defaults
 * to its organisation's name.
 */
export const jobOrganisationRules =
  (
    tenantScoped: boolean,
    slugs: PayloadJobsCollectionSlugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  ): CollectionBeforeChangeHook =>
  async ({ collection, data, operation, originalDoc, req }) => {
    const organisationID = tenantIDOf(valueAfterSave(data, originalDoc, 'organisation'))
    if (organisationID === null) {
      throw new ValidationError({
        collection: collection.slug,
        errors: [{ message: 'A job must belong to an organisation', path: 'organisation' }],
        req,
      })
    }

    if (operation === 'update') {
      const actor = jobActorFor(userOf(req), resultingTenantID(data, originalDoc), tenantScoped)
      const before = tenantIDOf(originalDoc?.organisation)
      if (actor === 'employer' && before !== null && String(before) !== String(organisationID)) {
        throw new ValidationError({
          collection: collection.slug,
          errors: [{ message: 'A job stays with its organisation', path: 'organisation' }],
          req,
        })
      }
    }

    const companyName = valueAfterSave(data, originalDoc, 'companyName')
    if (typeof companyName === 'string' && companyName.trim()) return data

    const organisation = (await req.payload.findByID({
      collection: slugs.organisations as CollectionSlug,
      depth: 0,
      disableErrors: true,
      id: organisationID,
      overrideAccess: true,
      req,
      select: { name: true },
    })) as null | { name?: string }
    return organisation?.name ? { ...data, companyName: organisation.name } : data
  }

/** `views` only changes through the view counter (`JOB_VIEWS_CONTEXT`); a new job starts at 0. */
export const protectJobViews: CollectionBeforeChangeHook = ({ context, data, operation, originalDoc }) => {
  if (context?.[JOB_VIEWS_CONTEXT] === true) return data
  const current = operation === 'update' ? (originalDoc?.views ?? 0) : 0
  return data?.views === current ? data : { ...data, views: current }
}

export type JobsCollectionOptions = {
  /** Overrides the collection's default access, operation by operation. */
  access?: CollectionAccess
  /** The host's upload collection for PDF job descriptions; `null` leaves the field out. */
  documentsSlug?: null | string
  /**
   * A rich-text description needs the host's editor. Without one (a minimal host or a test
   * config) the description is plain text rather than failing the config.
   */
  richTextDescription?: boolean
  /** Resolved collection slugs, so relationships and queries never use a literal. */
  slugs?: PayloadJobsCollectionSlugs
  tenantScoped?: boolean
}

export const jobsCollection = ({
  access,
  documentsSlug = null,
  richTextDescription = true,
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  tenantScoped = true,
}: JobsCollectionOptions = {}): CollectionConfig => {
  const staffOnly = jobStaffFieldAccess(tenantScoped)
  const staffWrite = { create: staffOnly, update: staffOnly }
  const privateRead = jobPrivateFieldRead(tenantScoped)

  const descriptionField: Field = richTextDescription
    ? { name: 'description', type: 'richText', localized: true }
    : { name: 'description', type: 'textarea', localized: true }
  const jobDescriptionPdf: Field | null = documentsSlug
    ? {
        name: 'jobDescriptionPdf',
        type: 'upload',
        relationTo: documentsSlug as CollectionSlug,
        admin: { description: 'An optional PDF of the full job description.' },
      }
    : null

  const fields: Field[] = [
    { name: 'title', type: 'text', localized: true, required: true },
    {
      name: 'slug',
      type: 'text',
      index: true,
      unique: !tenantScoped,
      validate: validateJobSlug,
      admin: { description: 'Made from the title when left empty. Unique in the tenant.', position: 'sidebar' },
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'draft',
      index: true,
      required: true,
      options: JOB_STATUSES.map((value) => ({ label: JOB_STATUS_LABELS[value], value })),
      admin: { position: 'sidebar' },
    },
    { name: 'publishedAt', type: 'date', access: staffWrite, index: true, admin: { position: 'sidebar' } },
    { name: 'expiresAt', type: 'date', access: staffWrite, index: true, admin: { position: 'sidebar' } },
    {
      name: 'organisation',
      type: 'relationship',
      relationTo: slugs.organisations as CollectionSlug,
      index: true,
      required: true,
    },
    // mission-control: the edit view is grouped into tabs for site managers (PJ-30). Tabs are
    // presentational only: field names, columns and validation are unchanged, so queries and
    // CSV exports keep working; only code that walks `fields` must look inside a tab.
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Details',
          fields: [
            descriptionField,
            {
              type: 'row',
              fields: [
                {
                  name: 'jobType',
                  type: 'relationship',
                  relationTo: slugs.jobTypes as CollectionSlug,
                  index: true,
                },
                {
                  name: 'categories',
                  type: 'relationship',
                  hasMany: true,
                  relationTo: slugs.jobCategories as CollectionSlug,
                },
              ],
            },
            {
              type: 'row',
              fields: [
                { name: 'salaryBand', type: 'relationship', relationTo: slugs.salaryBands as CollectionSlug },
                { name: 'displayedSalary', type: 'text', localized: true },
              ],
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'companyName',
                  type: 'text',
                  admin: { description: 'Defaults to the organisation’s name.' },
                },
                { name: 'companyUrl', type: 'text', validate: validateUrl },
              ],
            },
          ],
        },
        {
          label: 'Location',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'location',
                  type: 'relationship',
                  hasMany: true,
                  relationTo: slugs.locations as CollectionSlug,
                  admin: {
                    description:
                      'One or more places in the tenant’s location tree. The job appears on every matching location page and its descendants.',
                  },
                },
                {
                  name: 'locationDetails',
                  type: 'textarea',
                  localized: true,
                  admin: {
                    description:
                      'Optional free-text detail, e.g. a street address or the legacy “Multiple locations” text.',
                  },
                },
              ],
            },
          ],
        },
        {
          label: 'Apply',
          fields: [
            { name: 'howToApply', type: 'textarea', localized: true },
            {
              type: 'row',
              fields: [
                { name: 'applyOnline', type: 'checkbox', defaultValue: true },
                {
                  name: 'applicationsRecipient',
                  type: 'email',
                  access: { read: privateRead },
                  admin: {
                    description: 'Where online applications go. Empty: the organisation’s contacts.',
                  },
                },
              ],
            },
          ],
        },
        // The PDF sits with the other attachments, away from the details a site manager edits
        // most often. Without a documents collection there is no tab.
        ...(jobDescriptionPdf ? [{ label: 'Files', fields: [jobDescriptionPdf] }] : []),
      ],
    },
    {
      name: 'plan',
      type: 'relationship',
      relationTo: slugs.plans as CollectionSlug,
      access: { ...staffWrite, read: privateRead },
      admin: { description: 'Set at checkout.', position: 'sidebar' },
    },
    jobPlacementsField({ addOnRead: privateRead, addOnsSlug: slugs.addOns }),
    {
      name: 'views',
      type: 'number',
      access: { read: privateRead },
      defaultValue: 0,
      min: 0,
      admin: { position: 'sidebar', readOnly: true },
    },
    {
      name: 'legacyId',
      type: 'number',
      access: { ...staffWrite, read: staffOnly },
      index: true,
      admin: { description: 'WordPress post id, for the import.', position: 'sidebar' },
    },
  ]

  return {
    slug: slugs.jobs,
    access: mergeCollectionAccess(
      {
        create: jobCreateAccess(tenantScoped),
        delete: jobDeleteAccess(tenantScoped),
        read: jobReadAccess(tenantScoped),
        update: jobUpdateAccess(tenantScoped),
      },
      access,
    ),
    admin: {
      defaultColumns: ['title', 'organisation', 'status', 'publishedAt', 'expiresAt'],
      group: 'Job board',
      useAsTitle: 'title',
    },
    defaultSort: '-publishedAt',
    fields,
    hooks: {
      beforeChange: [
        jobRelationsInTenant(tenantScoped, documentsSlug, slugs),
        jobOrganisationRules(tenantScoped, slugs),
        jobStatusRules(tenantScoped, slugs.plans),
        jobPlanAllowsJobWith(slugs),
        protectJobViews,
      ],
      beforeValidate: [
        autoJobSlug(tenantScoped, slugs.jobs),
        ...(tenantScoped ? [uniqueSlugPerTenant(slugs.jobs as CollectionSlug)] : []),
      ],
    },
    indexes: tenantScoped ? [{ fields: ['tenant', 'slug'], unique: true }] : [],
    labels: { plural: 'Jobs', singular: 'Job' },
    versions: false,
  }
}
