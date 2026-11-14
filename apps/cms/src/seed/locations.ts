import { getPayload } from 'payload'

import { seedVanuatuLocations } from '@mission-control/payload-jobs'

import config from '../payload.config'

if (process.env.SEED_LOCATIONS_CONFIRM !== '1') {
  throw new Error(
    'Refusing to seed locations. Set SEED_LOCATIONS_CONFIRM=1 for the intended database.',
  )
}

const payload = await getPayload({ config })

const { docs: tenants } = await payload.find({
  collection: 'tenants',
  depth: 0,
  overrideAccess: true,
  pagination: false,
  where: { isAggregate: { equals: false } },
})

for (const tenant of tenants) {
  const result = await seedVanuatuLocations({
    log: (message) => console.log(`${tenant.slug}: ${message}`),
    payload,
    tenant: tenant.id,
  })

  console.log(`${tenant.slug}: ${result.created} created, ${result.updated} updated`)
}

await payload.destroy()
