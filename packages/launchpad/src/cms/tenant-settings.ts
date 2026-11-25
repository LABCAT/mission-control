/**
 * The site's own settings from the CMS (PJ-37).
 *
 * A site key cannot read the `tenants` collection (it is staff-only), so the site reads the
 * projection the plugin exposes at `GET /api/tenant-settings` instead: currency, locale,
 * timezone, branding and the job-page rules, and nothing private.
 */
import type { TenantJobPageSource } from '../tenant/job-page-settings'
import type { SiteTenant } from '../tenant/types'
import type { CmsTenantSettings } from './client'

/**
 * The tenant a page renders for: the site's own settings over the app's branding fallback. A
 * field the CMS leaves empty keeps the app's value, so a half-configured tenant still renders,
 * and a site with no settings at all falls back to its branding alone.
 */
export const tenantFromSettings = (
  settings: CmsTenantSettings | null | undefined,
  fallback: SiteTenant,
): SiteTenant & TenantJobPageSource => {
  if (!settings) return fallback

  return {
    ...fallback,
    ...(settings.allowAiCrawlers === false ? { allowAiCrawlers: false } : {}),
    ...(settings.branding ? { branding: { ...fallback.branding, ...settings.branding } } : {}),
    ...(settings.currency ? { currency: settings.currency } : {}),
    ...(typeof settings.currencyMinorUnits === 'number'
      ? { currencyMinorUnits: settings.currencyMinorUnits }
      : {}),
    ...(settings.defaultLocale ? { defaultLocale: settings.defaultLocale } : {}),
    ...(typeof settings.expiredJobGoneAfterMonths === 'number'
      ? { expiredJobGoneAfterMonths: settings.expiredJobGoneAfterMonths }
      : {}),
    ...(settings.expiredJobMode ? { expiredJobMode: settings.expiredJobMode } : {}),
    ...(settings.locales ? { locales: settings.locales } : {}),
    ...(settings.publicJobViews === true ? { publicJobViews: true } : {}),
    name: settings.name?.trim() || fallback.name,
    ...(settings.timezone ? { timezone: settings.timezone } : {}),
  }
}
