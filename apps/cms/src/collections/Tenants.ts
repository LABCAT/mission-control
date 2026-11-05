import type { CollectionConfig } from 'payload'

import { authenticatedAccess, superAdminAccess } from '@mission-control/payload-jobs'

const ISO_4217 = /^[A-Z]{3}$/
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const validateCurrency = (value: null | string | undefined): string | true =>
  value && ISO_4217.test(value) ? true : 'Use a three-letter ISO 4217 currency code, for example VUV'

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
