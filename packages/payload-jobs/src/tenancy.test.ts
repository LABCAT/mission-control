import type { CollectionConfig, Config, Field } from 'payload'
import { describe, expect, it } from 'vitest'

import { payloadJobs } from './index'
import { DEFAULT_PAYLOAD_JOBS_SLUGS } from './slugs'
import { jobBoardTenantFields, validateCurrency } from './tenancy'

const tenants: CollectionConfig = {
  slug: 'tenants',
  fields: [{ name: 'name', type: 'text' }],
}

const baseConfig = {
  collections: [tenants],
  globals: [],
} as unknown as Config

const users: CollectionConfig = { slug: 'users', auth: { verify: true }, fields: [] }

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
    const result = await payloadJobs({ accountAuth: false, tenancy: 'multi' })(baseConfig)
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
      features: { applications: true, credits: true, coupons: true, pages: true },
      paymentProviders: ['invoice'],
      registry: expect.any(Object),
      slugs: { ...DEFAULT_PAYLOAD_JOBS_SLUGS, tenants: 'tenants' },
      tenancy: 'multi',
    })
  })

  it('adds the per-tenant slug index in multi mode only', async () => {
    const multi = await payloadJobs({ accountAuth: false, tenancy: 'multi' })(baseConfig)
    const multiIndexes = multi.collections?.find(
      (collection) => collection.slug === 'locations',
    )?.indexes

    expect(multiIndexes).toEqual([{ fields: ['tenant', 'slug'], unique: true }])

    const single = await payloadJobs()(baseConfig)
    expect(
      single.collections?.find((collection) => collection.slug === 'locations')?.indexes,
    ).toBeUndefined()
  })

  it('adds the account auth and checkout endpoints to the tenants collection in multi mode @S-152', async () => {
    const result = await payloadJobs({ tenancy: 'multi' })({
      collections: [tenants, users],
    } as unknown as Config)
    const endpoints = result.collections?.find((collection) => collection.slug === 'tenants')
      ?.endpoints

    expect(Array.isArray(endpoints)).toBe(true)
    expect(
      (endpoints as { method: string; path: string }[]).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      'post /:slug/account/login',
      'post /:slug/account/logout',
      'get /:slug/account/me',
      'post /:slug/account/forgot-password',
      'post /:slug/account/reset-password',
      'post /:slug/account/register',
      'post /:slug/account/verify-email',
      'post /:slug/account/view-as/redeem',
      'post /:slug/account/view-as/exit',
      // Checkout for the /account dashboard (PJ-31).
      'post /:slug/account/checkout/quote',
      'post /:slug/account/checkout',
      'post /:slug/account/orders/:id/approve',
      'post /:slug/account/orders/:id/decline',
    ])
    // Payload routes /api/tenants/* to the collection's endpoints, so nothing tenant-specific goes
    // at the root: the only root endpoint is the site's own settings read (PJ-37).
    expect(result.endpoints?.map((endpoint) => endpoint.path)).toEqual(['/tenant-settings'])
  })

  it('leaves the account auth endpoints out when asked', async () => {
    const result = await payloadJobs({ accountAuth: false, tenancy: 'multi' })({
      collections: [tenants],
    } as unknown as Config)

    expect(result.collections?.[0]?.endpoints).toEqual([])
  })

  it('refuses account auth when the users collection does not verify email', () => {
    expect(() =>
      payloadJobs({ tenancy: 'multi' })({
        collections: [tenants, { slug: 'users', auth: true, fields: [] }],
      } as unknown as Config),
    ).toThrow('auth.verify')
  })

  it('adds a job-board-settings global in single mode', async () => {
    const result = await payloadJobs()(baseConfig)

    expect(result.globals?.[0]?.slug).toBe('job-board-settings')
    expect(result.globals?.[0]?.fields.map((field) => ('name' in field ? field.name : ''))).toEqual(
      expect.arrayContaining(['currency', 'timezone', 'locales', 'emailFromAddress']),
    )
    expect(result.custom?.payloadJobs).toEqual({
      enabled: true,
      features: { applications: true, credits: true, coupons: true, pages: true },
      paymentProviders: ['invoice'],
      registry: expect.any(Object),
      slugs: { ...DEFAULT_PAYLOAD_JOBS_SLUGS, tenants: 'tenants' },
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
