import type { CollectionSlug, Endpoint, PayloadRequest } from 'payload'

import { resolveSiteKey } from './site-keys'

/**
 * The tenant settings a public site renders with (PJ-37). A site has no user, and the `tenants`
 * collection is readable only by signed-in staff, so the site reads this projection instead of
 * the document: currency, locale, timezone, branding and the job-page rules, and nothing else.
 *
 * The list is an allowlist. Anything private (the admin email, the email sender, domains) stays
 * out, so adding a field to the tenant never exposes it by accident.
 */
export const PUBLIC_SITE_SETTINGS_FIELDS = [
  'branding',
  'currency',
  'currencyMinorUnits',
  'defaultLocale',
  'expiredJobGoneAfterMonths',
  'expiredJobMode',
  'locales',
  'name',
  'publicJobViews',
  'slug',
  'timezone',
] as const

export type PublicSiteSettings = {
  branding?: { colorAccent?: string; colorHover?: string; colorPrimary?: string; logo?: unknown }
  currency?: string
  currencyMinorUnits?: number
  defaultLocale?: string
  expiredJobGoneAfterMonths?: number
  expiredJobMode?: string
  /** Resolved slug of the jobs collection (PJ-80), so a site never hard-codes one. */
  jobsSlug?: string
  locales?: { locale?: string }[]
  name: string
  publicJobViews?: boolean
  slug: string
  timezone?: string
}

type TenantDoc = Record<string, unknown> & { id: number | string }

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : ''

  return trimmed || undefined
}

const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * One tenant document, reduced to the fields a site may read. A missing name or slug means the
 * document is not a tenant, so it is refused rather than half-rendered.
 */
export const publicSiteSettings = (tenant: TenantDoc): PublicSiteSettings | null => {
  const name = text(tenant.name)
  const slug = text(tenant.slug)
  if (!name || !slug) return null

  const branding = tenant.branding as PublicSiteSettings['branding'] | null | undefined
  const locales = Array.isArray(tenant.locales)
    ? (tenant.locales as { locale?: null | string }[])
        .map((row) => ({ locale: text(row?.locale) }))
        .filter((row): row is { locale: string } => Boolean(row.locale))
    : undefined

  return {
    ...(branding && typeof branding === 'object' ? { branding } : {}),
    ...(text(tenant.currency) ? { currency: text(tenant.currency) } : {}),
    ...(number(tenant.currencyMinorUnits) !== undefined
      ? { currencyMinorUnits: number(tenant.currencyMinorUnits) }
      : {}),
    ...(text(tenant.defaultLocale) ? { defaultLocale: text(tenant.defaultLocale) } : {}),
    ...(number(tenant.expiredJobGoneAfterMonths) !== undefined
      ? { expiredJobGoneAfterMonths: number(tenant.expiredJobGoneAfterMonths) }
      : {}),
    ...(text(tenant.expiredJobMode) ? { expiredJobMode: text(tenant.expiredJobMode) } : {}),
    ...(locales && locales.length > 0 ? { locales } : {}),
    name,
    ...(tenant.publicJobViews === true ? { publicJobViews: true } : {}),
    slug,
    ...(text(tenant.timezone) ? { timezone: text(tenant.timezone) } : {}),
  }
}

/** Path on the API root: `GET /api/site-settings`. */
export const SITE_SETTINGS_PATH = '/site-settings'

export type SiteSettingsEndpointOptions = {
  /** Resolved jobs slug, so the site can build the beacon URL without guessing it. */
  jobsSlug?: string
  tenantsSlug?: string
}

const respond = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  Response.json(body, {
    headers: { 'cache-control': 'public, max-age=60', ...headers },
    status,
  })

/**
 * `GET /api/site-settings` — the tenant's public settings for the site whose key made the call.
 *
 * The site key decides the tenant: a key reads its own tenant only, and the aggregate (hub) key
 * reads none, because these settings describe one site. A missing or unknown key is 401, so a
 * probe learns nothing about which sites exist.
 */
export const siteSettingsEndpoint = ({
  jobsSlug,
  tenantsSlug = 'tenants',
}: SiteSettingsEndpointOptions = {}): Endpoint => ({
  handler: async (req: PayloadRequest) => {
    const siteKey = await resolveSiteKey(req)
    if (!siteKey || siteKey.isAggregate) return respond({ error: 'invalid_site_key' }, 401)

    const result = await req.payload.find({
      collection: tenantsSlug as CollectionSlug,
      depth: 1,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req,
      where: { id: { equals: siteKey.tenantID } },
    })

    const tenant = result.docs[0] as TenantDoc | undefined
    if (!tenant) return respond({ error: 'not_found' }, 404)

    const settings = publicSiteSettings(tenant)
    if (!settings) return respond({ error: 'not_found' }, 404)

    return respond(jobsSlug ? { ...settings, jobsSlug } : settings, 200)
  },
  method: 'get',
  path: SITE_SETTINGS_PATH,
})
