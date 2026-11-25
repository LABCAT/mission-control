import type { CollectionSlug, Endpoint, Payload, PayloadRequest } from 'payload'

import { hasAnyTenantRole, hasTenantRole, isSeekerOnly, isSuperAdmin, type MissionControlUser } from './access'
import { tenantIDOf } from './catalog'
import { JOB_STAFF_ROLES } from './collections/jobs'
import { withContextKeys } from './approval'
import { getUserOrganisationID } from './access'
import { JOB_LOG_ACTION_CONTEXT, JOB_LOG_NOTE_CONTEXT } from './job-log'
import { JOB_END_EARLY_CONTEXT, type JobStatus } from './job-status'
import { DEFAULT_PAYLOAD_JOBS_SLUGS, type PayloadJobsCollectionSlugs } from './slugs'

export type JobActionErrorCode = 'not_found' | 'invalid_status'

export class JobActionError extends Error {
  readonly code: JobActionErrorCode
  readonly status: number

  constructor(code: JobActionErrorCode, message: string, status: number) {
    super(message)
    this.name = 'JobActionError'
    this.code = code
    this.status = status
  }
}

type ID = number | string
type Doc = Record<string, unknown> & { id: ID }

type JobActionArgs = {
  jobId: ID
  payload: Payload
  req: PayloadRequest
  slugs?: PayloadJobsCollectionSlugs
  tenantScoped?: boolean
  tenantsSlug?: string
  user?: MissionControlUser | null
}

const jobOf = async (args: JobActionArgs): Promise<{ actor: MissionControlUser; job: Doc }> => {
  const actor = args.user === undefined ? ((args.req.user as MissionControlUser | null) ?? null) : args.user
  const slugs = args.slugs ?? DEFAULT_PAYLOAD_JOBS_SLUGS
  const job = (await args.payload.findByID({
    collection: slugs.jobs as CollectionSlug,
    depth: 0,
    disableErrors: true,
    id: args.jobId,
    overrideAccess: true,
    req: args.req,
  })) as Doc | null
  const tenantID = tenantIDOf(job?.tenant)
  const scoped = args.tenantScoped ?? true
  const allowed = actor && !isSeekerOnly(actor) && (
    isSuperAdmin(actor) ||
    (scoped
      ? tenantID !== null && hasTenantRole(actor, tenantID, JOB_STAFF_ROLES)
      : hasAnyTenantRole(actor, JOB_STAFF_ROLES)) ||
    (tenantIDOf(actor.organisation) !== null &&
      String(tenantIDOf(actor.organisation)) === String(tenantIDOf(job?.organisation)) &&
      (scoped
        ? tenantID !== null && hasTenantRole(actor, tenantID, ['employer'])
        : hasAnyTenantRole(actor, ['employer'])))
  )
  if (!job || !allowed) throw new JobActionError('not_found', 'Job not found', 404)
  return { actor: actor as MissionControlUser, job }
}

const updateStatus = async ({
  args,
  from,
  note,
  status,
}: {
  args: JobActionArgs
  from: readonly JobStatus[]
  note: string
  status: JobStatus
}): Promise<{ changed: boolean; job: Doc }> => {
  const { job } = await jobOf(args)
  if (!from.includes(job.status as JobStatus)) {
    throw new JobActionError('invalid_status', `A ${String(job.status)} job cannot be ${note.toLowerCase()}`, 409)
  }
  const updated = (await withContextKeys(
    args.req,
    { [JOB_LOG_NOTE_CONTEXT]: note, ...(status === 'expired' ? { [JOB_END_EARLY_CONTEXT]: true } : {}) },
    () => args.payload.update({
      collection: (args.slugs ?? DEFAULT_PAYLOAD_JOBS_SLUGS).jobs as CollectionSlug,
      data: { status } as never,
      depth: 0,
      id: job.id,
      overrideAccess: true,
      req: args.req,
    }),
  )) as unknown as Doc
  return { changed: true, job: updated }
}

/** End a live listing without refunding its credit. The expired lifecycle hook is the cache invalidation point. */
export const endJobEarly = (args: JobActionArgs): Promise<{ changed: boolean; job: Doc }> =>
  updateStatus({ args, from: ['published'], note: 'Ended early by employer', status: 'expired' })

/** Cancel a listing that has not gone live. The job hook refunds any consumed credit once. */
export const cancelJob = (args: JobActionArgs): Promise<{ changed: boolean; job: Doc }> =>
  updateStatus({
    args,
    from: ['draft', 'pending', 'waiting_for_purchase'],
    note: 'Cancelled before publication',
    status: 'cancelled',
  })

const RELIST_FIELDS = [
  'applicationsRecipient',
  'applyOnline',
  'categories',
  'companyName',
  'companyUrl',
  'description',
  'displayedSalary',
  'howToApply',
  'jobDescriptionPdf',
  'jobType',
  'location',
  'locationDetails',
  'organisation',
  'plan',
  'salaryBand',
  'tenant',
  'title',
] as const

/** Duplicate an expired listing as a draft and return the tenant's standard checkout endpoint. */
export const relistJob = async (args: JobActionArgs): Promise<{ checkoutInput: { jobId: ID; planId: ID }; checkoutUrl: string; job: Doc }> => {
  const { actor, job } = await jobOf(args)
  if (getUserOrganisationID(actor) !== null && String(getUserOrganisationID(actor)) !== String(tenantIDOf(job.organisation))) {
    throw new JobActionError('not_found', 'Job not found', 404)
  }
  if (job.status !== 'expired') throw new JobActionError('invalid_status', 'Only an expired job can be relisted', 409)

  const slugs = args.slugs ?? DEFAULT_PAYLOAD_JOBS_SLUGS
  const tenantID = tenantIDOf(job.tenant)
  const organisationID = tenantIDOf(job.organisation)
  const planID = tenantIDOf(job.plan)
  if (organisationID === null || planID === null) {
    throw new JobActionError('invalid_status', 'This job has no organisation or plan to relist', 409)
  }

  const tenant = tenantID === null
    ? null
    : ((await args.payload.findByID({
        collection: (args.tenantsSlug ?? 'tenants') as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id: tenantID,
        overrideAccess: true,
        req: args.req,
        select: { slug: true },
      })) as null | { slug?: string })
  if (!tenant?.slug && (args.tenantScoped ?? true)) {
    throw new JobActionError('invalid_status', 'The job tenant cannot be resolved for checkout', 409)
  }

  const data: Record<string, unknown> = { status: 'draft' }
  for (const field of RELIST_FIELDS) {
    if (job[field] !== undefined && job[field] !== null) data[field] = job[field]
  }
  const duplicate = (await withContextKeys(
    args.req,
    { [JOB_LOG_NOTE_CONTEXT]: `Relisted from job ${String(job.id)}` },
    () => args.payload.create({
      collection: slugs.jobs as CollectionSlug,
      data: data as never,
      depth: 0,
      overrideAccess: true,
      req: args.req,
    }),
  )) as unknown as Doc
  await withContextKeys(args.req, { [JOB_LOG_ACTION_CONTEXT]: 'relisted', [JOB_LOG_NOTE_CONTEXT]: `Relisted as job ${String(duplicate.id)}` }, () =>
    args.payload.update({
      collection: slugs.jobs as CollectionSlug,
      data: { status: job.status } as never,
      depth: 0,
      id: job.id,
      overrideAccess: true,
      req: args.req,
    }),
  )
  const checkoutUrl = (args.tenantScoped ?? true)
    ? `/api/${args.tenantsSlug ?? 'tenants'}/${encodeURIComponent(String(tenant!.slug))}/account/checkout`
    : `/api/${slugs.jobs}/:id/checkout`
  return { checkoutInput: { jobId: duplicate.id, planId: planID }, checkoutUrl, job: duplicate }
}

export const jobActionEndpoints = ({
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  tenantScoped = true,
  tenantsSlug = 'tenants',
}: {
  slugs?: PayloadJobsCollectionSlugs
  tenantScoped?: boolean
  tenantsSlug?: string
} = {}): Endpoint[] => {
  const endpoint = (action: 'cancel' | 'end-early' | 'relist'): Endpoint => ({
    handler: async (req) => {
      const id = req.routeParams?.id
      if ((typeof id !== 'string' && typeof id !== 'number') || !String(id)) {
        return Response.json({ error: { code: 'invalid_request', message: 'Job id is required' } }, { status: 400 })
      }
      const args = { jobId: id, payload: req.payload, req, slugs, tenantScoped, tenantsSlug }
      try {
        const result = action === 'cancel'
          ? await cancelJob(args)
          : action === 'end-early'
            ? await endJobEarly(args)
            : await relistJob(args)
        return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
      } catch (error) {
        if (error instanceof JobActionError) {
          return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
        }
        req.payload.logger.error({ err: error, msg: `${action} job failed` })
        return Response.json({ error: { code: 'server_error', message: 'Something went wrong.' } }, { status: 500 })
      }
    },
    method: 'post',
    path: `/:id/${action}`,
  })
  return [endpoint('end-early'), endpoint('cancel'), endpoint('relist')]
}
