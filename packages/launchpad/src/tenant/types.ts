/**
 * The parts of a tenant document that the theme reads. The type is deliberately structural:
 * it accepts a Payload tenant document at any depth, including `branding.logo` as an
 * unresolved id, and a plain object in tests and demos.
 */
export type TenantBranding = {
  colorAccent?: null | string
  colorHover?: null | string
  colorPrimary?: null | string
  logo?: null | TenantLogo
}

export type TenantLogo = {
  alt?: null | string
  height?: null | number
  url?: null | string
  width?: null | number
}

export type TenantDomain = string | { domain?: null | string }

export type SiteTenant = {
  branding?: null | TenantBranding
  /** ISO 4217 code. Money everywhere is an integer amount of minor units plus this code. */
  currency?: null | string
  currencyMinorUnits?: null | number
  defaultLocale?: null | string
  domains?: null | TenantDomain[]
  locales?: null | string[] | { locale?: null | string }[]
  name: string
  slug?: null | string
  timezone?: null | string
}
