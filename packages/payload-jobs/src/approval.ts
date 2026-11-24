import type { CollectionAfterChangeHook, CollectionSlug, Endpoint, Payload, PayloadRequest } from 'payload'

import { hasAnyTenantRole, hasTenantRole, isSeekerOnly, isSuperAdmin, type MissionControlUser } from './access'
import { idsOf, tenantIDOf } from './catalog'
import { JOB_LOG_NOTE_CONTEXT, type JobLogNote } from './job-log'
import { JOB_STAFF_ROLES } from './collections/jobs'
import { JOB_SYSTEM_CONTEXT } from './job-status'
import { loadTenantDoc } from './tenant-doc'
import {
  DEFAULT_PUBLICATION_SETTINGS,
  publicationDecisionFor,
  tenantPublicationSettings,
  type PublicationDecision,
  type PublicationPayment,
  type PublicationSettings,
} from './publication'
import { DEFAULT_PAYLOAD_JOBS_SLUGS, type PayloadJobsCollectionSlugs } from './slugs'

/**
 * Applying the publication rule (PJ-32): the Approve action, checkout, and the release that
 * follows a payment. All of it is ordinary hooks and code, not an admin-only button, so the
 * Astro /manage area (PJ-82) can call the same functions later.
 */

export class ApprovalError extends Error {
  readonly code: 'not_found' | 'forbidden' | 'not_awaiting_approval' | 'not_checked_out'
  readonly status: number

  constructor(code: ApprovalError['code'], message: string, status: number) {
    super(message)
    this.name = 'ApprovalError'
    this.code = code
    this.status = status
  }
}

type Doc = Record<string, unknown> & { id: number | string }

/** How a job's order stands for the publication rule. */
export const publicationPaymentOf = ({
  orderStatus,
}: {
  orderStatus?: null | string
}): PublicationPayment => {
  if (!orderStatus) return 'none'
  if (orderStatus === 'paid') return 'paid'
  if (orderStatus === 'cancelled' || orderStatus === 'failed') return 'none'
  return 'invoiced'
}

/**
 * Read what the rule needs for one job: its organisation's trust flag and the tenant's
 * publication settings. Missing rows fall back to the generic defaults, never to a guess about
 * a particular site.
 */
const settingsFor = async ({
  organisationID,
  payload,
  req,
  slugs,
  tenantID,
}: {
  organisationID: null | number | string
  payload: Payload
  req: PayloadRequest
  slugs: PayloadJobsCollectionSlugs
  tenantID: null | number | string
}): Promise<{ organisation: Doc | null; publication: PublicationSettings; trusted: boolean }> => {
  const organisation =
    organisationID === null
      ? null
      : ((await payload.findByID({
          collection: slugs.organisations as CollectionSlug,
          depth: 0,
          disableErrors: true,
          id: organisationID,
          overrideAccess: true,
          req,
        })) as Doc | null)

  const tenant = await loadTenantDoc(req, tenantID)
  return {
    organisation,
    publication: tenant ? tenantPublicationSettings(tenant as never) : { ...DEFAULT_PUBLICATION_SETTINGS },
    trusted: organisation?.trusted === true,
  }
}

/** The decision for a job, from the database as it stands now. */
export const jobPublicationDecision = async ({
  job,
  payload,
  req,
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
}: {
  job: Doc
  payload: Payload
  req: PayloadRequest
  slugs?: PayloadJobsCollectionSlugs
}): Promise<PublicationDecision> => {
  const orderID = idsOf([job.order].flat())[0] ?? null
  const order =
    orderID === null
      ? null
      : ((await payload.findByID({
          collection: slugs.orders as CollectionSlug,
          depth: 0,
          disableErrors: true,
          id: orderID,
          overrideAccess: true,
          req,
          select: { status: true },
        })) as Doc | null)

  const { publication, trusted } = await settingsFor({
    organisationID: tenantIDOf(job.organisation),
    payload,
    req,
    slugs,
    tenantID: tenantIDOf(job.tenant),
  })

  return publicationDecisionFor({
    payment: publicationPaymentOf({ orderStatus: order?.status as null | string }),
    settings: publication,
    trusted,
    waitingForPurchase: job.status === 'waiting_for_purchase' || order?.status === 'waiting_for_purchase',
  })
}

/** Run `fn` with these keys on `req.context`, then put back what was there. */
export const withContextKeys = async <T>(
  req: PayloadRequest,
  keys: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> => {
  const previous = req.context
  req.context = { ...previous, ...keys }
  try {
    return await fn()
  } finally {
    req.context = previous
  }
}

/** Set a job's status, leaving a note in its log. `system` marks it as the rule's doing. */
const setStatus = async ({
  jobID,
  note,
  payload,
  req,
  slugs,
  status,
  system,
}: {
  jobID: number | string
  note: string
  payload: Payload
  req: PayloadRequest
  slugs: PayloadJobsCollectionSlugs
  status: 'published'
  /** The rule decided, not a person: logged as the system. A site manager's approval is not. */
  system: boolean
}): Promise<Doc> =>
  withContextKeys(
    req,
    { [JOB_LOG_NOTE_CONTEXT]: note, ...(system ? { [JOB_SYSTEM_CONTEXT]: true } : {}) } satisfies JobLogNote &
      Record<string, unknown>,
    async () =>
      (await payload.update({
        collection: slugs.jobs as CollectionSlug,
        data: { status } as never,
        depth: 0,
        id: jobID,
        overrideAccess: true,
        req,
      })) as unknown as Doc,
  )

export type ApproveJobArgs = {
  jobId: number | string
  payload: Payload
  req: PayloadRequest
  slugs?: PayloadJobsCollectionSlugs
  tenantID?: null | number | string
  user?: MissionControlUser | null
}

export type ApproveJobResult = {
  /** False when the job was already published: a repeated approval changes nothing. */
  changed: boolean
  /** True when this approval also marked the organisation as trusted. */
  organisationTrusted: boolean
  status: string
}

/**
 * A site manager approves a job: it publishes, and (when the tenant's `trustOnApproval` is on,
 * which is off by default, and a tenant admin approves) its organisation becomes trusted.
 *
 * Staff of the job's own tenant only; anyone else gets `not_found`, so a stranger cannot learn
 * which ids exist. A job that is already published is left alone, so repeating is safe.
 */
export const approveJob = async ({
  jobId,
  payload,
  req,
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  tenantID,
  user,
}: ApproveJobArgs): Promise<ApproveJobResult> => {
  const actor = user === undefined ? ((req.user as MissionControlUser | null) ?? null) : user
  const job = (await payload.findByID({
    collection: slugs.jobs as CollectionSlug,
    depth: 0,
    disableErrors: true,
    id: jobId,
    overrideAccess: true,
    req,
  })) as Doc | null

  const jobTenant = tenantIDOf(job?.tenant)
  if (!job || (tenantID !== undefined && tenantID !== null && String(jobTenant) !== String(tenantID))) {
    throw new ApprovalError('not_found', 'Job not found', 404)
  }
  if (!actor || isSeekerOnly(actor)) throw new ApprovalError('not_found', 'Job not found', 404)

  const allowed =
    isSuperAdmin(actor) ||
    (jobTenant !== null
      ? hasTenantRole(actor, jobTenant, JOB_STAFF_ROLES)
      : hasAnyTenantRole(actor, JOB_STAFF_ROLES))
  if (!allowed) throw new ApprovalError('not_found', 'Job not found', 404)

  if (job.status === 'published') {
    return { changed: false, organisationTrusted: false, status: 'published' }
  }
  if (job.status !== 'pending') {
    throw new ApprovalError(
      'not_awaiting_approval',
      `A ${String(job.status)} job is not waiting for approval`,
      409,
    )
  }

  // Only a job that went through checkout may be approved: it has a plan and a live order in
  // this tenant. Otherwise Approve would publish it with no order, no credit and no expiry.
  const orderID = idsOf([job.order].flat())[0] ?? null
  const order =
    orderID === null
      ? null
      : ((await payload.findByID({
          collection: slugs.orders as CollectionSlug,
          depth: 0,
          disableErrors: true,
          id: orderID,
          overrideAccess: true,
          req,
          select: { status: true, tenant: true },
        })) as Doc | null)
  const orderTenant = tenantIDOf(order?.tenant)
  const checkedOut =
    order !== null &&
    tenantIDOf(job.plan) !== null &&
    !['cancelled', 'failed', 'waiting_for_purchase'].includes(String(order.status)) &&
    (jobTenant === null || orderTenant === null || String(orderTenant) === String(jobTenant))
  if (!checkedOut) {
    throw new ApprovalError('not_checked_out', 'This job has not been through checkout, so it cannot be approved', 409)
  }

  const { publication, trusted, organisation } = await settingsFor({
    organisationID: tenantIDOf(job.organisation),
    payload,
    req,
    slugs,
    tenantID: jobTenant,
  })

  const updated = await setStatus({
    jobID: job.id,
    note: 'Approved by a site manager',
    payload,
    req,
    slugs,
    status: 'published',
    system: false,
  })

  // Trusting an organisation lets its jobs publish before payment, so only a tenant admin (or
  // a super admin) may do it, never an editor.
  const canTrust = isSuperAdmin(actor) || (jobTenant !== null && hasTenantRole(actor, jobTenant, ['tenant-admin']))
  let organisationTrusted = false
  if (publication.trustOnApproval && canTrust && !trusted && organisation) {
    await payload.update({
      collection: slugs.organisations as CollectionSlug,
      data: { trusted: true } as never,
      depth: 0,
      id: organisation.id,
      overrideAccess: true,
      req,
    })
    organisationTrusted = true
  }

  return { changed: true, organisationTrusted, status: String(updated.status ?? 'published') }
}

/**
 * Release the jobs an order pays for once the rule lets them go live (a paid invoice, an
 * approval, an immediate publish). System code calls this from checkout and from the order
 * hooks; a job the rule still holds stays `pending`, which is not an error.
 */
export const applyPublicationForOrder = async ({
  orderID,
  payload,
  req,
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
}: {
  orderID: number | string
  payload: Payload
  req: PayloadRequest
  slugs?: PayloadJobsCollectionSlugs
}): Promise<{ published: (number | string)[] }> => {
  const order = (await payload.findByID({
    collection: slugs.orders as CollectionSlug,
    depth: 0,
    disableErrors: true,
    id: orderID,
    overrideAccess: true,
    req,
    select: { jobs: true, status: true },
  })) as Doc | null

  const published: (number | string)[] = []
  for (const jobID of idsOf([order?.jobs].flat())) {
    const job = (await payload.findByID({
      collection: slugs.jobs as CollectionSlug,
      depth: 0,
      disableErrors: true,
      id: jobID,
      overrideAccess: true,
      req,
    })) as Doc | null

    if (!job || (job.status !== 'pending' && job.status !== 'waiting_for_purchase')) continue
    if (String(tenantIDOf(job.order)) !== String(orderID)) continue

    const decision = await jobPublicationDecision({ job, payload, req, slugs })
    if (decision !== 'published') continue

    await setStatus({
      jobID: job.id,
      note: 'Published when its order was settled',
      payload,
      req,
      slugs,
      status: 'published',
      system: true,
    })
    published.push(job.id)
  }

  return { published }
}

/**
 * Order hook: once an order is invoiced or paid, release the jobs it pays for as far as the
 * rule allows. Runs inside the order's own transaction, so checkout, a purchase approval, the
 * Xero payment sync and "mark paid" all go through the one rule.
 */
export const releaseJobsOnSettle = (
  slugs: PayloadJobsCollectionSlugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
): CollectionAfterChangeHook =>
  async function releaseJobsOnSettleHook({ doc, operation, previousDoc, req }) {
    const status = (doc as { status?: string }).status
    if (status !== 'invoiced' && status !== 'paid') return doc
    if (operation === 'update' && (previousDoc as { status?: string } | undefined)?.status === status) return doc
    await applyPublicationForOrder({ orderID: (doc as Doc).id, payload: req.payload, req, slugs })
    return doc
  }

/** `POST /api/<jobs>/:id/approve` for the admin button and any later client. */
export const approveJobEndpoint = ({
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  tenantScoped = true,
}: {
  slugs?: PayloadJobsCollectionSlugs
  tenantScoped?: boolean
} = {}): Endpoint => ({
  handler: async (req) => {
    const id = req.routeParams?.id
    if (typeof id !== 'string' && typeof id !== 'number') {
      return Response.json({ error: { code: 'invalid_request', message: 'Job id is required' } }, { status: 400 })
    }

    try {
      const result = await approveJob({
        jobId: id,
        payload: req.payload,
        req,
        slugs,
        ...(tenantScoped ? {} : { tenantID: null }),
      })
      return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
    } catch (error) {
      if (error instanceof ApprovalError) {
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
      }
      req.payload.logger.error({ err: error, msg: 'approve job failed' })
      return Response.json({ error: { code: 'server_error', message: 'Something went wrong.' } }, { status: 500 })
    }
  },
  method: 'post',
  path: '/:id/approve',
})
