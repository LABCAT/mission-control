import type { CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import type { PayloadJobsRegistry, ReportDefinition, ReportRunArgs } from '@mission-control/payload-jobs'

import { isValidTimeZone, monthOf, resolveRange } from './range'

/** The key tenants list in their `addOns` setting. */
export const REPORTS_ADD_ON_KEY = 'reports'
export const JOBS_ORDERS_REPORT_KEY = 'jobs-orders-by-month'
export const JOB_VIEWS_REPORT_KEY = 'job-views'

const PAGE = 500
const IN_CHUNK = 200

type Doc = Record<string, any>

const idOf = (value: unknown): null | number | string =>
  value && typeof value === 'object'
    ? idOf((value as { id?: unknown }).id)
    : typeof value === 'number' || typeof value === 'string'
      ? value
      : null

/** Every matching document, page by page (reports are not capped at one page). */
const findAll = async (
  payload: Payload,
  req: PayloadRequest | undefined,
  collection: string,
  where: Where,
  sort: string,
): Promise<Doc[]> => {
  const docs: Doc[] = []

  for (let page = 1; ; page++) {
    const result = await payload.find({
      collection: collection as CollectionSlug,
      depth: 0,
      limit: PAGE,
      overrideAccess: true,
      page,
      req,
      sort,
      where,
    })
    docs.push(...(result.docs as Doc[]))
    if (!result.hasNextPage) return docs
  }
}

/** The tenant's own timezone (reports bucket and bound by it); UTC when unset or invalid. */
const tenantTimeZone = async (
  registry: PayloadJobsRegistry,
  { payload, req, tenantID }: ReportRunArgs,
): Promise<string> => {
  const { settingsSlug, tenancy, tenantsSlug } = registry.context
  const settings: Doc | null =
    tenancy === 'single'
      ? ((await payload.findGlobal({ depth: 0, overrideAccess: true, req, slug: settingsSlug as never })) as Doc)
      : tenantID === null
        ? null
        : ((await payload.findByID({
            collection: tenantsSlug as CollectionSlug,
            depth: 0,
            id: tenantID,
            overrideAccess: true,
            req,
          })) as Doc)

  return isValidTimeZone(settings?.timezone) ? settings!.timezone : 'UTC'
}

/** `where` for the tenant's documents created in the range. The tenant clause is never optional in multi mode. */
const scopedWhere = (
  registry: PayloadJobsRegistry,
  { tenantID }: ReportRunArgs,
  range: { end?: string; start?: string },
): Where => {
  const and: Where[] = []

  if (registry.context.tenancy === 'multi') {
    if (tenantID === null) throw new Error('payload-jobs-reports: a tenant is required')
    and.push({ tenant: { equals: tenantID } })
  }
  if (range.start) and.push({ createdAt: { greater_than_equal: range.start } })
  if (range.end) and.push({ createdAt: { less_than: range.end } })

  return { and }
}

const organisationNames = async (
  registry: PayloadJobsRegistry,
  args: ReportRunArgs,
  ids: (number | string)[],
): Promise<Map<string, string>> => {
  const names = new Map<string, string>()

  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const docs = await findAll(
      args.payload,
      args.req,
      registry.context.slugs.organisations,
      { id: { in: ids.slice(i, i + IN_CHUNK) } },
      'id',
    )
    for (const doc of docs) names.set(String(doc.id), String(doc.name ?? ''))
  }

  return names
}

const project = (fields: string[], definition: ReportDefinition['fields'], rows: Record<string, unknown>[]) => {
  const keys = definition.map((field) => field.key).filter((key) => fields.includes(key))
  return { columns: keys, rows: rows.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]]))) }
}

export const JOBS_ORDERS_FIELDS: ReportDefinition['fields'] = [
  { default: true, key: 'month', label: 'Month' },
  { default: true, key: 'jobId', label: 'Job ID' },
  { default: true, key: 'jobTitle', label: 'Job title' },
  { default: true, key: 'jobStatus', label: 'Job status' },
  { default: true, key: 'organisation', label: 'Organisation' },
  { key: 'jobCreatedAt', label: 'Job created' },
  { key: 'jobPublishedAt', label: 'Job published' },
  { key: 'jobExpiresAt', label: 'Job expires' },
  { default: true, key: 'orderId', label: 'Order ID' },
  { default: true, key: 'orderStatus', label: 'Order status' },
  { default: true, key: 'currency', label: 'Currency' },
  { default: true, key: 'orderTotal', label: 'Order total (minor units)' },
  { key: 'orderTax', label: 'Order tax (minor units)' },
  { key: 'orderPaidAt', label: 'Order paid' },
]

export const JOB_VIEWS_FIELDS: ReportDefinition['fields'] = [
  { default: true, key: 'jobId', label: 'Job ID' },
  { default: true, key: 'jobTitle', label: 'Job title' },
  { default: true, key: 'jobStatus', label: 'Job status' },
  { default: true, key: 'organisation', label: 'Organisation' },
  { key: 'jobCreatedAt', label: 'Job created' },
  { key: 'jobPublishedAt', label: 'Job published' },
  { default: true, key: 'views', label: 'Views (includes imported legacy views)' },
]

/**
 * Jobs created in the range, one row each, with the order that paid for it (a job on several
 * orders repeats per order). Months and range bounds use the tenant's timezone.
 */
const runJobsOrders = async (registry: PayloadJobsRegistry, args: ReportRunArgs) => {
  const { slugs } = registry.context
  const timeZone = await tenantTimeZone(registry, args)
  const range = resolveRange(args.from, args.to, timeZone)
  const jobs = await findAll(args.payload, args.req, slugs.jobs, scopedWhere(registry, args, range), 'createdAt')

  const jobIDs = jobs.map((job) => job.id)
  const orders: Doc[] = []
  for (let i = 0; i < jobIDs.length; i += IN_CHUNK) {
    const and: Where[] = [{ jobs: { in: jobIDs.slice(i, i + IN_CHUNK) } }]
    if (registry.context.tenancy === 'multi') and.push({ tenant: { equals: args.tenantID } })
    orders.push(...(await findAll(args.payload, args.req, slugs.orders, { and }, 'createdAt')))
  }

  const ordersByJob = new Map<string, Doc[]>()
  for (const order of orders) {
    for (const job of (order.jobs ?? []) as unknown[]) {
      const key = String(idOf(job))
      ordersByJob.set(key, [...(ordersByJob.get(key) ?? []), order])
    }
  }

  const names = await organisationNames(
    registry,
    args,
    [...new Set(jobs.map((job) => idOf(job.organisation)).filter((id) => id !== null))] as (number | string)[],
  )

  const rows = jobs.flatMap((job) =>
    (ordersByJob.get(String(job.id)) ?? [null]).map((order) => ({
      currency: order?.currency ?? '',
      jobCreatedAt: job.createdAt,
      jobExpiresAt: job.expiresAt ?? '',
      jobId: job.id,
      jobPublishedAt: job.publishedAt ?? '',
      jobStatus: job.status,
      jobTitle: job.title,
      month: monthOf(job.createdAt, timeZone),
      orderId: order?.id ?? '',
      orderPaidAt: order?.paidAt ?? '',
      orderStatus: order?.status ?? '',
      orderTax: order?.tax ?? '',
      orderTotal: order?.total ?? '',
      organisation: names.get(String(idOf(job.organisation))) ?? '',
    })),
  )

  return project(args.fields, JOBS_ORDERS_FIELDS, rows)
}

/** One row per job created in the range, with its total view count (imported legacy views included). */
const runJobViews = async (registry: PayloadJobsRegistry, args: ReportRunArgs) => {
  const timeZone = await tenantTimeZone(registry, args)
  const range = resolveRange(args.from, args.to, timeZone)
  const jobs = await findAll(
    args.payload,
    args.req,
    registry.context.slugs.jobs,
    scopedWhere(registry, args, range),
    'createdAt',
  )
  const names = await organisationNames(
    registry,
    args,
    [...new Set(jobs.map((job) => idOf(job.organisation)).filter((id) => id !== null))] as (number | string)[],
  )

  return project(
    args.fields,
    JOB_VIEWS_FIELDS,
    jobs.map((job) => ({
      jobCreatedAt: job.createdAt,
      jobId: job.id,
      jobPublishedAt: job.publishedAt ?? '',
      jobStatus: job.status,
      jobTitle: job.title,
      organisation: names.get(String(idOf(job.organisation))) ?? '',
      views: job.views ?? 0,
    })),
  )
}

/** The two legacy reports, as registry entries owned by the reports add-on. */
export const reportDefinitions = (registry: PayloadJobsRegistry): ReportDefinition[] => [
  {
    addOn: REPORTS_ADD_ON_KEY,
    fields: JOBS_ORDERS_FIELDS,
    key: JOBS_ORDERS_REPORT_KEY,
    label: 'Jobs and orders by month',
    order: 10,
    run: (args) => runJobsOrders(registry, args),
  },
  {
    addOn: REPORTS_ADD_ON_KEY,
    fields: JOB_VIEWS_FIELDS,
    key: JOB_VIEWS_REPORT_KEY,
    label: 'Job views',
    order: 20,
    run: (args) => runJobViews(registry, args),
  },
]
