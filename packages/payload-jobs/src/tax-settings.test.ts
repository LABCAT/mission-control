import type { CollectionConfig, Field } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection, ADD_ONS_SLUG } from './add-ons'
import { planCollection, PLANS_SLUG, withPlanRestrictionGuards } from './plans'
import { PlanSeedError, seedPlans } from './plans-seed'
import { quote, type QuotableAddOn, type QuotablePlan } from './pricing'
import { seedTenantTax, TaxSeedError, taxSeedProblems, tenantTaxField, tenantTaxSettings, type TaxSeed } from './tax-settings'
import { taxonomyCollections } from './taxonomies'
import { bootTestPayload, type TestHarness, type TestTenant } from './test'

const tenantFields: Field[] = [
  { name: 'currency', type: 'text' },
  { name: 'isAggregate', type: 'checkbox', defaultValue: false },
  { name: 'taxLabel', type: 'text' },
  tenantTaxField(),
]

const collections = (): CollectionConfig[] => [
  planCollection(),
  addOnCollection(),
  ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
]

const VAT = {
  defaultRateKey: 'vat',
  enabled: true,
  exemptXeroTaxType: 'EXEMPTOUTPUT',
  pricesIncludeTax: false,
  rates: [
    { key: 'vat', name: 'VAT', rate: 1500, xeroTaxType: 'OUTPUT' },
    { key: 'zero', name: 'Zero rated', rate: 0, xeroTaxType: 'ZERORATEDOUTPUT' },
  ],
  rounding: 'invoice',
}

const confirmedSeed: TaxSeed = {
  defaultRateKey: 'vat',
  enabled: true,
  exemptXeroTaxType: 'EXEMPTOUTPUT',
  pricesIncludeTax: false,
  rates: [{ key: 'vat', name: 'VAT', rate: 1500, xeroTaxType: 'OUTPUT' }],
  rounding: 'invoice',
}

describe('tenant tax settings', () => {
  let harness: TestHarness
  const extraTenantIDs: number[] = []

  const makeTenant = async (data: Record<string, unknown> = {}): Promise<TestTenant> => {
    const doc = (await harness.payload.create({
      collection: 'tenants',
      data: {
        currency: 'VUV',
        name: 'Tax tenant',
        slug: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        taxLabel: 'VAT',
        ...data,
      },
      overrideAccess: true,
    })) as TestTenant
    extraTenantIDs.push(doc.id)
    return doc
  }

  const setTax = (tenantID: number, tax: Record<string, unknown>) =>
    harness.payload.update({ collection: 'tenants', data: { tax }, id: tenantID, overrideAccess: true })

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: collections(),
      tenantData: () => ({ currency: 'VUV', taxLabel: 'VAT' }),
      tenantFields,
    })
  })

  afterAll(async () => {
    if (!harness) return
    const { payload } = harness
    await payload.delete({ collection: PLANS_SLUG, overrideAccess: true, where: { id: { exists: true } } })
    await payload.delete({ collection: ADD_ONS_SLUG, overrideAccess: true, where: { id: { exists: true } } })
    if (extraTenantIDs.length) {
      await payload.delete({ collection: 'tenants', overrideAccess: true, where: { id: { in: extraTenantIDs } } })
    }
    await harness.destroy()
  })

  it('leaves a new tenant untaxed', async () => {
    const tenant = await makeTenant()
    const stored = await harness.payload.findByID({ collection: 'tenants', id: tenant.id, overrideAccess: true })

    expect(tenantTaxSettings(stored as never)).toMatchObject({ enabled: false, label: 'VAT', rates: [] })
  })

  it('refuses settings that could not price anything', async () => {
    const tenant = await makeTenant()

    for (const bad of [
      { ...VAT, rates: [] }, // on, but no rates
      { ...VAT, defaultRateKey: 'standard' }, // default isn't a rate
      { ...VAT, defaultRateKey: null }, // on, with rates, but no default
      { ...VAT, rates: [VAT.rates[0], { ...VAT.rates[1], key: 'vat' }] }, // duplicate key
      { ...VAT, rates: [{ ...VAT.rates[0], rate: 15.5 }] }, // not basis points
      { ...VAT, rates: [{ ...VAT.rates[0], key: 'Standard VAT' }] }, // not a key
    ]) {
      await expect(setTax(tenant.id, bad)).rejects.toThrow()
    }
  })

  it('stores a usable configuration, and quote() taxes stored plans and add-ons with it', async () => {
    const tenant = await makeTenant()
    await setTax(tenant.id, VAT)

    const plan = (await harness.payload.create({
      collection: PLANS_SLUG,
      data: { durationDays: 30, jobCredits: 1, key: 'regular', name: 'Regular', price: 5000, tenant: tenant.id },
      overrideAccess: true,
    })) as unknown as QuotablePlan
    const zeroRated = (await harness.payload.create({
      collection: ADD_ONS_SLUG,
      data: {
        durationDays: 30,
        key: 'enhanced',
        name: 'Enhanced',
        placement: 'featured-in-listings',
        price: 2000,
        taxRateKey: 'zero',
        tenant: tenant.id,
      },
      overrideAccess: true,
    })) as unknown as QuotableAddOn

    const stored = await harness.payload.findByID({ collection: 'tenants', id: tenant.id, overrideAccess: true })
    const result = quote({ addOns: [zeroRated], currency: 'VUV', plan, tax: tenantTaxSettings(stored as never) })

    expect(result.lines.map((line) => [line.net, line.tax, line.xeroTaxType])).toEqual([
      [5000, 750, 'OUTPUT'],
      [2000, 0, 'ZERORATEDOUTPUT'],
    ])
    expect(result.total).toBe(7750)
    expect(result.tax.label).toBe('VAT')
  })

  it('refuses a plan or add-on naming a rate its tenant does not have', async () => {
    const tenant = await makeTenant()
    await setTax(tenant.id, VAT)

    await expect(
      harness.payload.create({
        collection: PLANS_SLUG,
        data: { durationDays: 30, key: 'ghost-rate', name: 'Ghost', price: 1, taxRateKey: 'ghost', tenant: tenant.id },
        overrideAccess: true,
      }),
    ).rejects.toThrow()
    await expect(
      harness.payload.create({
        collection: ADD_ONS_SLUG,
        data: {
          durationDays: 1,
          key: 'ghost-rate',
          name: 'Ghost',
          placement: 'featured-in-listings',
          price: 1,
          taxRateKey: 'ghost',
          tenant: tenant.id,
        },
        overrideAccess: true,
      }),
    ).rejects.toThrow()
  })

  describe('seed', () => {
    it('refuses to run while a value is unconfirmed, and writes nothing', async () => {
      const tenant = await makeTenant()
      const pending: TaxSeed = { ...confirmedSeed, enabled: null, rates: [{ ...confirmedSeed.rates[0], rate: null }] }

      expect(taxSeedProblems(pending)).toEqual([
        'whether tax is on is not confirmed',
        'rate "vat": the rate is not confirmed',
      ])
      await expect(seedTenantTax({ payload: harness.payload, tax: pending, tenantID: tenant.id })).rejects.toThrow(
        TaxSeedError,
      )
      const stored = await harness.payload.findByID({ collection: 'tenants', id: tenant.id, overrideAccess: true })
      expect(tenantTaxSettings(stored as never).rates).toEqual([])
    })

    it('sets tax once and never overwrites an admin’s settings', async () => {
      const tenant = await makeTenant()

      expect(await seedTenantTax({ payload: harness.payload, tax: confirmedSeed, tenantID: tenant.id })).toEqual({
        applied: true,
      })
      await setTax(tenant.id, { ...VAT, rounding: 'line' })
      expect(await seedTenantTax({ payload: harness.payload, tax: confirmedSeed, tenantID: tenant.id })).toEqual({
        applied: false,
      })

      const stored = await harness.payload.findByID({ collection: 'tenants', id: tenant.id, overrideAccess: true })
      expect(tenantTaxSettings(stored as never)).toMatchObject({ rounding: 'line' })
    })

    it('refuses a plan seed naming a tax rate the tenant lacks, before writing anything', async () => {
      const tenant = await makeTenant()
      await setTax(tenant.id, VAT)
      const plan = { durationDays: 30, jobCredits: 1, key: 'fine', name: 'Fine', price: 1, sortOrder: 1 }

      await expect(
        seedPlans({
          payload: harness.payload,
          plans: [plan, { ...plan, key: 'bad', taxRateKey: 'ghost' }],
          tenantID: tenant.id,
        }),
      ).rejects.toThrow(PlanSeedError)
      const { totalDocs } = await harness.payload.count({
        collection: PLANS_SLUG,
        overrideAccess: true,
        where: { tenant: { equals: tenant.id } },
      })
      expect(totalDocs).toBe(0)
    })
  })
})
