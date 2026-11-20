import type { CollectionSlug, Field, FieldAccess, TaskConfig, TaskSlug, Where } from 'payload'

import { hasAnyTenantRole, isSuperAdmin, type MissionControlUser } from './access'
import { ADD_ON_PLACEMENTS, ADD_ONS_SLUG, isAddOnPlacement, type AddOnPlacement } from './add-ons'
import { CATALOG_EDITOR_ROLES } from './catalog'
import type { AddOnEntitlement, DocumentID, PricedRef } from './pricing'

/**
 * Placements are how add-ons show on a job: "featured in listings" until a date, "featured in
 * its category" until another. A job stores each active placement with its own expiry; the
 * listing helpers here sort and badge by them, and a daily task removes expired ones.
 *
 * TODO(PJ-19): the jobs collection isn't on main yet. When it lands, add `jobPlacementsField()`
 * to it (plus a migration), apply `placementsAfterPurchase` when an order is paid (PJ-23), and
 * sort listings with `compareListings`. The plugin registers `expireJobPlacementsTask` on its
 * own as soon as a `jobs` collection with a `placements` field exists.
 */

export const PLACEMENTS_FIELD = 'placements'
export const EXPIRE_PLACEMENTS_TASK = 'expire-job-placements'

const DAY_MS = 24 * 60 * 60 * 1000

/** One stored placement on a job. Dates are ISO strings, as Payload stores them. */
export type JobPlacement = {
  /** The add-on that gave it, for reports. */
  addOn?: DocumentID | null | { id: DocumentID }
  expiresAt: string
  placement: AddOnPlacement
  startsAt: string
}

/** What the listing helpers read from a job. A jobs document satisfies this. */
export type PlacedJob = {
  id: DocumentID
  placements?: null | readonly Partial<JobPlacement>[]
  publishedAt?: null | string
}

const staffOnly: FieldAccess = ({ req }) => {
  const user = req.user as MissionControlUser | null | undefined
  return isSuperAdmin(user) || hasAnyTenantRole(user, CATALOG_EDITOR_ROLES)
}

/**
 * The `placements` field for the jobs collection (PJ-19). Paid orders fill it; staff may also
 * set it by hand (a manual "featured" flag). Employers can read it but not change it.
 */
export const jobPlacementsField = ({
  addOnRead,
  addOnsSlug = ADD_ONS_SLUG,
}: { addOnRead?: FieldAccess; addOnsSlug?: string } = {}): Field => ({
  name: PLACEMENTS_FIELD,
  type: 'array',
  access: { create: staffOnly, update: staffOnly },
  admin: { description: 'Where this job is featured, and until when. Expired rows are removed daily.' },
  fields: [
    {
      name: 'placement',
      type: 'select',
      required: true,
      options: [...ADD_ON_PLACEMENTS],
    },
    // Which purchase made the placement is not for the public site; the jobs collection passes
    // its private-field rule (`addOnRead`). The placement and its dates stay readable (badges).
    {
      name: 'addOn',
      type: 'relationship',
      relationTo: addOnsSlug as CollectionSlug,
      ...(addOnRead ? { access: { read: addOnRead } } : {}),
    },
    { name: 'startsAt', type: 'date', required: true },
    { name: 'expiresAt', type: 'date', index: true, required: true },
  ],
})

const timeOf = (value: unknown): number => {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') return Date.parse(value)
  return Number.NaN
}

const isLive = (row: Partial<JobPlacement> | null | undefined, now: number): boolean =>
  Boolean(row) &&
  isAddOnPlacement(row?.placement) &&
  timeOf(row?.startsAt) <= now &&
  now < timeOf(row?.expiresAt)

/** The placements live on a job at `now`, once each, in `ADD_ON_PLACEMENTS` order. */
export const activePlacements = (
  placements: PlacedJob['placements'],
  now: Date = new Date(),
): AddOnPlacement[] => {
  const at = now.getTime()
  const live = new Set((placements ?? []).filter((row) => isLive(row, at)).map((row) => row.placement))
  return ADD_ON_PLACEMENTS.filter((placement) => live.has(placement))
}

/** Badges for a job card: its live placements. The site maps each to a label or icon. */
export const listingBadges = (job: PlacedJob, now: Date = new Date()): AddOnPlacement[] =>
  activePlacements(job.placements, now)

/** Drop the rows that have ended (or are malformed). Rows that start later are kept. */
export const expirePlacements = (
  placements: PlacedJob['placements'],
  now: Date = new Date(),
): JobPlacement[] => {
  const at = now.getTime()
  return (placements ?? []).filter(
    (row): row is JobPlacement =>
      Boolean(row) &&
      isAddOnPlacement(row.placement) &&
      Number.isFinite(timeOf(row.startsAt)) &&
      at < timeOf(row.expiresAt),
  ) as JobPlacement[]
}

const refID = (ref: PricedRef): DocumentID => ref.id

/**
 * The job's placements after an order's add-ons are applied at `now` (pure; the caller saves).
 *
 * - Within one order, the longest duration per placement wins: a grant doesn't stack on top of
 *   the same placement bought in that order (Premium's 30 days of Enhanced plus 30 days of
 *   Enhanced bought alongside is 30 days, not 60).
 * - A placement that is still live is extended from its current expiry, so a buyer never loses
 *   days they already paid for. Otherwise it starts at `now`.
 * - Expired rows are dropped. Entitlements without a known placement change nothing.
 */
export const placementsAfterPurchase = (
  existing: PlacedJob['placements'],
  entitlements: readonly Pick<AddOnEntitlement, 'durationDays' | 'placement' | 'ref'>[],
  now: Date = new Date(),
): JobPlacement[] => {
  const at = now.getTime()
  const kept = expirePlacements(existing, now)

  const longest = new Map<AddOnPlacement, { addOn: DocumentID; days: number }>()
  for (const entitlement of entitlements) {
    if (!isAddOnPlacement(entitlement.placement)) continue
    if (!Number.isSafeInteger(entitlement.durationDays) || entitlement.durationDays < 1) continue
    const current = longest.get(entitlement.placement)
    if (!current || entitlement.durationDays > current.days) {
      longest.set(entitlement.placement, { addOn: refID(entitlement.ref), days: entitlement.durationDays })
    }
  }

  const result: JobPlacement[] = []
  for (const placement of ADD_ON_PLACEMENTS) {
    const rows = kept.filter((row) => row.placement === placement)
    const bought = longest.get(placement)

    if (!bought) {
      result.push(...rows)
      continue
    }

    // The live row that runs longest, if any.
    const live = rows
      .filter((row) => timeOf(row.startsAt) <= at)
      .reduce<JobPlacement | undefined>(
        (best, row) => (!best || timeOf(row.expiresAt) > timeOf(best.expiresAt) ? row : best),
        undefined,
      )
    const from = live ? timeOf(live.expiresAt) : at

    result.push(
      ...rows.filter((row) => row !== live),
      {
        addOn: bought.addOn,
        expiresAt: new Date(from + bought.days * DAY_MS).toISOString(),
        placement,
        startsAt: live ? live.startsAt : new Date(at).toISOString(),
      },
    )
  }

  return result
}

/** Which listing a job is shown in: the main listings, or one category's page. */
export type ListingContext = 'category' | 'listings'

/**
 * How strongly a job is featured in a listing: 2 = featured in its category (category pages
 * only), 1 = featured in listings, 0 = not featured.
 */
export const listingRank = (job: PlacedJob, context: ListingContext, now: Date = new Date()): number => {
  const live = activePlacements(job.placements, now)
  if (context === 'category' && live.includes('featured-in-category')) return 2
  return live.includes('featured-in-listings') ? 1 : 0
}

/**
 * A comparator for listings: featured first (see `listingRank`), then newest published, then
 * highest id, so the order is total and stable. Pass the same `now` for the whole sort.
 */
export const compareListings =
  (context: ListingContext, now: Date = new Date()) =>
  (a: PlacedJob, b: PlacedJob): number => {
    const rank = listingRank(b, context, now) - listingRank(a, context, now)
    if (rank !== 0) return rank

    const published = (timeOf(b.publishedAt) || 0) - (timeOf(a.publishedAt) || 0)
    if (published !== 0) return published

    const [idA, idB] = [String(a.id), String(b.id)]
    if (typeof a.id === 'number' && typeof b.id === 'number') return b.id - a.id
    return idA < idB ? 1 : idA > idB ? -1 : 0
  }

export type ExpirePlacementsTaskOptions = {
  /** 6-field cron (seconds first). Default: 00:10 UTC daily. */
  cron?: string
  /** How many jobs to update per batch. */
  batchSize?: number
  jobsSlug?: string
  /** Queue the Worker's cron runs (see apps/cms runScheduled). Default: `hourly`. */
  queue?: string
}

/**
 * Daily clean-up of expired placements. Listings already ignore expired rows (they compare
 * with `now`), so this only keeps the data tidy; running late or twice is harmless.
 *
 * It runs on the Payload jobs runner (PJ-08): the hourly Worker cron calls `handleSchedules`
 * then `run` on the queue, so the task is queued for the next 00:10 UTC and run on the tick
 * after. Cron calls have no user, so it reads and writes with `overrideAccess`.
 */
export const expireJobPlacementsTask = ({
  batchSize = 100,
  cron = '0 10 0 * * *',
  jobsSlug = 'jobs',
  queue = 'hourly',
}: ExpirePlacementsTaskOptions = {}): TaskConfig => ({
  // Generic here: the host's generated types only know the slug once the task is registered.
  slug: EXPIRE_PLACEMENTS_TASK as TaskSlug,
  outputSchema: [
    { name: 'jobsUpdated', type: 'number' },
    { name: 'placementsRemoved', type: 'number' },
  ],
  schedule: [{ cron, queue }],
  handler: async ({ req }) => {
    const now = new Date()
    let jobsUpdated = 0
    let placementsRemoved = 0
    let afterID: DocumentID | null = null

    for (;;) {
      const where: Where = {
        and: [
          { [`${PLACEMENTS_FIELD}.expiresAt`]: { less_than_equal: now.toISOString() } },
          ...(afterID === null ? [] : [{ id: { greater_than: afterID } }]),
        ],
      }
      const { docs } = await req.payload.find({
        collection: jobsSlug as CollectionSlug,
        depth: 0,
        limit: batchSize,
        overrideAccess: true,
        pagination: false,
        req,
        sort: 'id',
        where,
      })
      if (docs.length === 0) break

      for (const doc of docs) {
        const placements = (doc as PlacedJob).placements ?? []
        const kept = expirePlacements(placements, now)
        if (kept.length !== placements.length) {
          await req.payload.update({
            collection: jobsSlug as CollectionSlug,
            data: { [PLACEMENTS_FIELD]: kept } as never,
            id: doc.id,
            overrideAccess: true,
            req,
          })
          jobsUpdated += 1
          placementsRemoved += placements.length - kept.length
        }
      }

      afterID = docs[docs.length - 1].id as DocumentID
      if (docs.length < batchSize) break
    }

    return { output: { jobsUpdated, placementsRemoved } }
  },
})
