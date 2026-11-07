import type { Field, GlobalConfig } from 'payload'

import { authenticatedAccess, superAdminAccess } from './access'

// Current ISO 4217 list one from SIX (the maintenance agency), fetched 2026-11-06.
const ISO_4217_CODES = new Set(
  `AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BOV BRL BSD BTN BWP
  BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB
  EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD
  JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP
  MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR
  RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND
  TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAD XAF XAG XAU XBA
  XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG`
    .trim()
    .split(/\s+/),
)

type ValidationOptions = {
  siblingData?: Record<string, unknown>
}

const isAggregate = (siblingData?: Record<string, unknown>): boolean =>
  siblingData?.isAggregate === true

const requiredUnlessAggregate = (
  value: unknown,
  options: ValidationOptions,
  message: string,
): string | true =>
  isAggregate(options.siblingData) || (value !== null && value !== undefined && value !== '')
    ? true
    : message

const validateLocales = (value: unknown, options: ValidationOptions): string | true => {
  if (isAggregate(options.siblingData)) return true
  return Array.isArray(value) && value.length > 0 ? true : 'Add at least one locale'
}

export const validateCurrency = (
  value: null | string | undefined,
  options: ValidationOptions = {},
): string | true => {
  if (isAggregate(options.siblingData)) return true
  if (!value) return 'Currency is required'

  return ISO_4217_CODES.has(value)
    ? true
    : 'Use an ISO 4217 currency code, for example VUV'
}

const validateCurrencyMinorUnits = (
  value: null | number | undefined,
  options: ValidationOptions,
): string | true => {
  if (isAggregate(options.siblingData)) return true
  if (value === null || value === undefined) return 'Currency minor units are required'
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    return 'Use a whole number of minor units between 0 and 3'
  }
  return true
}

const validateTimezone = (
  value: null | string | undefined,
  options: ValidationOptions,
): string | true => {
  if (isAggregate(options.siblingData)) return true
  if (!value) return 'Timezone is required'

  try {
    Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return 'Use an IANA timezone, for example Pacific/Efate'
  }
}

const validateDefaultLocale = (
  value: null | string | undefined,
  options: ValidationOptions,
): string | true => {
  if (isAggregate(options.siblingData)) return true
  if (!value) return 'Default locale is required'

  const locales = (options.siblingData?.locales ?? []) as { locale?: null | string }[]
  return locales.some((row) => row?.locale === value)
    ? true
    : 'Default locale must be one of the tenant locales'
}

const showForSiteTenant = (data: Record<string, unknown>): boolean => data?.isAggregate !== true

/**
 * Job-board settings for a tenant. In multi-tenant mode these fields are appended to the
 * host's `tenants` collection; in single-tenant mode they back the `job-board-settings` global.
 * Aggregate tenants (the hub) intentionally leave them empty.
 *
 * `locales` is an array so one tenant can serve several locales later; today Vanuatu Wok uses
 * `['en']` only. Localization of job-board content is a later task, not a limitation here.
 */
export const jobBoardTenantFields: Field[] = [
  {
    name: 'currency',
    type: 'text',
    admin: {
      condition: showForSiteTenant,
      description: 'ISO 4217 code for prices and orders on this tenant.',
    },
    validate: validateCurrency,
  },
  {
    name: 'currencyMinorUnits',
    type: 'number',
    min: 0,
    max: 3,
    admin: {
      condition: showForSiteTenant,
      description: '0 for VUV, 2 for NZD, AUD, USD and most other currencies.',
      step: 1,
    },
    validate: validateCurrencyMinorUnits,
  },
  {
    name: 'timezone',
    type: 'text',
    admin: {
      condition: showForSiteTenant,
      description: 'IANA timezone used for job expiry and scheduled jobs.',
    },
    validate: validateTimezone,
  },
  {
    name: 'locales',
    type: 'array',
    // Avoid the `tenants_locales` table name: Payload mistakes that for its localized-fields
    // table and adds an `_locales` relation that does not exist.
    dbName: 'tenant_locale_list',
    admin: {
      condition: showForSiteTenant,
      description: 'One or more locales for this tenant. Add more when the site is translated.',
    },
    fields: [
      {
        name: 'locale',
        type: 'text',
        required: true,
      },
    ],
    validate: validateLocales,
  },
  {
    name: 'defaultLocale',
    type: 'text',
    admin: {
      condition: showForSiteTenant,
    },
    validate: validateDefaultLocale,
  },
  {
    name: 'taxLabel',
    type: 'text',
    admin: {
      condition: showForSiteTenant,
      description: 'Shown on prices and invoices, for example VAT.',
    },
    validate: (value: null | string | undefined, options: ValidationOptions) =>
      requiredUnlessAggregate(value, options, 'Tax label is required'),
  },
  {
    name: 'emailFromName',
    type: 'text',
    admin: {
      condition: showForSiteTenant,
    },
    validate: (value: null | string | undefined, options: ValidationOptions) =>
      requiredUnlessAggregate(value, options, 'Email sender name is required'),
  },
  {
    name: 'emailFromAddress',
    type: 'email',
    admin: {
      condition: showForSiteTenant,
    },
    validate: (value: null | string | undefined, options: ValidationOptions) =>
      requiredUnlessAggregate(value, options, 'Email sender address is required'),
  },
  {
    name: 'adminEmail',
    type: 'email',
    admin: {
      condition: showForSiteTenant,
      description: 'Receives contact and moderation notifications.',
    },
    validate: (value: null | string | undefined, options: ValidationOptions) =>
      requiredUnlessAggregate(value, options, 'Admin email is required'),
  },
]

export const jobBoardSettingsGlobal = (slug = 'job-board-settings'): GlobalConfig => ({
  slug,
  admin: {
    group: 'Settings',
  },
  access: {
    read: authenticatedAccess,
    update: superAdminAccess,
  },
  fields: jobBoardTenantFields,
  versions: false,
})
