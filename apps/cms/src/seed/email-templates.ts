import { getPayload } from 'payload'

import { seedEmailTemplates } from '@mission-control/payload-jobs'

import config from '../payload.config'

if (process.env.SEED_EMAIL_TEMPLATES_CONFIRM !== '1') {
  throw new Error(
    'Refusing to seed email templates. Set SEED_EMAIL_TEMPLATES_CONFIRM=1 for the intended database.',
  )
}

const payload = await getPayload({ config })

try {
  const { docs: tenants } = await payload.find({
    collection: 'tenants',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    sort: 'id',
  })

  if (tenants.length === 0) {
    throw new Error('No tenants found. Seed the tenants first (pnpm seed:tenants).')
  }

  for (const tenant of tenants) {
    const { created, skipped } = await seedEmailTemplates({ payload, tenantID: tenant.id })

    console.log(
      `email templates for tenant ${String(tenant.id)}: created ${created.length}, kept ${skipped.length}`,
    )
  }
} finally {
  await payload.destroy()
}
