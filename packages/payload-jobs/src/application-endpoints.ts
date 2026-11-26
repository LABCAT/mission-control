import type { CollectionConfig, CollectionSlug, Endpoint, PayloadRequest, Where } from 'payload'

import {
  getUserOrganisationID,
  getUserTenantIDsByRole,
  hasAnyTenantRole,
  hasTenantRole,
  isSuperAdmin,
  type MissionControlUser,
} from './access'
import { APPLICATION_FILES_SLUG, APPLICATIONS_SLUG } from './collections/applications'
import { JOB_EMPLOYER_ROLES, JOB_STAFF_ROLES } from './collections/jobs'
import { tenantIDOf } from './catalog'
import { fileLinkURL } from './apply'
import { DEFAULT_PAYLOAD_JOBS_SLUGS, type PayloadJobsCollectionSlugs } from './slugs'

/**
 * Reading applications (PJ-46). Applications and CVs are private to the job's organisation and
 * the site managers (STATUS.md, decision 18), so every handler decides access itself, then reads
 * as the system. Nothing here is reachable with a site key or anonymously.
 *
 * - `GET /api/applications/for-job/:jobId`      JSON list (employer UI is PJ-82)
 * - `GET /api/applications/for-job/:jobId/csv`  the same rows as CSV
 * - `GET /api/applications/export?from&to&tenant` site managers: all applications in a date range
 *
 * File links are signed and expire (`fileLinkTtlSeconds`, default 7 days like the apply emails).
 */

export const APPLICATIONS_FOR_JOB_PATH = '/for-job/:jobId'
export const APPLICATIONS_FOR_JOB_CSV_PATH = '/for-job/:jobId/csv'
export const APPLICATIONS_EXPORT_PATH = '/export'

const DEFAULT_LINK_TTL_SECONDS = 7 * 24 * 60 * 60
const PAGE_SIZE = 200
/** A hard stop for one CSV: a larger range must be split. */
export const EXPORT_MAX_ROWS = 10_000
const MAX_LIST_LIMIT = 100

export type ApplicationEndpointOptions = {
  fileLinkTtlSeconds?: number
  slugs?: PayloadJobsCollectionSlugs
  tenantScoped?: boolean
}

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: { 'cache-control': 'private, no-store' }, status })

const userOf = (req: PayloadRequest): MissionControlUser | null =>
  (req.user as MissionControlUser | null | undefined) ?? null

/** Who may read the applications of this job: super admins, the tenant's staff, and the job's organisation. */
export const canReadJobApplications = ({
  job,
  tenantScoped,
  user,
}: {
  job: { organisation?: unknown; tenant?: unknown }
  tenantScoped: boolean
  user: MissionControlUser | null
}): boolean => {
  if (!user) return false
  if (isSuperAdmin(user)) return true

  const tenant = tenantIDOf(job.tenant)
  const staff = tenantScoped
    ? tenant !== null && hasTenantRole(user, tenant, JOB_STAFF_ROLES)
    : hasAnyTenantRole(user, JOB_STAFF_ROLES)
  if (staff) return true

  const employer = tenantScoped
    ? tenant !== null && hasTenantRole(user, tenant, JOB_EMPLOYER_ROLES)
    : hasAnyTenantRole(user, JOB_EMPLOYER_ROLES)
  const userOrganisation = getUserOrganisationID(user)
  const jobOrganisation = tenantIDOf(job.organisation)

  return employer && userOrganisation !== null && jobOrganisation !== null && String(userOrganisation) === String(jobOrganisation)
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/** One cell. Quoted when needed; a leading `= + - @` is defused so a spreadsheet never runs an applicant's text. */
export const csvCell = (value: unknown): string => {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const APPLICATION_CSV_COLUMNS = [
  'Applied at',
  'Job',
  'Organisation',
  'Name',
  'Email',
  'Phone',
  'Message',
  'CV link',
  'Cover letter link',
  'Links expire at',
] as const

export const applicationsToCSV = (rows: (readonly unknown[])[]): string =>
  `﻿${[APPLICATION_CSV_COLUMNS as readonly unknown[], ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`

const csvResponse = (csv: string, filename: string) =>
  new Response(csv, {
    headers: {
      'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-type': 'text/csv; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
    status: 200,
  })

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const nameOf = (value: unknown, field: string): string =>
  value && typeof value === 'object' && typeof (value as Doc)[field] === 'string' ? (value as Doc)[field] : ''

type Shaped = {
  applicant: { email: string; name: string; phone: string }
  appliedAt: string
  coverLetter: null | { filename: string; url: string }
  cv: null | { filename: string; url: string }
  id: number | string
  job: { id: number | string | null; title: string }
  message: string
  organisation: string
}

const shape = async (
  req: PayloadRequest,
  application: Doc,
  link: { expiresAt: number; filesSlug: string },
): Promise<Shaped> => {
  const origin = new URL(req.url ?? 'http://localhost').origin
  const fileOf = async (file: unknown) => {
    const id = tenantIDOf(file)
    if (id === null) return null
    const url = await fileLinkURL({ expiresAt: link.expiresAt, fileId: id, filesSlug: link.filesSlug, origin, secret: req.payload.secret })

    return { filename: nameOf(file, 'filename'), url }
  }

  return {
    id: application.id,
    applicant: { email: application.email ?? '', name: application.name ?? '', phone: application.phone ?? '' },
    appliedAt: String(application.createdAt ?? ''),
    coverLetter: await fileOf(application.coverLetter),
    cv: await fileOf(application.cv),
    job: { id: tenantIDOf(application.job), title: nameOf(application.job, 'title') },
    message: application.message ?? '',
    organisation: nameOf(application.organisation, 'name'),
  }
}

const csvRow = (row: Shaped, expiresAt: number) => [
  row.appliedAt,
  row.job.title,
  row.organisation,
  row.applicant.name,
  row.applicant.email,
  row.applicant.phone,
  row.message,
  row.cv?.url ?? '',
  row.coverLetter?.url ?? '',
  new Date(expiresAt * 1000).toISOString(),
]

const linkWindow = (options: ApplicationEndpointOptions, filesSlug: string) => ({
  expiresAt: Math.floor(Date.now() / 1000) + (options.fileLinkTtlSeconds ?? DEFAULT_LINK_TTL_SECONDS),
  filesSlug,
})

const findAll = async (req: PayloadRequest, where: Where): Promise<{ docs: Doc[]; truncated: boolean }> => {
  const docs: Doc[] = []
  for (let page = 1; docs.length < EXPORT_MAX_ROWS; page += 1) {
    const result = await req.payload.find({
      collection: APPLICATIONS_SLUG as CollectionSlug,
      depth: 1,
      limit: PAGE_SIZE,
      overrideAccess: true,
      page,
      sort: 'createdAt',
      where,
    })
    docs.push(...(result.docs as unknown as Doc[]))
    if (!result.hasNextPage) return { docs, truncated: false }
  }

  return { docs: docs.slice(0, EXPORT_MAX_ROWS), truncated: true }
}

/* -------------------------------------------------------------------------- */
/* Per job                                                                     */
/* -------------------------------------------------------------------------- */

/** Loads the job and checks the caller. A job the caller may not read is a 404, like one that does not exist. */
const authorisedJob = async (
  req: PayloadRequest,
  { slugs, tenantScoped }: { slugs: PayloadJobsCollectionSlugs; tenantScoped: boolean },
): Promise<{ job: Doc } | { response: Response }> => {
  const user = userOf(req)
  if (!user) return { response: json({ error: 'unauthorised' }, 401) }

  const id = req.routeParams?.jobId
  const job =
    typeof id === 'string' || typeof id === 'number'
      ? ((await req.payload
          .findByID({ collection: slugs.jobs as CollectionSlug, depth: 0, id, overrideAccess: true })
          .catch(() => null)) as Doc | null)
      : null

  if (!job || !canReadJobApplications({ job, tenantScoped, user })) return { response: json({ error: 'not_found' }, 404) }

  return { job }
}

export const jobApplicationsEndpoint = (options: ApplicationEndpointOptions = {}): Endpoint => {
  const slugs = options.slugs ?? DEFAULT_PAYLOAD_JOBS_SLUGS
  const tenantScoped = options.tenantScoped ?? true

  return {
    handler: async (req) => {
      const checked = await authorisedJob(req, { slugs, tenantScoped })
      if ('response' in checked) return checked.response

      const params = new URL(req.url ?? 'http://localhost').searchParams
      const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1)
      const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(params.get('limit'))) || 25))

      const result = await req.payload.find({
        collection: APPLICATIONS_SLUG as CollectionSlug,
        depth: 1,
        limit,
        overrideAccess: true,
        page,
        sort: '-createdAt',
        where: { job: { equals: checked.job.id } },
      })

      const link = linkWindow(options, APPLICATION_FILES_SLUG)
      const docs = await Promise.all((result.docs as unknown as Doc[]).map((doc) => shape(req, doc, link)))

      return json({
        docs,
        linksExpireAt: new Date(link.expiresAt * 1000).toISOString(),
        page: result.page,
        totalDocs: result.totalDocs,
        totalPages: result.totalPages,
      })
    },
    method: 'get',
    path: APPLICATIONS_FOR_JOB_PATH,
  }
}

export const jobApplicationsCSVEndpoint = (options: ApplicationEndpointOptions = {}): Endpoint => {
  const slugs = options.slugs ?? DEFAULT_PAYLOAD_JOBS_SLUGS
  const tenantScoped = options.tenantScoped ?? true

  return {
    handler: async (req) => {
      const checked = await authorisedJob(req, { slugs, tenantScoped })
      if ('response' in checked) return checked.response

      const { docs, truncated } = await findAll(req, { job: { equals: checked.job.id } })
      if (truncated) return json({ error: 'too_many_rows', max: EXPORT_MAX_ROWS }, 413)

      const link = linkWindow(options, APPLICATION_FILES_SLUG)
      const rows = await Promise.all(docs.map(async (doc) => csvRow(await shape(req, doc, link), link.expiresAt)))

      return csvResponse(applicationsToCSV(rows), `applications-job-${String(checked.job.id).replace(/[^\w-]/g, '')}.csv`)
    },
    method: 'get',
    path: APPLICATIONS_FOR_JOB_CSV_PATH,
  }
}

/* -------------------------------------------------------------------------- */
/* Site managers                                                               */
/* -------------------------------------------------------------------------- */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** `from` is the start of the day; a date-only `to` includes that whole day. UTC. */
export const parseExportRange = (
  from: null | string,
  to: null | string,
): { error: string } | { from: string; to: string } => {
  if (!from || !to) return { error: 'from and to are required (YYYY-MM-DD)' }

  const start = new Date(DATE_ONLY.test(from) ? `${from}T00:00:00.000Z` : from)
  const end = new Date(DATE_ONLY.test(to) ? `${to}T00:00:00.000Z` : to)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { error: 'from and to must be dates' }

  const endExclusive = DATE_ONLY.test(to) ? new Date(end.getTime() + 24 * 60 * 60 * 1000) : end
  if (endExclusive.getTime() <= start.getTime()) return { error: 'to must be after from' }

  return { from: start.toISOString(), to: endExclusive.toISOString() }
}

export const applicationsExportEndpoint = (options: ApplicationEndpointOptions = {}): Endpoint => {
  const tenantScoped = options.tenantScoped ?? true

  return {
    handler: async (req) => {
      const user = userOf(req)
      if (!user) return json({ error: 'unauthorised' }, 401)

      // Site managers only: super admins, and tenant admins / editors for their own tenants.
      const superAdmin = isSuperAdmin(user)
      const staffTenants = getUserTenantIDsByRole(user, JOB_STAFF_ROLES)
      if (!superAdmin && staffTenants.length === 0) return json({ error: 'forbidden' }, 403)

      const params = new URL(req.url ?? 'http://localhost').searchParams
      const range = parseExportRange(params.get('from'), params.get('to'))
      if ('error' in range) return json({ error: range.error }, 400)

      const conditions: Where[] = [{ createdAt: { greater_than_equal: range.from } }, { createdAt: { less_than: range.to } }]
      if (tenantScoped) {
        const requested = params.get('tenant')
        if (requested) {
          if (!superAdmin && !staffTenants.some((id) => String(id) === requested)) return json({ error: 'forbidden' }, 403)
          conditions.push({ tenant: { equals: requested } })
        } else if (!superAdmin) {
          conditions.push({ tenant: { in: staffTenants } })
        }
      }

      const { docs, truncated } = await findAll(req, { and: conditions })
      if (truncated) return json({ error: 'too_many_rows', max: EXPORT_MAX_ROWS }, 413)

      const link = linkWindow(options, APPLICATION_FILES_SLUG)
      const rows = await Promise.all(docs.map(async (doc) => csvRow(await shape(req, doc, link), link.expiresAt)))
      const day = (iso: string) => iso.slice(0, 10)

      return csvResponse(applicationsToCSV(rows), `applications-${day(range.from)}-to-${day(range.to)}.csv`)
    },
    method: 'get',
    path: APPLICATIONS_EXPORT_PATH,
  }
}

export const applicationEndpoints = (options: ApplicationEndpointOptions = {}): Endpoint[] => [
  jobApplicationsEndpoint(options),
  jobApplicationsCSVEndpoint(options),
  applicationsExportEndpoint(options),
]

/** Add the endpoints to the applications collection. */
export const withApplicationEndpoints = (
  collection: CollectionConfig,
  options: ApplicationEndpointOptions = {},
): CollectionConfig => ({
  ...collection,
  endpoints: [...(Array.isArray(collection.endpoints) ? collection.endpoints : []), ...applicationEndpoints(options)],
})
