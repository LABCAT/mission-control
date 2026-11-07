import type { CollectionBeforeDeleteHook, CollectionConfig } from 'payload'

import { authenticatedAccess, superAdminAccess } from '@mission-control/payload-jobs'

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
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const validateCurrency = (value: null | string | undefined): string | true =>
  value && ISO_4217_CODES.has(value)
    ? true
    : 'Use an ISO 4217 currency code, for example VUV'

const validateHexColor = (value: null | string | undefined): string | true =>
  value && HEX_COLOR.test(value) ? true : 'Use a hex colour, for example #06914b'

const validateSlug = (value: null | string | undefined): string | true =>
  value && SLUG.test(value)
    ? true
    : 'Use lowercase letters, numbers and single hyphens, for example vanuatu-wok'

const validateTimezone = (value: null | string | undefined): string | true => {
  if (!value) return 'Timezone is required'

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return 'Use an IANA timezone, for example Pacific/Efate'
  }
}

const validateDefaultLocale = (
  value: null | string | undefined,
  options: { siblingData?: Record<string, unknown> },
): string | true => {
  if (!value) return 'Default locale is required'

  const locales = (options.siblingData?.locales ?? []) as { locale?: null | string }[]
  return locales.some((row) => row?.locale === value)
    ? true
    : 'Default locale must be one of the tenant locales'
}

type TenantMembership = { role?: unknown; tenant?: unknown }

/**
 * Remove user memberships before the tenant row is deleted. The users_tenants.tenant_id
 * column is NOT NULL, so the relationship's ON DELETE SET NULL would otherwise make a
 * tenant delete fail while memberships exist.
 */
export const removeTenantMemberships: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const users = await req.payload.find({
    collection: 'users',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      'tenants.tenant': {
        in: [id],
      },
    },
  })

  await Promise.all(
    users.docs.map((user) => {
      const memberships = (user as { tenants?: null | TenantMembership[] }).tenants ?? []

      return req.payload.update({
        id: user.id,
        collection: 'users',
        data: {
          tenants: memberships.filter((membership) => String(membership.tenant) !== String(id)),
        } as never,
        overrideAccess: true,
        req,
      })
    }),
  )
}

export const Tenants: CollectionConfig = {
  slug: 'tenants',
  admin: {
    defaultColumns: ['name', 'slug', 'isAggregate'],
    group: 'Tenants',
    useAsTitle: 'name',
  },
  access: {
    create: superAdminAccess,
    delete: superAdminAccess,
    read: authenticatedAccess,
    update: superAdminAccess,
  },
  hooks: {
    beforeDelete: [removeTenantMemberships],
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: validateSlug,
    },
    {
      name: 'domains',
      type: 'array',
      fields: [
        {
          name: 'domain',
          type: 'text',
          required: true,
        },
      ],
    },
    {
      name: 'isAggregate',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description: 'Aggregate tenants can read published content from every tenant.',
      },
    },
    {
      name: 'currency',
      type: 'text',
      required: true,
      validate: validateCurrency,
    },
    {
      name: 'currencyMinorUnits',
      type: 'number',
      required: true,
      min: 0,
      max: 3,
      validate: (value: null | number | undefined) =>
        value === null || value === undefined || Number.isInteger(value)
          ? true
          : 'Use a whole number of minor units',
      admin: {
        description: '0 for VUV, 2 for NZD, AUD, USD and most other currencies.',
        step: 1,
      },
    },
    {
      name: 'timezone',
      type: 'text',
      required: true,
      validate: validateTimezone,
    },
    {
      name: 'locales',
      type: 'array',
      minRows: 1,
      fields: [
        {
          name: 'locale',
          type: 'text',
          required: true,
        },
      ],
    },
    {
      name: 'defaultLocale',
      type: 'text',
      required: true,
      validate: validateDefaultLocale,
    },
    {
      name: 'taxLabel',
      type: 'text',
      required: true,
    },
    {
      name: 'emailFromName',
      type: 'text',
      required: true,
    },
    {
      name: 'emailFromAddress',
      type: 'email',
      required: true,
    },
    {
      name: 'adminEmail',
      type: 'email',
      required: true,
    },
    {
      name: 'branding',
      type: 'group',
      fields: [
        {
          name: 'logo',
          type: 'upload',
          relationTo: 'media',
        },
        {
          name: 'colorPrimary',
          type: 'text',
          required: true,
          validate: validateHexColor,
        },
        {
          name: 'colorAccent',
          type: 'text',
          required: true,
          validate: validateHexColor,
        },
        {
          name: 'colorHover',
          type: 'text',
          required: true,
          validate: validateHexColor,
        },
      ],
    },
  ],
  versions: false,
}
