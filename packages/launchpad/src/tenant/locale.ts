export type TenantLocaleSettings = {
  defaultLocale?: null | string
  locales?: null | string[] | { locale?: null | string }[]
}

/**
 * The site language: the tenant's default, then its first locale, then `en`. Payload stores
 * locales as rows (`{ locale: 'en' }`), while a test or demo may pass plain strings.
 */
export const resolveLocale = (tenant: TenantLocaleSettings): string => {
  const first = tenant.locales?.[0]
  const locale = typeof first === 'string' ? first : first?.locale
  return tenant.defaultLocale?.trim() || locale?.trim() || 'en'
}
