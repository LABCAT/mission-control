import { orderStatusFromLegacy, type OrderStatus } from '@mission-control/payload-jobs'

import { legacyText } from '../legacy-text'
import type { MysqlReader } from '../mysql-reader'
import type { ImportContext, Importer, MappedDoc, SkippedRow } from '../types'
import { parseLegacyDate } from './jobs'
import type { ImportPlan, PlanProvider } from './users'

/**
 * Import of the legacy plans, coupons, orders and credit balances (PJ-65).
 *
 * - `plans` writes nothing: the plans are seeded (PJ-21/PJ-87), and this checks the seed against
 *   the live `pricing-plan` posts, so a price that drifted shows up as a failure in the dry run.
 * - `coupons` imports the coupons that have not expired (19 Nov decision: LINKPS stays, the
 *   expired ones are not imported; `importExpiredCoupons` turns that around).
 * - `orders` imports the `transaction` posts of the last 24 months. They belong to the
 *   organisation of the job they paid for; `tr_pending` (a bank transfer nobody marked complete,
 *   paid through Xero) becomes `invoiced`.
 * - `credits` writes each active job pack's remaining credits as one opening-balance ledger row
 *   with a legacy reference, no expiry.
 *
 * Everything is idempotent: orders and coupons by `legacyId` + tenant, ledger rows by their
 * legacy reference. PayPal data and order logs are never read.
 *
 * The order and pack meta key names are gathered in `LEGACY_ORDER_META` and `PACK_META_PREFIX`:
 * they follow AppThemes Payments and JobRoller, and a dry run against the live copy is the
 * check. A row whose money or pack balance cannot be read is reported, never guessed.
 */

export type CommerceSlugs = {
  coupons: string
  creditLedger: string
  jobs: string
  orders: string
  organisations: string
  plans: string
}

const DEFAULT_SLUGS: CommerceSlugs = {
  coupons: 'coupons',
  creditLedger: 'credit-ledger',
  jobs: 'jobs',
  orders: 'orders',
  organisations: 'organisations',
  plans: 'plans',
}

/** The post meta keys of a legacy `transaction`. Override the names if the live site differs. */
export const LEGACY_ORDER_META = {
  currency: 'currency',
  tax: 'tax_charge',
  total: 'total_price',
  xeroInvoiceId: '_xero_invoice_id',
} as const
export type OrderMetaKeys = { [K in keyof typeof LEGACY_ORDER_META]: string }

/** User meta `_jr_user_pack-<plan id>-<order id>` holds one pack's remaining credits. */
export const PACK_META_PREFIX = '_jr_user_pack-'

const ORDER_CONNECTION = 'order-connection'

export type CommerceImportOptions = {
  /** Import coupons that have already expired too. Default false (19 Nov decision). */
  importExpiredCoupons?: boolean
  /** Clock, for tests. */
  now?: () => Date
  /** Months of orders to import. Default 24. */
  orderMonths?: number
  orderMeta?: Partial<OrderMetaKeys>
  /** The registered payment provider that invoices an order. Default `invoice`. */
  paymentProvider?: string
  planProvider: PlanProvider
  /** Fixed currency. Default: the legacy order's own, else the tenant's. */
  currency?: string
  /** `post_date` is site-local; used when `post_date_gmt` is empty. Minutes east of UTC. Default 0. */
  siteUtcOffsetMinutes?: number
  slugs?: Partial<CommerceSlugs>
  tenantsSlug?: string
}

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------

/** Decimal digits of a currency's minor unit: VUV 0, NZD 2. */
export const currencyDigits = (currency: string): number =>
  new Intl.NumberFormat('en', { currency, style: 'currency' }).resolvedOptions().maximumFractionDigits ?? 2

/**
 * A legacy amount as written on the old site (`3900`, `39.00`, `1,900`) in whole minor units of
 * `currency`, or `null` when it is not a plain non-negative number with no extra decimals.
 */
export const toMinorUnits = (value: null | string | undefined, currency: string): null | number => {
  const text = String(value ?? '').trim().replaceAll(',', '')
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const digits = currencyDigits(currency)
  const [whole = '0', fraction = ''] = text.split('.')
  if (fraction.replace(/0+$/, '').length > digits) return null
  const minor = Number(whole + fraction.padEnd(digits, '0').slice(0, digits))
  return Number.isSafeInteger(minor) ? minor : null
}

/** `MM/DD/YYYY` (the coupon plugin's date format) as a UTC date, or `null` for none or garbage. */
export const parseCouponDate = (value: null | string | undefined): Date | null => {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const [, month, day, year] = match.map(Number) as [number, number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null
}

/** A coupon's last day is the whole day: it has expired once that day is over. */
export const couponExpired = (endDate: null | string | undefined, now: Date): boolean => {
  const end = parseCouponDate(endDate)
  return end !== null && end.getTime() + 24 * 60 * 60 * 1000 <= now.getTime()
}

/** The first moment of the window of orders to import: `months` before `now`. */
export const orderCutoff = (now: Date, months: number): Date => {
  const cutoff = new Date(now)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months)
  return cutoff
}

/**
 * Remaining credits of one legacy pack. The value is either the number left, or a serialized
 * PHP array with `jobs_limit` and `jobs_count` (what was bought, what was used). `null` when it
 * is neither: the row is reported, not guessed.
 */
export const remainingPackCredits = (value: null | string | undefined): null | number => {
  const text = String(value ?? '').trim()
  if (/^\d+$/.test(text)) return Number(text)
  const field = (name: string): null | number => {
    const match = new RegExp(`s:\\d+:"${name}";(?:i:|s:\\d+:")(\\d+)`).exec(text)
    return match ? Number(match[1]) : null
  }
  const limit = field('jobs_limit')
  const count = field('jobs_count')
  return limit === null || count === null ? null : Math.max(limit - count, 0)
}

const monthOf = (postDate: string): string => postDate.slice(0, 7)

// ---------------------------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------------------------

type Meta = Record<string, string>

/** Post meta for the wanted posts and keys. A duplicate key: the last one wins, as in WordPress. */
const readPostMeta = async (reader: MysqlReader, keys: readonly string[], wanted: Set<number>): Promise<Map<number, Meta>> => {
  const metaOf = new Map<number, Meta>()
  for await (const row of reader.rows<Record<string, unknown>>('postmeta', {
    key: 'meta_id',
    params: [...keys],
    where: `meta_key IN (${keys.map(() => '?').join(', ')})`,
  })) {
    const id = Number(row.post_id)
    if (!wanted.has(id)) continue
    const meta = metaOf.get(id) ?? {}
    meta[String(row.meta_key)] = String(row.meta_value ?? '')
    metaOf.set(id, meta)
  }
  return metaOf
}

type LegacyPost = { authorId: number; date: string; dateGmt: string; id: number; meta: Meta; modifiedGmt: string; status: string; title: string }

const readPosts = async (reader: MysqlReader, postType: string, keys: readonly string[], keep: (post: Record<string, unknown>) => boolean = () => true): Promise<LegacyPost[]> => {
  const posts: Record<string, unknown>[] = []
  for await (const row of reader.rows<Record<string, unknown>>('posts', { params: [postType], where: 'post_type = ?' })) {
    if (keep(row)) posts.push(row)
  }
  const metaOf = await readPostMeta(reader, keys, new Set(posts.map((post) => Number(post.ID))))
  return posts.map((post) => ({
    authorId: Number(post.post_author),
    date: String(post.post_date ?? ''),
    dateGmt: String(post.post_date_gmt ?? ''),
    id: Number(post.ID),
    meta: metaOf.get(Number(post.ID)) ?? {},
    modifiedGmt: String(post.post_modified_gmt ?? ''),
    status: String(post.post_status ?? ''),
    title: String(post.post_title ?? ''),
  }))
}

/** Tenant documents by legacy id, read once: `{ id, doc }`. */
const docsByLegacyId = async (ctx: ImportContext, collection: string): Promise<Map<number, Record<string, any>>> => {
  const { docs } = await ctx.payload.find({
    collection,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: { tenant: { equals: ctx.tenant } },
  })
  const map = new Map<number, Record<string, any>>()
  for (const doc of docs) if (typeof doc.legacyId === 'number') map.set(doc.legacyId, doc)
  return map
}

const idOf = (value: unknown): null | number | string =>
  value && typeof value === 'object' ? ((value as { id?: number | string }).id ?? null) : ((value as null | number | string) ?? null)

// ---------------------------------------------------------------------------------------------
// Importers
// ---------------------------------------------------------------------------------------------

type LegacyOrder = LegacyPost & { targets: number[] }
type LegacyPack = { key: string; remaining: null | number; umetaId: number; userId: number; value: string }

const PLAN_META = ['_jr_price', '_jr_relist_price', '_jr_duration', '_jr_jobs_limit'] as const
const COUPON_META = ['code', 'type', 'amount', 'end_date', 'use_count', 'use_limit'] as const

export const commerceImporters = (
  options: CommerceImportOptions,
): { coupons: Importer<LegacyPost>; credits: Importer<LegacyPack>; orders: Importer<LegacyOrder>; plans: Importer<LegacyPost> } => {
  const slugs = { ...DEFAULT_SLUGS, ...options.slugs }
  const orderMeta: OrderMetaKeys = { ...LEGACY_ORDER_META, ...options.orderMeta }
  const clock = options.now ?? (() => new Date())
  const offset = options.siteUtcOffsetMinutes ?? 0
  const months = options.orderMonths ?? 24
  const provider = options.paymentProvider ?? 'invoice'
  const tenantsSlug = options.tenantsSlug ?? 'tenants'

  const tallies: Record<'coupons' | 'credits' | 'orders' | 'plans', Record<string, number>> = { coupons: {}, credits: {}, orders: {}, plans: {} }
  const count = (group: keyof typeof tallies, key: string, n = 1) => void (tallies[group][key] = (tallies[group][key] ?? 0) + n)
  const reset = (group: keyof typeof tallies) => void (tallies[group] = {})
  const sorted = (record: Record<string, number>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))

  // Tenant lookups, one read per run (a new read of the source starts a new run).
  let lookups: { currency?: Promise<string>; jobs?: Promise<Map<number, Record<string, any>>>; organisations?: Promise<Map<number, Record<string, any>>>; plans?: Promise<Map<number, Record<string, any>>>; ctx: ImportContext } | undefined
  const lookupsFor = (ctx: ImportContext) => (lookups?.ctx === ctx ? lookups : (lookups = { ctx }))
  const jobsOf = (ctx: ImportContext) => (lookupsFor(ctx).jobs ??= docsByLegacyId(ctx, slugs.jobs))
  const organisationsOf = (ctx: ImportContext) => (lookupsFor(ctx).organisations ??= docsByLegacyId(ctx, slugs.organisations))
  const plansOf = (ctx: ImportContext) => (lookupsFor(ctx).plans ??= docsByLegacyId(ctx, slugs.plans))
  const tenantCurrency = (ctx: ImportContext) =>
    (lookupsFor(ctx).currency ??= ctx.payload
      .find({ collection: tenantsSlug, depth: 0, limit: 1, overrideAccess: true, pagination: false, where: { id: { equals: ctx.tenant } } })
      .then(({ docs }) => String(docs[0]?.currency ?? '')))

  let usersPlan: ImportPlan | undefined
  const usersPlanFor = async (reader: MysqlReader) => (usersPlan = await options.planProvider(reader))

  // -------------------------------------------------------------------------------------------
  // Plans: verify the seed, write nothing
  // -------------------------------------------------------------------------------------------
  const plans: Importer<LegacyPost> = {
    collection: slugs.plans,
    dependsOn: [],
    map: async (post, ctx) => {
      if (post.status !== 'publish') {
        count('plans', `legacy plans not published (${post.status || 'none'})`)
        return { skip: `not-published-${post.status || 'none'}` }
      }
      const seeded = (await plansOf(ctx)).get(post.id)
      if (!seeded) throw new Error(`Legacy plan ${post.id} ("${legacyText(post.title)}") is not in this tenant: run the plan seed (PJ-87) first`)

      const currency = options.currency ?? (await tenantCurrency(ctx)) ?? ''
      const price = toMinorUnits(post.meta._jr_price, currency || 'VUV')
      const relist = toMinorUnits(post.meta._jr_relist_price, currency || 'VUV')
      const differs: string[] = []
      if (price !== seeded.price) differs.push(`price ${seeded.price} is ${price} on the live plan`)
      // Decision 19 Nov: the relist price equals the price, and the plan has no separate field.
      if (relist !== null && relist !== price) differs.push(`relist price ${relist} differs from the price ${price}`)
      if (Number(post.meta._jr_duration) !== seeded.durationDays) differs.push(`duration ${seeded.durationDays} days is ${post.meta._jr_duration} on the live plan`)
      if (Number(post.meta._jr_jobs_limit) !== seeded.jobCredits) differs.push(`job credits ${seeded.jobCredits} is ${post.meta._jr_jobs_limit} on the live plan`)
      if (differs.length > 0) {
        count('plans', 'plans differing from the seed')
        throw new Error(`Seed plan "${seeded.key}" (legacy ${post.id}): ${differs.join('; ')}`)
      }
      count('plans', 'plans matching the seed')
      return { skip: 'matches-seed' }
    },
    name: 'plans',
    read: async function* (reader) {
      reset('plans')
      yield* await readPosts(reader, 'pricing-plan', PLAN_META)
    },
    report: () => sorted(tallies.plans),
  }

  // -------------------------------------------------------------------------------------------
  // Coupons
  // -------------------------------------------------------------------------------------------
  const coupons: Importer<LegacyPost> = {
    collection: slugs.coupons,
    dependsOn: [],
    map: async (post, ctx): Promise<MappedDoc | SkippedRow> => {
      if (post.status !== 'publish') return { skip: `status-${post.status || 'none'}` }
      const code = legacyText(post.meta.code).toUpperCase()
      if (!code) return { skip: 'no-code' }

      if (couponExpired(post.meta.end_date, clock()) && !options.importExpiredCoupons) {
        count('coupons', 'coupons expired, not imported')
        return { skip: 'expired' }
      }

      const percent = post.meta.type === 'percent'
      if (!percent && post.meta.type !== 'flat') throw new Error(`Coupon ${code}: unknown type "${post.meta.type}"`)
      const currency = options.currency ?? (await tenantCurrency(ctx))
      const amount = percent ? Number(post.meta.amount) : toMinorUnits(post.meta.amount, currency || 'VUV')
      if (amount === null || !Number.isInteger(amount) || amount < 1 || (percent && amount > 100)) {
        throw new Error(`Coupon ${code}: cannot read the amount "${post.meta.amount}"`)
      }
      const useCount = Math.max(Number.parseInt(post.meta.use_count ?? '0', 10) || 0, 0)
      const maxUses = Number.parseInt(post.meta.use_limit ?? '0', 10)

      count('coupons', 'coupons imported')
      count('coupons', `coupon ${code} use count`, useCount)
      return {
        // The use count is a snapshot: the live site counts on after the import, so a re-run never resets it.
        createContext: { couponUseCount: true },
        createOnly: { useCount },
        data: {
          active: true,
          amount,
          code,
          discountType: percent ? 'percent' : 'flat',
          maxUses: maxUses > 0 ? maxUses : null,
        },
        legacyId: post.id,
      }
    },
    name: 'coupons',
    read: async function* (reader) {
      reset('coupons')
      yield* await readPosts(reader, 'discount_coupon', COUPON_META)
    },
    report: () => sorted(tallies.coupons),
  }

  // -------------------------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------------------------
  const orders: Importer<LegacyOrder> = {
    collection: slugs.orders,
    dependsOn: ['jobs', 'plans'],
    map: async (order, ctx): Promise<MappedDoc | SkippedRow> => {
      const status: OrderStatus | null = orderStatusFromLegacy(order.status)
      if (!status) return { skip: `status-${order.status || 'none'}` }

      const createdAt = parseLegacyDate(order.dateGmt) ?? parseLegacyDate(order.date, offset)
      if (!createdAt) return { skip: 'no-date' }

      const currency = (/^[A-Z]{3}$/.test(order.meta[orderMeta.currency] ?? '') ? order.meta[orderMeta.currency] : undefined) ?? options.currency ?? (await tenantCurrency(ctx))
      if (!/^[A-Z]{3}$/.test(currency ?? '')) throw new Error('No currency: set one on the tenant')
      const total = toMinorUnits(order.meta[orderMeta.total], currency!)
      if (total === null) {
        count('orders', 'orders without a readable total')
        return { skip: 'no-total' }
      }
      const taxText = order.meta[orderMeta.tax]
      if (taxText && toMinorUnits(taxText, currency!) !== 0) {
        throw new Error(`Order ${order.id} charged tax (${taxText}); the import expects none (decision 18 Nov)`)
      }

      // Organisation: the one the paid-for jobs belong to, else the ordering user's.
      const plansByLegacy = await plansOf(ctx)
      const jobs = await jobsOf(ctx)
      const planDoc = order.targets.map((id) => plansByLegacy.get(id)).find(Boolean)
      const jobDocs = order.targets.map((id) => jobs.get(id)).filter((doc): doc is Record<string, any> => doc !== undefined)
      const orgByJobs = jobDocs.map((doc) => idOf(doc.organisation)).find((id) => id !== null)
      let organisation: null | number | string | undefined = orgByJobs ?? undefined
      if (organisation === undefined) {
        const legacyOrg = usersPlan?.organisationOf.get(order.authorId)?.organisationLegacyId
        organisation = legacyOrg === undefined ? undefined : (await organisationsOf(ctx)).get(legacyOrg)?.id
      }
      // In a dry run the organisations and jobs of this run do not exist yet, so an order only
      // counts as unresolvable when neither its buyer nor any job it paid for could give one.
      const couldResolve = usersPlan?.organisationOf.has(order.authorId) || order.targets.some((id) => !plansByLegacy.has(id))
      if (organisation === undefined && (!ctx.dryRun || !couldResolve)) {
        count('orders', 'orders without an organisation')
        return { skip: 'no-organisation' }
      }

      const xero = legacyText(order.meta[orderMeta.xeroInvoiceId])
      const paidAt = status === 'paid' ? (parseLegacyDate(order.modifiedGmt) ?? createdAt) : null
      const paidFor = organisation === undefined ? jobDocs : jobDocs.filter((doc) => String(idOf(doc.organisation)) === String(organisation))

      count('orders', `orders ${monthOf(order.date)}`)
      count('orders', `orders status ${status}`)
      count('orders', `orders total ${currency} minor units ${monthOf(order.date)}`, total)
      count('orders', 'orders total minor units', total)
      if (xero) count('orders', 'orders with a Xero invoice')
      if (paidFor.length > 0) count('orders', 'orders linked to jobs')

      return {
        createOnly: {
          createdAt: createdAt.toISOString(),
          currency,
          discount: 0,
          paymentMethod: total === 0 ? 'free' : 'invoice',
          ...(total === 0 ? {} : { paymentProvider: provider }),
          ...(planDoc ? { plan: planDoc.id } : {}),
          subtotal: total,
          tax: 0,
          taxInclusive: false,
          taxLines: [],
          total,
        },
        data: {
          externalRefs: xero ? [{ externalId: xero, provider: 'xero' }] : [],
          jobs: paidFor.map((doc) => doc.id),
          ...(organisation === undefined ? {} : { organisation }),
          ...(paidAt ? { paidAt: paidAt.toISOString() } : {}),
          status,
          statusNote: `Imported from WordPress transaction ${order.id}`,
        },
        legacyId: order.id,
      }
    },
    name: 'orders',
    read: async function* (reader) {
      reset('orders')
      const cutoff = orderCutoff(clock(), months)
      const all = await readPosts(
        reader,
        'transaction',
        [orderMeta.currency, orderMeta.tax, orderMeta.total, orderMeta.xeroInvoiceId],
        (post) => {
          const at = parseLegacyDate(String(post.post_date_gmt ?? '')) ?? parseLegacyDate(String(post.post_date ?? ''), offset)
          if (at !== null && at < cutoff) {
            count('orders', 'orders older than the window, not imported')
            return false
          }
          return true
        },
      )
      await usersPlanFor(reader)

      const targets = new Map<number, number[]>()
      for await (const row of reader.rows<Record<string, unknown>>('p2p', { key: 'p2p_id', params: [ORDER_CONNECTION], where: 'p2p_type = ?' })) {
        const from = Number(row.p2p_from)
        targets.set(from, [...(targets.get(from) ?? []), Number(row.p2p_to)])
      }
      for (const post of all) yield { ...post, targets: targets.get(post.id) ?? [] }
    },
    report: () => sorted(tallies.orders),
  }

  // -------------------------------------------------------------------------------------------
  // Credits: one opening-balance row per active pack
  // -------------------------------------------------------------------------------------------
  const credits: Importer<LegacyPack> = {
    collection: slugs.creditLedger,
    dependsOn: ['organisations'],
    map: async (pack, ctx): Promise<MappedDoc | SkippedRow> => {
      if (pack.remaining === null) throw new Error(`Pack ${pack.key} of user ${pack.userId}: cannot read the remaining credits`)
      if (pack.remaining < 1) {
        count('credits', 'packs used up, no row')
        return { skip: 'empty-pack' }
      }
      const legacyOrg = usersPlan?.organisationOf.get(pack.userId)?.organisationLegacyId
      if (legacyOrg === undefined) {
        count('credits', 'credits of users not imported')
        count('credits', 'credits of users not imported (sum)', pack.remaining)
        return { skip: 'user-not-imported' }
      }
      const organisation = (await organisationsOf(ctx)).get(legacyOrg)?.id
      if (organisation === undefined && !ctx.dryRun) throw new Error(`Organisation ${legacyOrg} was not found: run the organisations first`)

      count('credits', 'opening credits (sum)', pack.remaining)
      count('credits', 'opening rows')
      count('credits', `opening credits of legacy organisation ${legacyOrg}`, pack.remaining)
      return {
        data: {
          delta: pack.remaining,
          legacyRef: `wp-user-pack:${pack.userId}:${pack.key}`,
          note: 'Opening balance carried over from the WordPress job pack',
          ...(organisation === undefined ? {} : { organisation }),
          reason: 'opening',
        },
        legacyId: pack.userId,
      }
    },
    matchBy: { field: 'legacyRef' },
    name: 'credits',
    read: async function* (reader) {
      reset('credits')
      await usersPlanFor(reader)
      for await (const row of reader.rows<Record<string, unknown>>('usermeta', {
        key: 'umeta_id',
        params: [`${PACK_META_PREFIX.replaceAll('_', '\\_')}%`],
        where: 'meta_key LIKE ?',
      })) {
        const value = String(row.meta_value ?? '')
        yield { key: String(row.meta_key), remaining: remainingPackCredits(value), umetaId: Number(row.umeta_id), userId: Number(row.user_id), value }
      }
    },
    report: () => sorted(tallies.credits),
  }

  return { coupons, credits, orders, plans }
}
