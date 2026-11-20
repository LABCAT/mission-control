import type { CollectionSlug, Payload, Where } from 'payload'

import { getUserTenantIDsByRole, isSuperAdmin, type MissionControlUser } from '../access'
import { JOBS_SLUG } from '../collections/jobs'
import { ORDERS_SLUG } from './collections'
import { SITE_MANAGER_ROLES } from './nav'

/**
 * The site manager's dashboard (PJ-30, S-117): the jobs waiting for a decision, what is live
 * and what has ended, and the newest orders, all for one tenant. It only queries; the admin
 * component that renders it lives in the app, so the same numbers can move to the Astro site
 * later without rewriting anything (Decision 3).
 */

/** The multi-tenant plugin's tenant selector cookie. */
export const TENANT_COOKIE = 'payload-tenant'

export const PENDING_JOBS_LIMIT = 5
export const RECENT_ORDERS_LIMIT = 5

export type DashboardJob = {
  id: number | string
  organisation: string
  title: string
}

export type DashboardOrder = {
  currency: null | string
  id: number | string
  organisation: string
  status: string
  totalMinor: number
}

/** The tenant's own presentation settings, so money and dates read the same as the site. */
export type DashboardTenant = {
  currency: null | string
  currencyMinorUnits: null | number
  id: number | string
  locale: string
  name: string
}

export type SiteManagerDashboard = {
  jobCounts: { ended: number; live: number; pending: number }
  /** The resolved jobs collection slug, for links back into the admin. */
  jobsSlug: string
  /** Null when the host has no orders collection yet (PJ-31). */
  orders: null | { count: number; recent: DashboardOrder[]; slug: string }
  pendingJobs: DashboardJob[]
  tenant: DashboardTenant
}

/**
 * The tenant a site manager is working in: the tenant selector cookie when it names one of
 * their tenants, otherwise their first. A super admin gets `null` because their dashboard is
 * not tenant-scoped.
 */
export const activeTenantID = (
  user: MissionControlUser | null | undefined,
  cookieValue?: null | string,
): number | string | null => {
  if (!user || isSuperAdmin(user)) return null

  const ids = getUserTenantIDsByRole(user, SITE_MANAGER_ROLES)
  if (ids.length === 0) return null

  const selected = cookieValue ?? null
  if (selected === null) return ids[0]

  // The cookie holds the id as a string; return the user's own membership id so callers get
  // the same type whichever path they took.
  return ids.find((id) => String(id) === selected) ?? ids[0]
}

const textOf = (value: unknown): null | string =>
  typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value : null

const minorUnitsOf = (value: unknown): null | number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

/** A relationship's display name, whether it came back populated or as an id. */
const relatedName = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'name' in value) {
    return String((value as { name: unknown }).name ?? '')
  }

  return ''
}

const inTenant = (tenantID: number | string): Where => ({ tenant: { equals: tenantID } })

export type DashboardSlugs = {
  jobs?: string
  orders?: string
  tenants?: string
}

/** The slugs the plugin resolved from its options, recorded on `config.custom` (PJ-80). */
export const jobBoardSlugs = (config: { custom?: unknown }): DashboardSlugs => {
  const custom = config.custom as undefined | { payloadJobs?: { slugs?: DashboardSlugs } }

  return { ...custom?.payloadJobs?.slugs }
}

type LoadArgs = {
  payload: Payload
  /** Resolved collection slugs; the plugin's own options decide them (PJ-80). */
  slugs?: DashboardSlugs
  tenantID: number | string
  user: MissionControlUser
}

/**
 * Load the dashboard for one tenant. Every query runs with the user's own access
 * (`overrideAccess: false`), so the tenant filter narrows the query and Payload's access
 * narrows it again: asking for someone else's tenant yields zeros, not their documents.
 */
export const loadSiteManagerDashboard = async ({
  payload,
  slugs = {},
  tenantID,
  user,
}: LoadArgs): Promise<SiteManagerDashboard> => {
  const jobs = (slugs.jobs ?? JOBS_SLUG) as CollectionSlug
  const tenants = (slugs.tenants ?? 'tenants') as CollectionSlug
  const ordersSlug = (slugs.orders ?? ORDERS_SLUG) as CollectionSlug
  const as = { overrideAccess: false, user: user as never }
  const tenant = inTenant(tenantID)

  const [tenantDoc, pending, pendingCount, live, ended] = await Promise.all([
    payload.findByID({ collection: tenants, depth: 0, id: tenantID, ...as }).catch(() => null),
    payload.find({
      collection: jobs,
      depth: 1,
      limit: PENDING_JOBS_LIMIT,
      sort: 'createdAt',
      where: { and: [tenant, { status: { equals: 'pending' } }] },
      ...as,
    }),
    payload.count({
      collection: jobs,
      where: { and: [tenant, { status: { equals: 'pending' } }] },
      ...as,
    }),
    payload.count({
      collection: jobs,
      where: { and: [tenant, { status: { equals: 'published' } }] },
      ...as,
    }),
    payload.count({
      collection: jobs,
      where: { and: [tenant, { status: { in: ['expired', 'cancelled'] } }] },
      ...as,
    }),
  ])

  return {
    jobCounts: { ended: ended.totalDocs, live: live.totalDocs, pending: pendingCount.totalDocs },
    jobsSlug: String(jobs),
    orders: payload.collections[ordersSlug]
      ? await loadOrders({ payload, ordersSlug, tenantID, as })
      : null,
    pendingJobs: pending.docs.map((doc) => {
      const job = doc as { id: number | string; organisation?: unknown; title?: unknown }

      return {
        id: job.id,
        organisation: relatedName(job.organisation),
        title: String(job.title ?? ''),
      }
    }),
    tenant: {
      currency: textOf((tenantDoc as { currency?: unknown } | null)?.currency),
      currencyMinorUnits: minorUnitsOf(
        (tenantDoc as { currencyMinorUnits?: unknown } | null)?.currencyMinorUnits,
      ),
      id: tenantID,
      locale: textOf((tenantDoc as { defaultLocale?: unknown } | null)?.defaultLocale) ?? 'en',
      name: relatedName((tenantDoc as { name?: unknown } | null)?.name) || String(tenantID),
    },
  }
}

type OrdersArgs = {
  as: { overrideAccess: boolean; user: never }
  ordersSlug: CollectionSlug
  payload: Payload
  tenantID: number | string
}

const loadOrders = async ({ as, ordersSlug, payload, tenantID }: OrdersArgs) => {
  const where = inTenant(tenantID)
  const [count, recent] = await Promise.all([
    payload.count({ collection: ordersSlug, where, ...as }),
    payload.find({
      collection: ordersSlug,
      depth: 1,
      limit: RECENT_ORDERS_LIMIT,
      sort: '-createdAt',
      where,
      ...as,
    }),
  ])

  return {
    count: count.totalDocs,
    recent: recent.docs.map((doc) => {
      const order = doc as {
        currency?: unknown
        id: number | string
        organisation?: unknown
        status?: unknown
        total?: unknown
      }

      return {
        currency: typeof order.currency === 'string' ? order.currency : null,
        id: order.id,
        organisation: relatedName(order.organisation),
        status: String(order.status ?? ''),
        totalMinor: typeof order.total === 'number' ? order.total : 0,
      }
    }),
    slug: ordersSlug,
  }
}

const CURRENCY_CODE = /^[A-Z]{3}$/

/** `amountMinor` as an exact decimal string, so formatting never divides into a float. */
const decimalString = (amountMinor: number, digits: number): string => {
  const sign = amountMinor < 0 ? '-' : ''
  const whole = String(Math.abs(Math.trunc(amountMinor))).padStart(digits + 1, '0')
  const cut = whole.length - digits

  return digits === 0 ? `${sign}${whole}` : `${sign}${whole.slice(0, cut)}.${whole.slice(cut)}`
}

/** The currency's own exponent as ICU knows it: 0 for VUV and JPY, 2 for NZD and USD. */
export const currencyMinorUnits = (currency: string): number => {
  const { maximumFractionDigits } = new Intl.NumberFormat('en', {
    currency: currency.toUpperCase(),
    style: 'currency',
  }).resolvedOptions()

  return maximumFractionDigits ?? 2
}

/**
 * Money for the dashboard: whole minor units plus the tenant's currency, locale and exponent
 * (`currencyMinorUnits` from the tenant, otherwise ICU's). Never a float amount.
 */
export const formatMinorUnits = (
  amountMinor: number,
  { currency, locale = 'en', minorUnits }: { currency: string; locale?: string; minorUnits?: null | number },
): string => {
  const code = currency.toUpperCase()
  if (!CURRENCY_CODE.test(code)) {
    throw new TypeError(`Money needs a 3-letter ISO 4217 currency code, got "${currency}"`)
  }

  const digits = minorUnits ?? currencyMinorUnits(code)

  return new Intl.NumberFormat(locale, {
    currency: code,
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    style: 'currency',
  }).format(Number(decimalString(amountMinor, digits)))
}
