import type { CollectionSlug, GlobalSlug, Payload, PayloadRequest, TaskConfig, TaskSlug, Where } from 'payload'

import { logCutoffs, logRetention, maskEmail, monthRange, type LogRetention } from './log-policy'

export const EMAIL_LOG_RETENTION_TASK = 'email-log-retention'

type Scope = { retention: LogRetention; tenantID: null | number | string }

const scopesOf = async ({
  payload,
  req,
  settingsSlug,
  tenancy,
  tenantsSlug,
}: {
  payload: Payload
  req?: PayloadRequest
  settingsSlug: string
  tenancy: 'multi' | 'single'
  tenantsSlug: string
}): Promise<Scope[]> => {
  if (tenancy !== 'multi') {
    const settings = await payload.findGlobal({ depth: 0, overrideAccess: true, req, slug: settingsSlug as GlobalSlug })
    return [{ retention: logRetention(settings as never), tenantID: null }]
  }

  const { docs } = await payload.find({
    collection: tenantsSlug as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    select: { emailLogRetention: true },
  })

  return docs.map((tenant) => ({ retention: logRetention(tenant as never), tenantID: tenant.id }))
}

const tenantWhere = (tenantID: null | number | string): Where[] => (tenantID === null ? [] : [{ tenant: { equals: tenantID } }])

/**
 * Apply one tenant's retention: delete rows past the delete period, then mask the recipient of
 * the rows past the visible period. Idempotent, and the cutoffs include the boundary instant.
 */
export const applyEmailLogRetention = async ({
  batchSize = 100,
  logSlug,
  now,
  payload,
  req,
  scope,
}: {
  batchSize?: number
  logSlug: string
  now: Date
  payload: Payload
  req?: PayloadRequest
  scope: Scope
}): Promise<{ deleted: number; masked: number }> => {
  const { deleteBefore, maskBefore } = logCutoffs(scope.retention, now)
  const collection = logSlug as CollectionSlug

  const doomed = await payload.delete({
    collection,
    overrideAccess: true,
    req,
    where: { and: [...tenantWhere(scope.tenantID), { sentAt: { less_than_equal: deleteBefore.toISOString() } }] },
  })

  let masked = 0
  for (;;) {
    const { docs } = await payload.find({
      collection,
      depth: 0,
      limit: batchSize,
      overrideAccess: true,
      pagination: false,
      req,
      select: { recipient: true },
      where: {
        and: [
          ...tenantWhere(scope.tenantID),
          { recipientMasked: { equals: false } },
          { sentAt: { less_than_equal: maskBefore.toISOString() } },
        ],
      },
    })
    if (docs.length === 0) break

    for (const row of docs) {
      await payload.update({
        collection,
        data: { recipient: maskEmail(String((row as { recipient?: string }).recipient ?? '')), recipientMasked: true } as never,
        id: row.id,
        overrideAccess: true,
        req,
      })
      masked += 1
    }
  }

  return { deleted: doomed.docs.length, masked }
}

export type EmailLogTaskOptions = {
  clock?: () => Date
  /** 6-field cron (seconds first). Default: 02:30 UTC daily. */
  cron?: string
  logSlug: string
  queue?: string
  settingsSlug: string
  tenancy: 'multi' | 'single'
  tenantsSlug: string
}

/** The nightly job: mask and delete email log rows, each tenant by its own periods. */
export const emailLogRetentionTask = ({
  clock = () => new Date(),
  cron = '0 30 2 * * *',
  logSlug,
  queue = 'hourly',
  settingsSlug,
  tenancy,
  tenantsSlug,
}: EmailLogTaskOptions): TaskConfig => ({
  slug: EMAIL_LOG_RETENTION_TASK as TaskSlug,
  outputSchema: [
    { name: 'deleted', type: 'number' },
    { name: 'masked', type: 'number' },
  ],
  schedule: [{ cron, queue }],
  handler: async ({ req }) => {
    const now = clock()
    let deleted = 0
    let masked = 0

    for (const scope of await scopesOf({ payload: req.payload, req, settingsSlug, tenancy, tenantsSlug })) {
      const result = await applyEmailLogRetention({ logSlug, now, payload: req.payload, req, scope })
      deleted += result.deleted
      masked += result.masked
    }

    return { output: { deleted, masked } }
  },
})

/** Statuses that did not leave the platform, so they are not billed. */
const NOT_BILLED = ['skipped', 'failed']

/**
 * How many emails a tenant sent in a UTC month (`2026-11`), for billing: everything handed to a
 * transport, whatever happened to it afterwards. Skipped (switched off) and failed sends are not
 * counted. The log keeps rows for the tenant's delete period (12 months by default), so only
 * months inside it can be counted.
 */
export const monthlyEmailVolume = async ({
  logSlug,
  month,
  payload,
  tenantID,
}: {
  logSlug: string
  month: string
  payload: Payload
  tenantID: null | number | string
}): Promise<number> => {
  const { from, to } = monthRange(month)
  const { totalDocs } = await payload.count({
    collection: logSlug as CollectionSlug,
    overrideAccess: true,
    where: {
      and: [
        ...tenantWhere(tenantID),
        { sentAt: { greater_than_equal: from.toISOString() } },
        { sentAt: { less_than: to.toISOString() } },
        { status: { not_in: NOT_BILLED } },
      ],
    },
  })

  return totalDocs
}

/** `monthlyEmailVolume` for each of the last `months` months, newest first. */
export const emailVolumeByMonth = async ({
  months = 12,
  now = new Date(),
  ...args
}: {
  logSlug: string
  months?: number
  now?: Date
  payload: Payload
  tenantID: null | number | string
}): Promise<{ count: number; month: string }[]> => {
  const result: { count: number; month: string }[] = []
  for (let back = 0; back < months; back += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    result.push({ count: await monthlyEmailVolume({ ...args, month }), month })
  }

  return result
}
