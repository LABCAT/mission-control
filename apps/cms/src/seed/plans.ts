import { getPayload } from 'payload'

import { seedPlans } from '@mission-control/payload-jobs'

import config from '../payload.config'
import { vwokPlans } from './vwok-plans'

/**
 * Seed a tenant's plans: `SEED_PLANS_CONFIRM=1 SEED_PLANS_TENANT=vwok pnpm seed:plans`.
 * Idempotent: existing plans (same key or legacyId) are never changed.
 */
const seeds = { vwok: vwokPlans }

if (process.env.SEED_PLANS_CONFIRM !== '1') {
  throw new Error('Refusing to seed plans. Set SEED_PLANS_CONFIRM=1 for the intended database.')
}

const tenantSlug = process.env.SEED_PLANS_TENANT ?? 'vwok'
const plans = seeds[tenantSlug as keyof typeof seeds]
if (!plans) throw new Error(`No plan seed for tenant "${tenantSlug}"`)

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

  const result = await seedPlans({ payload, plans, tenantID: tenant.id })
  payload.logger.info(
    `Plans for ${tenantSlug}: created [${result.created.join(', ')}], kept [${result.existing.join(', ')}]`,
  )
} finally {
  await payload.destroy()
}
