import type { CollectionSlug, Endpoint, PayloadRequest } from 'payload'

import { JOB_VIEWS_CONTEXT } from './collections/jobs'
import { createMemoryRateLimiter, type RateLimiter } from './rate-limit'
import { getSiteKeyHeader, resolveSiteKey } from './site-keys'
import { DEFAULT_PAYLOAD_JOBS_SLUGS, type PayloadJobsCollectionSlugs } from './slugs'

/**
 * Job page view counting (PJ-37). The site's own endpoint proxies `navigator.sendBeacon` here,
 * so the CMS sees the visitor's IP (in `x-end-user-ip`) and the site key stays server-side.
 *
 * The beacon is best effort: bots are ignored, one visitor cannot count a job a hundred times
 * in a minute, and nothing here decides whether the page *shows* the count (that is the tenant's
 * `publicJobViews` setting, applied by the site).
 */

/** Path of the beacon on the jobs collection: `POST /api/<jobs>/:id/view`. */
export const JOB_VIEW_PATH = '/:id/view'

/** Days of per-day counts kept on the job; only today's is shown, the rest feed nothing yet. */
export const JOB_VIEW_DAYS_KEPT = 8

const BOT_PATTERN =
  /bot|crawl|spider|slurp|scrap|headless|lighthouse|monitor|uptime|pingdom|curl|wget|python-requests|httpclient|facebookexternalhit|embedly|quora link preview|whatsapp|telegram|preview|scan|feed|pinterest|reddit|skypeuripreview|gptbot|claudebot|ccbot|perplexity|semrush|ahrefs|mj12|dotbot|petalbot|applebot|yandex|baidu|duckduckbot/i

/**
 * True when the user agent names a bot (or is missing). A browser beacon always carries one, so
 * an empty value means a script, not a reader. The list is deliberately broad: over-counting is
 * harmless, inflating an employer's numbers is not.
 */
export const isBotUserAgent = (userAgent: null | string | undefined): boolean => {
  const value = userAgent?.trim() ?? ''

  return value === '' || BOT_PATTERN.test(value)
}

const DAY_FORMAT = (timezone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: '2-digit', timeZone: timezone, year: 'numeric' })

/**
 * The calendar day of `now` in `timezone`, as `YYYY-MM-DD`. A tenant is a day, not a UTC offset:
 * "today" must follow the tenant's clock, and an unknown or invalid timezone falls back to UTC so
 * a bad setting cannot break the counter.
 */
export const viewDayKey = (now: Date, timezone?: null | string): string => {
  const zone = timezone?.trim() || 'UTC'

  try {
    return DAY_FORMAT(zone).format(now)
  } catch {
    return DAY_FORMAT('UTC').format(now)
  }
}

export type JobViewCounts = { total: number; today: number }
export type JobViewDay = { count: number; day: string }

/**
 * The counts after one more view on `day`: `views` + 1, that day's row + 1, and only the most
 * recent `JOB_VIEW_DAYS_KEPT` days kept so the row cannot grow for the life of the job.
 */
export const countedViews = (
  current: { viewDays?: JobViewDay[] | null; views?: null | number },
  day: string,
): { today: number; total: number; viewDays: JobViewDay[] } => {
  const rows = new Map<string, number>()
  for (const row of current.viewDays ?? []) {
    if (row?.day) rows.set(row.day, Math.max(0, Number(row.count) || 0))
  }

  rows.set(day, (rows.get(day) ?? 0) + 1)

  const viewDays = [...rows.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, JOB_VIEW_DAYS_KEPT)
    .map(([dayKey, count]) => ({ count, day: dayKey }))

  return {
    today: rows.get(day) ?? 0,
    total: Math.max(0, Number(current.views) || 0) + 1,
    viewDays,
  }
}

/** Today's count of a job already in hand, without changing anything. */
export const viewsOn = (
  current: { viewDays?: JobViewDay[] | null; views?: null | number },
  day: string,
): JobViewCounts => ({
  today: (current.viewDays ?? []).find((row) => row?.day === day)?.count ?? 0,
  total: Math.max(0, Number(current.views) || 0),
})

const clientIP = (req: PayloadRequest): string =>
  req.headers?.get?.('x-end-user-ip')?.trim() || req.headers?.get?.('cf-connecting-ip')?.trim() || 'unknown'

const defaultLimiter = createMemoryRateLimiter({ limit: 10, windowMs: 60_000 })

export type JobViewOptions = {
  /** Rate limiter, or a function returning one per request (the Cloudflare binding fits). */
  rateLimiter?: ((req: PayloadRequest) => RateLimiter | undefined) | RateLimiter
  slugs?: PayloadJobsCollectionSlugs
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { headers: { 'cache-control': 'no-store' }, status })

type BeaconJob = {
  id: number | string
  expiresAt?: null | string
  status?: null | string
  tenant?: null | number | { id?: number | string; timezone?: null | string }
  viewDays?: JobViewDay[] | null
  views?: null | number
}

const tenantOf = (job: BeaconJob): { id: null | number | string; timezone?: null | string } => {
  const tenant = job.tenant

  if (tenant === null || tenant === undefined) return { id: null }
  if (typeof tenant === 'object') return { id: tenant.id ?? null, timezone: tenant.timezone }

  return { id: tenant }
}

const isLive = (job: BeaconJob, now: Date): boolean =>
  job.status === 'published' && (!job.expiresAt || Date.parse(job.expiresAt) > now.getTime())

/**
 * `POST /api/<jobs>/:id/view`: counts one view of a live job and answers `{ total, today }`.
 *
 * - A valid site key is required, and the job must belong to that key's tenant.
 * - A bot, an unknown or non-live job, or an over-limit caller changes nothing; the bot and
 *   over-limit answers still carry the current counts so the site can render them.
 * - The write goes through `JOB_VIEWS_CONTEXT`, the only path allowed to change `views`.
 */
export const jobViewEndpoint = ({
  rateLimiter,
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
}: JobViewOptions = {}): Endpoint => ({
  handler: async (req) => {
    const now = new Date()
    const id = req.routeParams?.id
    if (typeof id !== 'string' && typeof id !== 'number') return json({ error: 'not_found' }, 404)

    if (!getSiteKeyHeader(req)) return json({ error: 'invalid_site_key' }, 401)
    const siteKey = await resolveSiteKey(req)
    if (!siteKey) return json({ error: 'invalid_site_key' }, 401)

    let job: BeaconJob
    try {
      job = (await req.payload.findByID({
        collection: slugs.jobs as CollectionSlug,
        depth: 1,
        id,
        overrideAccess: true,
        req,
        select: { expiresAt: true, status: true, tenant: true, viewDays: true, views: true } as never,
      })) as unknown as BeaconJob
    } catch {
      return json({ error: 'not_found' }, 404)
    }

    const tenant = tenantOf(job)

    // A site key only counts jobs of its own tenant; the aggregate key covers every tenant.
    if (!siteKey.isAggregate && tenant.id !== null && String(tenant.id) !== String(siteKey.tenantID)) {
      return json({ error: 'not_found' }, 404)
    }

    const day = viewDayKey(now, tenant.timezone)
    if (!isLive(job, now)) return json(viewsOn(job, day), 404)

    if (isBotUserAgent(req.headers?.get?.('user-agent'))) return json(viewsOn(job, day))

    const limiter = (typeof rateLimiter === 'function' ? rateLimiter(req) : rateLimiter) ?? defaultLimiter
    const { success } = await limiter.limit({ key: `job-view:${job.id}:${clientIP(req)}` })
    if (!success) return json(viewsOn(job, day), 429)

    const counted = countedViews(job, day)
    await req.payload.update({
      id: job.id,
      collection: slugs.jobs as CollectionSlug,
      context: { [JOB_VIEWS_CONTEXT]: true },
      data: { viewDays: counted.viewDays, views: counted.total },
      depth: 0,
      overrideAccess: true,
      req,
    })

    return json({ today: counted.today, total: counted.total })
  },
  method: 'post',
  path: JOB_VIEW_PATH,
})
