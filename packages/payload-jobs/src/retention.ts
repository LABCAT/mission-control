import type {
  CollectionConfig,
  CollectionSlug,
  Endpoint,
  Field,
  GlobalSlug,
  PayloadRequest,
  TaskConfig,
  TaskSlug,
  Where,
} from 'payload'

import { tenantIDOf } from './catalog'
import { APPLICATION_FILES_SLUG, APPLICATIONS_SLUG } from './collections/applications'


/**
 * Application retention (PJ-88, Decision 18): applications and their CV files stay in the
 * employer dashboard for N months after the job closes, then a daily job deletes the records
 * and their stored files. The period is a per-tenant setting whose default is the legacy
 * behaviour: 12 months.
 *
 * The close date is not a field of its own. The status rules already stamp `expiresAt` with the
 * moment a job ends, including an early close (`datesForTransition`), and a cancelled job can
 * never change again, so `updatedAt` is when it closed. See `jobClosedAt`.
 */

export const DELETE_APPLICATIONS_TASK = 'delete-expired-applications'
export const APPLICATION_DATA_COMPONENT_PATH =
  '@mission-control/payload-jobs/rsc#DeleteApplicantData'

/** The legacy period, and the default for a tenant that has not chosen one. */
export const DEFAULT_APPLICATION_RETENTION_MONTHS = 12

export type RetentionSource = {
  retention?: { applicationsMonths?: null | number } | null
}

/**
 * A tenant's application retention in months. A missing or malformed value falls back to the
 * default rather than deleting data early: a bad setting must never shorten the period.
 */
export const applicationRetentionMonths = (
  source: null | RetentionSource | undefined,
): number => {
  const months = source?.retention?.applicationsMonths
  return typeof months === 'number' && Number.isSafeInteger(months) && months >= 1
    ? months
    : DEFAULT_APPLICATION_RETENTION_MONTHS
}

/** The retention group on the tenants collection and the single-tenant settings global. */
export const tenantRetentionField = (condition?: (data: Record<string, unknown>) => boolean): Field => ({
  name: 'retention',
  type: 'group',
  admin: {
    ...(condition ? { condition } : {}),
    description:
      'How long personal data is kept after a job closes. Applications and their CV files are deleted by the daily job once this period has passed.',
  },
  fields: [
    {
      name: 'applicationsMonths',
      type: 'number',
      defaultValue: DEFAULT_APPLICATION_RETENTION_MONTHS,
      min: 1,
      admin: {
        description:
          'Months to keep applications and their CV files after the job closes. Default 12, as the old site did.',
        step: 1,
      },
      validate: (value: null | number | undefined): string | true => {
        if (value === null || value === undefined) return true
        if (!Number.isSafeInteger(value)) return 'Use a whole number of months'
        return value >= 1 ? true : 'Keep applications for at least one month'
      },
    },
  ],
})

/**
 * A date `months` calendar months later (or earlier, when negative), in UTC. A day that does
 * not exist in the target month moves back to that month's last day, so 31 January + 1 month
 * is 28 (or 29) February and the retention never runs short by a few days.
 */
export const addMonths = (date: Date, months: number): Date => {
  const result = new Date(date.getTime())
  const day = result.getUTCDate()

  result.setUTCDate(1)
  result.setUTCMonth(result.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()
  result.setUTCDate(Math.min(day, lastDay))

  return result
}

/** The oldest close date still kept: a job that closed at or before this is due for deletion. */
export const retentionCutoff = (months: number, now: Date): Date => addMonths(now, -months)

/** The part of a job the retention rule reads. */
export type ClosableJob = {
  expiresAt?: null | string
  status?: null | string
  updatedAt?: null | string
}

const timeOf = (value: null | string | undefined): null | number => {
  if (typeof value !== 'string' || value === '') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/**
 * When a job closed, or `null` while it is still live. Only an ended job starts the clock:
 * an expired job closed at `expiresAt` (stamped when it expired early), or at its last change
 * when it never had one; a cancelled job can never be edited again, so it closed at `updatedAt`.
 */
export const jobClosedAt = (job: null | ClosableJob | undefined): Date | null => {
  if (!job) return null

  if (job.status === 'expired') {
    const expires = timeOf(job.expiresAt)
    if (expires !== null) return new Date(expires)
  } else if (job.status !== 'cancelled') {
    return null
  }

  const changed = timeOf(job.updatedAt)
  return changed === null ? null : new Date(changed)
}

/** True when a job's applications are past their retention and may be deleted. */
export const isApplicationRetentionDue = (
  job: null | ClosableJob | undefined,
  months: number,
  now: Date,
): boolean => {
  const closedAt = jobClosedAt(job)
  return closedAt !== null && closedAt.getTime() <= retentionCutoff(months, now).getTime()
}

/**
 * The ended jobs that closed at or before `cutoff`. An expired job without `expiresAt` closed
 * when it last changed; a cancelled job always closed when it was cancelled.
 */
export const closedJobsWhere = ({
  afterID = null,
  cutoff,
  tenantID = null,
}: {
  afterID?: number | string | null
  cutoff: Date
  tenantID?: null | number | string
}): Where => {
  const at = cutoff.toISOString()

  return {
    and: [
      ...(tenantID === null ? [] : [{ tenant: { equals: tenantID } }]),
      {
        or: [
          {
            and: [
              { status: { equals: 'expired' } },
              {
                or: [
                  { expiresAt: { less_than_equal: at } },
                  { and: [{ expiresAt: { exists: false } }, { updatedAt: { less_than_equal: at } }] },
                ],
              },
            ],
          },
          { and: [{ status: { equals: 'cancelled' } }, { updatedAt: { less_than_equal: at } }] },
        ],
      },
      ...(afterID === null ? [] : [{ id: { greater_than: afterID } }]),
    ],
  }
}

type ApplicationDoc = {
  coverLetter?: unknown
  cv?: unknown
  id: number | string
}

/** The CV and cover-letter ids, once each: an application may use one file for both. */
const fileIDsOf = (application: ApplicationDoc): (number | string)[] => {
  const byID = new Map<string, number | string>()

  for (const value of [application.cv, application.coverLetter]) {
    const id = tenantIDOf(value)
    if (id !== null) byID.set(String(id), id)
  }

  return [...byID.values()]
}

export type DeleteApplicationDataArgs = {
  application: ApplicationDoc
  applicationsSlug?: string
  filesSlug?: string
  /**
   * Skip access control. The daily job runs as the system (true); the admin action passes false
   * so that deleting is limited to who may delete an application, not merely who may read it.
   */
  overrideAccess?: boolean
  req: PayloadRequest
}

/**
 * Delete one application and the CV and cover-letter files no other application still points
 * at. The file documents are what the host's storage adapter deletes the R2 objects for, so
 * this removes the bytes too.
 *
 * Safe to repeat: a missing file is not an error, and a file another application still uses is
 * left in place.
 */
export const deleteApplicationData = async ({
  application,
  applicationsSlug = APPLICATIONS_SLUG,
  filesSlug = APPLICATION_FILES_SLUG,
  overrideAccess = true,
  req,
}: DeleteApplicationDataArgs): Promise<{ filesDeleted: number }> => {
  const fileIDs = fileIDsOf(application)

  await req.payload.delete({
    collection: applicationsSlug as CollectionSlug,
    id: application.id,
    overrideAccess,
    req,
  })

  let filesDeleted = 0
  for (const fileID of fileIDs) {
    const { totalDocs } = await req.payload.count({
      collection: applicationsSlug as CollectionSlug,
      overrideAccess: true,
      req,
      where: {
        or: [{ cv: { equals: fileID } }, { coverLetter: { equals: fileID } }],
      },
    })
    if (totalDocs > 0) continue

    try {
      await req.payload.delete({
        collection: filesSlug as CollectionSlug,
        id: fileID,
        overrideAccess,
        req,
      })
      filesDeleted += 1
    } catch (error) {
      // Already gone (a repeated run) is the answer we wanted; anything else is a real fault.
      if ((error as { status?: number }).status !== 404) throw error
    }
  }

  return { filesDeleted }
}

type RetentionScope = { months: number; tenantID: null | number | string }

const retentionScopes = async ({
  settingsSlug,
  tenancy,
  tenantsSlug,
  req,
}: {
  req: PayloadRequest
  settingsSlug: string
  tenancy: 'multi' | 'single'
  tenantsSlug: string
}): Promise<RetentionScope[]> => {
  if (tenancy !== 'multi') {
    const settings = await req.payload.findGlobal({
      depth: 0,
      overrideAccess: true,
      req,
      slug: settingsSlug as GlobalSlug,
    })
    return [{ months: applicationRetentionMonths(settings as RetentionSource), tenantID: null }]
  }

  const { docs } = await req.payload.find({
    collection: tenantsSlug as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    select: { retention: true },
  })

  return docs.map((tenant) => ({
    months: applicationRetentionMonths(tenant as RetentionSource),
    tenantID: tenant.id,
  }))
}

export type DeleteApplicationsTaskOptions = {
  applicationsSlug?: string
  /** How many jobs, applications or files to handle per query. */
  batchSize?: number
  /** 6-field cron (seconds first). Default: 03:30 UTC daily. */
  cron?: string
  filesSlug?: string
  jobsSlug?: string
  /** Queue the Worker's cron runs (see apps/cms runScheduled). Default: `hourly`. */
  queue?: string
  settingsSlug?: string
  tenancy?: 'multi' | 'single'
  tenantsSlug?: string
  /** The clock, for tests. Default: the real one. */
  clock?: () => Date
}

/**
 * The daily retention job. For each tenant it finds the ended jobs that closed longer ago than
 * that tenant's retention, deletes their applications and then the CV files nothing points at
 * any more. It also removes files left behind by an interrupted earlier run.
 *
 * Batch-safe and idempotent: it walks by ascending id so a large backlog is cleared over
 * several queries, and a second run over the same data finds nothing to do. It runs on the
 * Payload jobs runner (PJ-08) with `overrideAccess`, because a cron tick has no user.
 */
export const deleteExpiredApplicationsTask = ({
  applicationsSlug = APPLICATIONS_SLUG,
  batchSize = 100,
  clock = () => new Date(),
  cron = '0 30 3 * * *',
  filesSlug = APPLICATION_FILES_SLUG,
  jobsSlug = 'jobs',
  queue = 'hourly',
  settingsSlug = 'job-board-settings',
  tenancy = 'multi',
  tenantsSlug = 'tenants',
}: DeleteApplicationsTaskOptions = {}): TaskConfig => ({
  // Generic here: the host's generated types only know the slug once the task is registered.
  slug: DELETE_APPLICATIONS_TASK as TaskSlug,
  outputSchema: [
    { name: 'applicationsDeleted', type: 'number' },
    { name: 'filesDeleted', type: 'number' },
  ],
  schedule: [{ cron, queue }],
  handler: async ({ req }) => {
    const now = clock()
    let applicationsDeleted = 0
    let filesDeleted = 0

    const scopes = await retentionScopes({ req, settingsSlug, tenancy, tenantsSlug })

    for (const scope of scopes) {
      const cutoff = retentionCutoff(scope.months, now)
      let afterJobID: number | string | null = null

      for (;;) {
        const { docs: jobs } = await req.payload.find({
          collection: jobsSlug as CollectionSlug,
          depth: 0,
          limit: batchSize,
          overrideAccess: true,
          pagination: false,
          req,
          sort: 'id',
          where: closedJobsWhere({ afterID: afterJobID, cutoff, tenantID: scope.tenantID }),
        })
        if (jobs.length === 0) break

        for (const job of jobs) {
          let afterApplicationID: number | string | null = null

          for (;;) {
            const { docs: applications } = await req.payload.find({
              collection: applicationsSlug as CollectionSlug,
              depth: 0,
              limit: batchSize,
              overrideAccess: true,
              pagination: false,
              req,
              sort: 'id',
              where: {
                and: [
                  { job: { equals: job.id } },
                  ...(afterApplicationID === null ? [] : [{ id: { greater_than: afterApplicationID } }]),
                ],
              },
            })
            if (applications.length === 0) break

            for (const application of applications) {
              const result = await deleteApplicationData({
                application: application as unknown as ApplicationDoc,
                applicationsSlug,
                filesSlug,
                req,
              })
              applicationsDeleted += 1
              filesDeleted += result.filesDeleted
            }

            afterApplicationID = applications[applications.length - 1].id as number | string
            if (applications.length < batchSize) break
          }
        }

        afterJobID = jobs[jobs.length - 1].id as number | string
        if (jobs.length < batchSize) break
      }

      filesDeleted += await removeOrphanFiles({
        batchSize,
        cutoff,
        filesSlug,
        applicationsSlug,
        req,
        tenantID: scope.tenantID,
      })
    }

    return { output: { applicationsDeleted, filesDeleted } }
  },
})

/**
 * CV files older than the cutoff that no application points at: an applicant who uploaded a CV
 * and never sent it, or a run interrupted between deleting the record and its file. Only files
 * whose `createdAt` is past the cutoff are touched, so a CV uploaded for a live job is safe.
 */
const removeOrphanFiles = async ({
  applicationsSlug,
  batchSize,
  cutoff,
  filesSlug,
  req,
  tenantID,
}: {
  applicationsSlug: string
  batchSize: number
  cutoff: Date
  filesSlug: string
  req: PayloadRequest
  tenantID: null | number | string
}): Promise<number> => {
  let afterID: number | string | null = null
  let removed = 0

  for (;;) {
    const { docs: files } = await req.payload.find({
      collection: filesSlug as CollectionSlug,
      depth: 0,
      limit: batchSize,
      overrideAccess: true,
      pagination: false,
      req,
      sort: 'id',
      where: {
        and: [
          ...(tenantID === null ? [] : [{ tenant: { equals: tenantID } }]),
          { createdAt: { less_than_equal: cutoff.toISOString() } },
          ...(afterID === null ? [] : [{ id: { greater_than: afterID } }]),
        ],
      },
    })
    if (files.length === 0) break

    for (const file of files) {
      const { totalDocs } = await req.payload.count({
        collection: applicationsSlug as CollectionSlug,
        overrideAccess: true,
        req,
        where: { or: [{ cv: { equals: file.id } }, { coverLetter: { equals: file.id } }] },
      })
      if (totalDocs > 0) continue

      try {
        await req.payload.delete({
          collection: filesSlug as CollectionSlug,
          id: file.id,
          overrideAccess: true,
          req,
        })
        removed += 1
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error
      }
    }

    afterID = files[files.length - 1].id as number | string
    if (files.length < batchSize) break
  }

  return removed
}

export type ApplicationDataEndpointOptions = {
  applicationsSlug?: string
  filesSlug?: string
}

/**
 * Add the "Delete applicant data" action (PJ-88) to the applications collection: the endpoint
 * the form posts to, and the button on the edit view.
 */
export const withApplicationDataAction = (
  collection: CollectionConfig,
  { applicationsSlug = APPLICATIONS_SLUG, filesSlug = APPLICATION_FILES_SLUG }: ApplicationDataEndpointOptions = {},
): CollectionConfig => {
  const existing = collection.admin?.components?.edit?.beforeDocumentControls
  const before = Array.isArray(existing) ? existing : existing ? [existing] : []

  return {
    ...collection,
    endpoints: [
      ...(Array.isArray(collection.endpoints) ? collection.endpoints : []),
      ...applicationDataEndpoints({ applicationsSlug, filesSlug }),
    ],
    admin: {
      ...collection.admin,
      components: {
        ...collection.admin?.components,
        edit: {
          ...collection.admin?.components?.edit,
          beforeDocumentControls: [
            ...before,
            { path: APPLICATION_DATA_COMPONENT_PATH, serverProps: { applicationsSlug } },
          ],
        },
      },
    },
  }
}

/**
 * `POST /api/applications/:id/delete-data`: the admin's "Delete applicant data" action. It
 * removes the application and its CV and cover-letter files, with the same access as deleting
 * an application (super admins and the tenant's admins).
 *
 * The admin renders it as a plain form, so a successful delete answers with a redirect back to
 * the list. `?format=json` answers with the counts instead, for tools and tests.
 */
export const applicationDataEndpoints = ({
  applicationsSlug = APPLICATIONS_SLUG,
  filesSlug = APPLICATION_FILES_SLUG,
}: ApplicationDataEndpointOptions = {}): Endpoint[] => [
  {
    handler: async (req) => {
      const id = req.routeParams?.id
      if (typeof id !== 'string' || id === '') {
        return Response.json({ error: 'No such application.' }, { status: 400 })
      }

      // Read and delete with the caller's own access: the endpoint grants nothing extra.
      const application = await req.payload.findByID({
        collection: applicationsSlug as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id,
        overrideAccess: false,
        req,
      })
      if (!application) {
        return Response.json({ error: 'No such application.' }, { status: 404 })
      }

      let filesDeleted = 0
      try {
        ;({ filesDeleted } = await deleteApplicationData({
          application: application as unknown as ApplicationDoc,
          applicationsSlug,
          filesSlug,
          overrideAccess: false,
          req,
        }))
      } catch (error) {
        const status = (error as { status?: number }).status
        if (status === 403) {
          return Response.json({ error: 'You may not delete this application.' }, { status: 403 })
        }
        throw error
      }

      if (req.query?.format === 'json') {
        return Response.json({ deleted: true, filesDeleted })
      }

      const listURL = `${req.payload.config.routes.admin}/collections/${applicationsSlug}`
      return new Response(null, { headers: { location: listURL }, status: 303 })
    },
    method: 'post',
    path: '/:id/delete-data',
  },
]
