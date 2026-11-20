import {
  APIError,
  ValidationError,
  type Access,
  type AccessResult,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type PayloadRequest,
  type Where,
} from 'payload'

import {
  getUserOrganisationID,
  getUserTenantIDsByRole,
  hasAnyTenantRole,
  isSuperAdmin,
  type MissionControlUser,
} from '../access'
import { tenantIDOf } from '../catalog'
import { JOBS_SLUG, JOB_EMPLOYER_ROLES, JOB_STAFF_ROLES } from './jobs'
import { ORGANISATIONS_SLUG } from './organisations'

/**
 * Applications (PJ-25). One document per application to a job, private to the job's
 * organisation and the site managers (STATUS.md, decisions 1 and 18): there is no public
 * create, and no site key ever reads one. Applications and their files are created by the apply
 * endpoint (PJ-45) with `overrideAccess`, and deleted by the retention job (PJ-88).
 *
 * `organisation` and `tenant` are copied from the job on the server, never taken from the
 * request, because access to an application is decided by them.
 */

export const APPLICATIONS_SLUG = 'applications'
export const APPLICATION_FILES_SLUG = 'application-files'

export const APPLICATION_FILE_MAX_BYTES = 10 * 1024 * 1024

export const APPLICATION_FILE_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Payload sniffs the bytes, and a legacy .doc is an OLE compound file.
  'application/x-cfb',
]

/** The plain-text message is capped so an application cannot carry a book. */
export const APPLICATION_MESSAGE_MAX_LENGTH = 5000

const userOf = (req: PayloadRequest): MissionControlUser | null =>
  (req.user as MissionControlUser | null | undefined) ?? null

const combine = (scopes: (null | Where)[]): AccessResult => {
  const present = scopes.filter((scope): scope is Where => scope !== null)
  if (present.length === 0) return false
  return present.length === 1 ? present[0] : { or: present }
}

/**
 * Who may read an application (or one of its files):
 * - super admins: all; site managers: everything in their tenants;
 * - employers: their own organisation's, in the tenants where they are employers;
 * - an applicant: their own application, and nobody else's;
 * - anonymous callers and site keys: nothing.
 */
export const applicationReadAccess =
  (tenantScoped: boolean, applicantField: null | string): Access =>
  ({ req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true

    const applicantScope: null | Where =
      applicantField === null || user.id === undefined || user.id === null
        ? null
        : { [applicantField]: { equals: user.id } }

    if (!tenantScoped) {
      if (hasAnyTenantRole(user, JOB_STAFF_ROLES)) return true

      const organisation = getUserOrganisationID(user)
      return combine([
        organisation !== null && hasAnyTenantRole(user, JOB_EMPLOYER_ROLES)
          ? { organisation: { equals: organisation } }
          : null,
        applicantScope,
      ])
    }

    const staffTenants = getUserTenantIDsByRole(user, JOB_STAFF_ROLES)
    const employerTenants = getUserTenantIDsByRole(user, JOB_EMPLOYER_ROLES)
    const organisation = getUserOrganisationID(user)

    return combine([
      staffTenants.length > 0 ? { tenant: { in: staffTenants } } : null,
      organisation !== null && employerTenants.length > 0
        ? { and: [{ organisation: { equals: organisation } }, { tenant: { in: employerTenants } }] }
        : null,
      applicantScope,
    ])
  }

/** Nobody creates or edits an application over REST/GraphQL: the apply endpoint does, as the system. */
export const applicationNoWriteAccess: Access = () => false

/**
 * Deleting personal data is a decision: super admins and the tenant's admins only. Employers
 * and editors cannot. The retention job deletes as the system.
 */
export const applicationDeleteAccess =
  (tenantScoped: boolean): Access =>
  ({ req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true

    if (!tenantScoped) return hasAnyTenantRole(user, ['tenant-admin'])

    const tenants = getUserTenantIDsByRole(user, ['tenant-admin'])
    return tenants.length > 0 ? { tenant: { in: tenants } } : false
  }

type JobDoc = { id: number | string; organisation?: unknown; tenant?: unknown }

const loadJob = async (req: PayloadRequest, jobsSlug: string, id: unknown): Promise<JobDoc | null> => {
  const jobID = tenantIDOf(id)
  if (jobID === null) return null

  try {
    return (await req.payload.findByID({
      collection: jobsSlug as CollectionSlug,
      depth: 0,
      id: jobID,
      overrideAccess: true,
      req,
    })) as unknown as JobDoc
  } catch {
    return null
  }
}

/**
 * Copy `organisation` (and `tenant`) from the job on create, so a request cannot point an
 * application at one organisation's job and file it under another's. On update the job cannot
 * be moved: the application is a record of what was sent.
 */
export const applicationFromJob =
  ({ jobsSlug, tenantScoped }: { jobsSlug: string; tenantScoped: boolean }): CollectionBeforeValidateHook =>
  async ({ data, operation, originalDoc, req }) => {
    if (!data) return data

    if (operation === 'update') {
      const original = originalDoc as { job?: unknown } | undefined
      if (data.job !== undefined && String(tenantIDOf(data.job)) !== String(tenantIDOf(original?.job))) {
        throw new ValidationError({ errors: [{ message: 'An application cannot be moved to another job', path: 'job' }] })
      }
      return data
    }

    const job = await loadJob(req, jobsSlug, data.job)
    if (!job) {
      throw new ValidationError({ errors: [{ message: 'The job does not exist', path: 'job' }] })
    }

    const organisation = tenantIDOf(job.organisation)
    if (organisation === null) {
      throw new ValidationError({ errors: [{ message: 'The job has no organisation', path: 'job' }] })
    }

    const next: Record<string, unknown> = { ...data, organisation }
    if (tenantScoped) next.tenant = tenantIDOf(job.tenant)

    return next
  }

/** The CV (and cover letter) must have been uploaded for this same organisation. */
export const applicationFilesMatchOrganisation =
  (filesSlug: string): CollectionBeforeChangeHook =>
  async ({ data, req }) => {
    for (const field of ['cv', 'coverLetter'] as const) {
      const fileID = tenantIDOf((data as Record<string, unknown>)[field])
      if (fileID === null) continue

      const file = (await req.payload
        .findByID({ collection: filesSlug as CollectionSlug, depth: 0, id: fileID, overrideAccess: true, req })
        .catch(() => null)) as null | { organisation?: unknown }

      if (!file || String(tenantIDOf(file.organisation)) !== String(tenantIDOf((data as Record<string, unknown>).organisation))) {
        throw new ValidationError({
          errors: [{ message: 'The file was not uploaded for this organisation’s job', path: field }],
        })
      }
    }

    return data
  }

export type ApplicationsCollectionOptions = {
  /** Slug of the auth collection applicants sign in with. `null` leaves the applicant field out. */
  applicantsSlug?: null | string
  /** Slug of the private upload collection holding CVs. Defaults to `application-files`. */
  filesSlug?: string
  /** Slug of the jobs collection. Defaults to `jobs`. */
  jobsSlug?: string
  /** Slug of the organisations collection. Defaults to `organisations`. */
  organisationsSlug?: string
  tenantScoped: boolean
}

export const applicationsCollection = ({
  applicantsSlug = 'users',
  filesSlug = APPLICATION_FILES_SLUG,
  jobsSlug = JOBS_SLUG,
  organisationsSlug = ORGANISATIONS_SLUG,
  tenantScoped,
}: ApplicationsCollectionOptions): CollectionConfig => ({
  slug: APPLICATIONS_SLUG,
  access: {
    create: applicationNoWriteAccess,
    delete: applicationDeleteAccess(tenantScoped),
    read: applicationReadAccess(tenantScoped, applicantsSlug === null ? null : 'applicant'),
    update: applicationNoWriteAccess,
  },
  admin: {
    defaultColumns: ['name', 'email', 'job', 'createdAt'],
    useAsTitle: 'name',
  },
  fields: [
    { name: 'job', type: 'relationship', relationTo: jobsSlug as CollectionSlug, required: true, index: true },
    {
      // Denormalised from the job on the server: access is decided by it.
      name: 'organisation',
      type: 'relationship',
      relationTo: organisationsSlug as CollectionSlug,
      index: true,
      admin: { description: 'Copied from the job. Not editable.', readOnly: true },
    },
    ...(applicantsSlug === null
      ? []
      : [
          {
            name: 'applicant',
            type: 'relationship' as const,
            relationTo: applicantsSlug as CollectionSlug,
            index: true,
            admin: { description: 'Set when the applicant was signed in; guests apply with an email only.' },
          },
        ]),
    { name: 'name', type: 'text', required: true },
    { name: 'email', type: 'email', required: true, index: true },
    { name: 'phone', type: 'text' },
    {
      name: 'message',
      type: 'textarea',
      admin: { description: 'Plain text. No formatting or HTML.' },
      maxLength: APPLICATION_MESSAGE_MAX_LENGTH,
    },
    {
      name: 'cv',
      type: 'relationship',
      relationTo: filesSlug as CollectionSlug,
      required: true,
    },
    { name: 'coverLetter', type: 'relationship', relationTo: filesSlug as CollectionSlug },
    {
      name: 'consentAt',
      type: 'date',
      required: true,
      admin: { description: 'When the applicant agreed to the privacy policy.' },
    },
  ],
  hooks: {
    beforeChange: [applicationFilesMatchOrganisation(filesSlug)],
    beforeValidate: [applicationFromJob({ jobsSlug, tenantScoped })],
  },
  versions: false,
})

/**
 * Payload checks the type of the bytes against `upload.mimeTypes`, but has no per-collection
 * size limit, so the 10 MB cap is checked here.
 */
export const validateApplicationFileSize: CollectionBeforeValidateHook = ({ data, req }) => {
  if (req.file && req.file.size > APPLICATION_FILE_MAX_BYTES) {
    throw new APIError('A CV or cover letter can be at most 10 MB.', 400, undefined, true)
  }

  return data
}

/**
 * The private upload collection for CVs and cover letters. It is not the host's `documents`
 * collection: that one is readable by every member of a tenant, and an employer must never
 * read another organisation's CVs. Read access mirrors the applications'. The host maps it to
 * its storage (R2) like any other upload collection.
 */
export const applicationFilesCollection = ({
  applicantsSlug = 'users',
  organisationsSlug = ORGANISATIONS_SLUG,
  tenantScoped,
}: {
  applicantsSlug?: null | string
  organisationsSlug?: string
  tenantScoped: boolean
}): CollectionConfig => ({
  slug: APPLICATION_FILES_SLUG,
  access: {
    create: applicationNoWriteAccess,
    delete: applicationDeleteAccess(tenantScoped),
    read: applicationReadAccess(tenantScoped, applicantsSlug === null ? null : 'applicant'),
    update: applicationNoWriteAccess,
  },
  admin: { group: 'Applications', useAsTitle: 'filename' },
  fields: [
    {
      name: 'organisation',
      type: 'relationship',
      relationTo: organisationsSlug as CollectionSlug,
      index: true,
      required: true,
      admin: { readOnly: true },
    },
    ...(applicantsSlug === null
      ? []
      : [
          {
            name: 'applicant',
            type: 'relationship' as const,
            relationTo: applicantsSlug as CollectionSlug,
            index: true,
          },
        ]),
  ],
  hooks: { beforeValidate: [validateApplicationFileSize] },
  upload: { mimeTypes: APPLICATION_FILE_MIME_TYPES },
  versions: false,
})
