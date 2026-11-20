import { getPayload } from 'payload'

import { seedVanuatuLocations } from '@mission-control/payload-jobs'

import config from '../payload.config'

if (process.env.SEED_LOCATIONS_CONFIRM !== '1') {
  throw new Error(
    'Refusing to seed locations. Set SEED_LOCATIONS_CONFIRM=1 for the intended database.',
  )
}

// `payload run <script> [args]` keeps the arguments after the script path. The seed writes the
// Vanuatu tree, so it needs the one tenant it is meant for: seeding every tenant would put
// Vanuatu places into a site that has nothing to do with them.
const scriptPath = process.argv.findIndex((arg) => /seed[/\\]locations\.ts$/.test(arg))
const args = scriptPath === -1 ? [] : process.argv.slice(scriptPath + 1)

const slug = args[0] || process.env.SEED_LOCATIONS_TENANT

if (!slug) {
  throw new Error('Name the tenant to seed, for example: pnpm seed:locations vwok')
}

const payload = await getPayload({ config })

try {
  const { docs } = await payload.find({
    collection: 'tenants',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: { slug: { equals: slug } },
  })

  const tenant = docs[0]
  if (!tenant) {
    throw new Error(`No tenant with the slug "${slug}"`)
  }
  if (tenant.isAggregate) {
    throw new Error(`The tenant "${slug}" is an aggregate and holds no content of its own`)
  }

  const result = await seedVanuatuLocations({
    log: (message) => console.log(`${tenant.slug}: ${message}`),
    payload,
    tenant: tenant.id,
  })

  console.log(`${tenant.slug}: ${result.created} created, ${result.updated} updated`)
} finally {
  await payload.destroy()
}
