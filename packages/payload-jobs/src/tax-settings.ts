import type { CollectionSlug, Field, Payload, PayloadRequest } from 'payload'

import {
  MAX_TAX_RATE_BASIS_POINTS,
  TAX_DISABLED,
  TAX_RATE_KEY_PATTERN,
  taxSettingsProblems,
  type TaxRate,
  type TaxRoundingMode,
  type TaxSettings,
} from './tax'

/**
 * Where a tenant's tax settings live: a `tax` group on the tenant (or on the single-tenant
 * settings global), next to the existing `taxLabel`. Tax is off until a tenant turns it on.
 */

type Sibling = { siblingData?: Record<string, unknown> }

type StoredRate = { key?: unknown; name?: unknown; rate?: unknown; xeroTaxType?: unknown }

const storedRates = (value: unknown): StoredRate[] => (Array.isArray(value) ? (value as StoredRate[]) : [])

const validateRateKeys = (value: unknown): string | true => {
  const keys = storedRates(value).map((rate) => rate?.key)
  if (keys.some((key) => typeof key !== 'string' || !TAX_RATE_KEY_PATTERN.test(key))) {
    return 'Each rate needs a key of lowercase letters, numbers and single hyphens, e.g. standard'
  }
  return new Set(keys).size === keys.length ? true : 'Each rate key must be different'
}

const validateRate = (value: null | number | undefined): string | true =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TAX_RATE_BASIS_POINTS
    ? true
    : `Use whole basis points from 0 to ${MAX_TAX_RATE_BASIS_POINTS}: 1500 is 15%, 1250 is 12.5%`

const validateDefaultRateKey = (value: null | string | undefined, { siblingData }: Sibling): string | true => {
  const keys = storedRates(siblingData?.rates).map((rate) => rate?.key)
  if (value === null || value === undefined || value === '') {
    return siblingData?.enabled === true && keys.length > 0 ? 'Pick the default rate' : true
  }
  return keys.includes(value) ? true : 'The default rate must be one of the rates above'
}

const validateEnabled = (value: unknown, { siblingData }: Sibling): string | true =>
  value === true && storedRates(siblingData?.rates).length === 0 ? 'Add a rate before turning tax on' : true

/** The `tax` group for the tenants collection and the single-tenant settings global. */
export const tenantTaxField = (condition?: (data: Record<string, unknown>) => boolean): Field => ({
  name: 'tax',
  type: 'group',
  admin: {
    ...(condition ? { condition } : {}),
    description: 'Tax on plans and add-ons. Off until turned on; the label above is shown on prices and invoices.',
  },
  fields: [
    {
      name: 'enabled',
      type: 'checkbox',
      defaultValue: false,
      validate: validateEnabled as never,
    },
    {
      name: 'pricesIncludeTax',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: 'On: prices include tax. Off: tax is added on top of prices.' },
    },
    {
      name: 'rounding',
      type: 'select',
      defaultValue: 'invoice',
      required: true,
      options: [
        { label: 'Per invoice (each rate rounded once on its total)', value: 'invoice' },
        { label: 'Per line', value: 'line' },
      ],
    },
    {
      name: 'rates',
      type: 'array',
      validate: validateRateKeys as never,
      fields: [
        { name: 'key', type: 'text', required: true },
        { name: 'name', type: 'text', required: true },
        {
          name: 'rate',
          type: 'number',
          required: true,
          validate: validateRate,
          admin: { description: 'Basis points: 1500 is 15%.', step: 1 },
        },
        { name: 'xeroTaxType', type: 'text', admin: { description: 'Xero tax type, e.g. OUTPUT.' } },
      ],
    },
    {
      name: 'defaultRateKey',
      type: 'text',
      validate: validateDefaultRateKey as never,
      admin: { description: 'The rate for plans and add-ons that name none.' },
    },
    {
      name: 'exemptXeroTaxType',
      type: 'text',
      admin: { description: 'Xero tax type for tax-exempt lines, e.g. EXEMPTOUTPUT.' },
    },
  ],
})

/** A tenant (or settings global) document, as far as tax is concerned. */
export type TenantTaxSource = {
  tax?: null | {
    defaultRateKey?: null | string
    enabled?: boolean | null
    exemptXeroTaxType?: null | string
    pricesIncludeTax?: boolean | null
    rates?: null | readonly StoredRate[]
    rounding?: null | string
  }
  taxLabel?: null | string
}

/**
 * The tax settings `quote()` reads, from a tenant document. A tenant that has never set tax up
 * is untaxed. Malformed stored values are passed through for `quote()` to reject, never guessed.
 */
export const tenantTaxSettings = (tenant: null | TenantTaxSource | undefined): TaxSettings => {
  const tax = tenant?.tax
  if (!tax) return { ...TAX_DISABLED, label: tenant?.taxLabel ?? null }

  return {
    defaultRateKey: tax.defaultRateKey || null,
    enabled: tax.enabled === true,
    exemptXeroTaxType: tax.exemptXeroTaxType || null,
    label: tenant?.taxLabel ?? null,
    pricesIncludeTax: tax.pricesIncludeTax === true,
    rates: storedRates(tax.rates).map(
      (rate): TaxRate => ({
        key: rate.key as string,
        name: rate.name as string,
        rate: rate.rate as number,
        xeroTaxType: typeof rate.xeroTaxType === 'string' && rate.xeroTaxType ? rate.xeroTaxType : null,
      }),
    ),
    rounding: (tax.rounding ?? 'invoice') as TaxRoundingMode,
  }
}

/**
 * A tenant's tax settings in a seed. `null` marks a value nobody has confirmed yet: the seed
 * refuses to run until every value is known, so a guessed rate can never reach a database.
 */
export type TaxSeed = {
  defaultRateKey: null | string
  enabled: boolean | null
  /** The Xero tax type for exempt lines; `null` only when nothing is exempt. */
  exemptXeroTaxType?: null | string
  pricesIncludeTax: boolean | null
  rates: { key: string; name: string; rate: null | number; xeroTaxType: null | string }[]
  rounding: null | TaxRoundingMode
}

export class TaxSeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaxSeedError'
  }
}

/** Problems with a tax seed, one message per problem; empty when it can run. */
export const taxSeedProblems = (seed: TaxSeed): string[] => {
  const problems: string[] = []
  if (seed.enabled === null) problems.push('whether tax is on is not confirmed')
  if (seed.pricesIncludeTax === null) problems.push('whether prices include tax is not confirmed')
  if (seed.rounding === null) problems.push('the rounding (per invoice or per line) is not confirmed')
  for (const rate of seed.rates) {
    if (rate.rate === null) problems.push(`rate "${rate.key}": the rate is not confirmed`)
    if (seed.enabled === true && rate.xeroTaxType === null) {
      problems.push(`rate "${rate.key}": the Xero tax type is not confirmed`)
    }
  }
  if (problems.length > 0) return problems

  return taxSettingsProblems({
    defaultRateKey: seed.defaultRateKey,
    enabled: seed.enabled as boolean,
    exemptXeroTaxType: seed.exemptXeroTaxType ?? null,
    pricesIncludeTax: seed.pricesIncludeTax as boolean,
    rates: seed.rates.map((rate) => ({ ...rate, rate: rate.rate as number })),
    rounding: seed.rounding as TaxRoundingMode,
  })
}

/**
 * Set a tenant's tax settings once. Create-only: a tenant that already has tax rates or has tax
 * turned on is left exactly as it is, so an admin's settings are never overwritten. Everything
 * is checked before the write.
 */
export const seedTenantTax = async ({
  payload,
  req,
  tax,
  tenantID,
  tenantsSlug = 'tenants',
}: {
  payload: Payload
  req?: Partial<PayloadRequest>
  tax: TaxSeed
  tenantID: number | string
  tenantsSlug?: string
}): Promise<{ applied: boolean }> => {
  const problems = taxSeedProblems(tax)
  if (problems.length > 0) throw new TaxSeedError(`Tax seed is not ready:\n- ${problems.join('\n- ')}`)

  const tenant = (await payload.findByID({
    collection: tenantsSlug as CollectionSlug,
    depth: 0,
    id: tenantID,
    overrideAccess: true,
    req,
  })) as TenantTaxSource
  if (tenant.tax?.enabled === true || (tenant.tax?.rates ?? []).length > 0) return { applied: false }

  await payload.update({
    collection: tenantsSlug as CollectionSlug,
    data: {
      tax: {
        defaultRateKey: tax.defaultRateKey,
        enabled: tax.enabled,
        exemptXeroTaxType: tax.exemptXeroTaxType ?? null,
        pricesIncludeTax: tax.pricesIncludeTax,
        rates: tax.rates,
        rounding: tax.rounding,
      },
    } as never,
    id: tenantID,
    overrideAccess: true,
    req,
  })
  return { applied: true }
}
