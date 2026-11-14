import type { CollectionConfig, Config, Field } from 'payload'
import { describe, expect, it } from 'vitest'

import { payloadJobs } from './index'
import { jobBoardTenantFields, validateCurrency } from './tenancy'

const tenants: CollectionConfig = {
  slug: 'tenants',
  fields: [{ name: 'name', type: 'text' }],
}

const baseConfig = {
  collections: [tenants],
  globals: [],
} as unknown as Config

const fieldNamed = (name: string): Field => {
  const field = jobBoardTenantFields.find((candidate) => 'name' in candidate && candidate.name === name)
  if (!field) throw new Error(`Missing ${name}`)
  return field
}

const validate = (name: string, value: unknown, siblingData: Record<string, unknown> = {}) =>
  (fieldNamed(name) as { validate: (value: unknown, options: unknown) => unknown }).validate(
    value,
    { siblingData },
  )

describe('payloadJobs tenancy modes', () => {
  it('adds the job-board settings to the tenants collection in multi mode', async () => {
    const result = await payloadJobs({ tenancy: 'multi' })(baseConfig)
    const fields = result.collections
      ?.find((collection) => collection.slug === 'tenants')
      ?.fields.map((field) => ('name' in field ? field.name : ''))

    expect(fields).toEqual(
      expect.arrayContaining([
        'currency',
        'currencyMinorUnits',
        'timezone',
        'locales',
        'defaultLocale',
        'taxLabel',
        'emailFromName',
        'emailFromAddress',
        'adminEmail',
      ]),
    )
    expect(result.custom?.payloadJobs).toEqual({
      enabled: true,
      features: { applications: true, alerts: true, credits: true, coupons: true },
      tenancy: 'multi',
    })
  })

  it('adds the per-tenant slug index in multi mode only', async () => {
    const multi = await payloadJobs({ tenancy: 'multi' })(baseConfig)
    const multiIndexes = multi.collections?.find(
      (collection) => collection.slug === 'locations',
    )?.indexes

    expect(multiIndexes).toEqual([{ fields: ['tenant', 'slug'], unique: true }])

    const single = await payloadJobs()(baseConfig)
    expect(
      single.collections?.find((collection) => collection.slug === 'locations')?.indexes,
    ).toBeUndefined()
  })

  it('adds a job-board-settings global in single mode', async () => {
    const result = await payloadJobs()(baseConfig)

    expect(result.globals?.[0]?.slug).toBe('job-board-settings')
    expect(result.globals?.[0]?.fields.map((field) => ('name' in field ? field.name : ''))).toEqual(
      expect.arrayContaining(['currency', 'timezone', 'locales', 'emailFromAddress']),
    )
    expect(result.custom?.payloadJobs).toEqual({
      enabled: true,
      features: { applications: true, alerts: true, credits: true, coupons: true },
      tenancy: 'single',
    })

    const updateAccess = result.globals?.[0]?.access?.update
    expect(updateAccess).toBeTypeOf('function')
    if (!updateAccess) throw new Error('Missing global update access')
    expect(await updateAccess({ req: { user: { role: 'user' } } } as never)).toBe(false)
    expect(await updateAccess({ req: { user: { role: 'super-admin' } } } as never)).toBe(true)
  })

  it('fails with a clear error when multi mode has no tenants collection', () => {
    expect(() => payloadJobs({ tenancy: 'multi' })({ collections: [] } as unknown as Config)).toThrow(
      'requires a "tenants" collection',
    )
  })
})

describe('job-board tenant settings', () => {
  it('accepts current ISO 4217 currency codes and rejects unknown codes', () => {
    expect(validateCurrency('VUV')).toBe(true)
    expect(validateCurrency('CHE')).toBe(true)
    expect(validateCurrency('ZZZ')).toBe('Use an ISO 4217 currency code, for example VUV')
    expect(validateCurrency(null)).toBe('Currency is required')
  })

  it('allows an aggregate tenant to omit every site setting', () => {
    const aggregate = { isAggregate: true }

    expect(validateCurrency(undefined, { siblingData: aggregate })).toBe(true)
    expect(validate('timezone', undefined, aggregate)).toBe(true)
    expect(validate('locales', [], aggregate)).toBe(true)
    expect(validate('defaultLocale', undefined, aggregate)).toBe(true)
    expect(validate('taxLabel', undefined, aggregate)).toBe(true)
    expect(validate('adminEmail', undefined, aggregate)).toBe(true)
  })

  it('requires the settings for a non-aggregate tenant', () => {
    expect(validateCurrency(undefined, { siblingData: { isAggregate: false } })).toBe('Currency is required')
    expect(validate('timezone', undefined)).toBe('Timezone is required')
    expect(validate('locales', [])).toBe('Add at least one locale')
    expect(validate('defaultLocale', undefined)).toBe('Default locale is required')
    expect(validate('taxLabel', undefined)).toBe('Tax label is required')
    expect(validate('adminEmail', undefined)).toBe('Admin email is required')
  })
})
