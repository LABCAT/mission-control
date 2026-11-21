import { getPayload } from 'payload'

import { seedAddOns, seedPlans, seedTenantTax } from '@mission-control/payload-jobs'
import { seedXeroSettings } from '@mission-control/payload-jobs-xero'

import config from '../payload.config'
import { vwokAddOns } from './vwok-add-ons'
import { vwokPlans } from './vwok-plans'
import { vwokTax } from './vwok-tax'
import { vwokXero } from './vwok-xero'

/**
 * Seed a tenant's tax settings, add-ons, then plans (plans and add-ons name tax rates, and plans
 * include add-ons), then its Xero settings (PJ-57):
 * `SEED_PLANS_CONFIRM=1 SEED_PLANS_TENANT=vwok pnpm seed:plans`.
 * Idempotent: tax settings already set, existing add-ons and plans (same key or legacy id), and
 * an existing Xero settings row are never changed.
 */
const seeds = { vwok: { addOns: vwokAddOns, plans: vwokPlans, tax: vwokTax, xero: vwokXero } }

if (process.env.SEED_PLANS_CONFIRM !== '1') {
  throw new Error('Refusing to seed plans. Set SEED_PLANS_CONFIRM=1 for the intended database.')
}

const tenantSlug = process.env.SEED_PLANS_TENANT ?? 'vwok'
const seed = seeds[tenantSlug as keyof typeof seeds]
if (!seed) throw new Error(`No plan seed for tenant "${tenantSlug}"`)

const payload = await getPayload({ config })

try {
  const { docs } = await payload.find({
    collection: 'tenants',
    limit: 1,
    overrideAccess: true,
    where: { slug: { equals: tenantSlug } },
  })
  const tenant = docs[0]
  if (!tenant) throw new Error(`Tenant "${tenantSlug}" not found. Run seed:tenants first.`)

  // Each seed checks all its data before writing; each step needs the one before it.
  const tax = await seedTenantTax({ payload, tax: seed.tax, tenantID: tenant.id })
  payload.logger.info(`Tax for ${tenantSlug}: ${tax.applied ? 'set' : 'already set, kept'}`)
  const addOns = await seedAddOns({ addOns: seed.addOns, payload, tenantID: tenant.id })
  payload.logger.info(
    `Add-ons for ${tenantSlug}: created [${addOns.created.join(', ')}], kept [${addOns.existing.join(', ')}]`,
  )
  const plans = await seedPlans({ payload, plans: seed.plans, tenantID: tenant.id })
  payload.logger.info(
    `Plans for ${tenantSlug}: created [${plans.created.join(', ')}], kept [${plans.existing.join(', ')}]`,
  )
  const xero = await seedXeroSettings({ payload, seed: seed.xero, tenantID: tenant.id })
  payload.logger.info(`Xero settings for ${tenantSlug}: ${xero.applied ? 'set' : 'already set, kept'}`)
} finally {
  await payload.destroy()
}
