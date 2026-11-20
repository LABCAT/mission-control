import { getPayload } from 'payload'

import { seedSystemPages } from '@mission-control/payload-jobs'

import config from '../payload.config'

if (process.env.SEED_PAGES_CONFIRM !== '1') {
  throw new Error('Refusing to seed pages. Set SEED_PAGES_CONFIRM=1 for the intended database.')
}

// mission-control: the tenant hook seeds a new site (PJ-103), but vwok and Pacific Jobs were
// created before pages existed. This backfills them; it is idempotent, so it is safe to re-run.
const scriptPath = process.argv.findIndex((arg) => /seed[/\\]system-pages\.ts$/.test(arg))
const args = scriptPath === -1 ? [] : process.argv.slice(scriptPath + 1)

const slug = args[0] || process.env.SEED_PAGES_TENANT

const payload = await getPayload({ config })

try {
  const { docs } = await payload.find({
    collection: 'tenants',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    ...(slug ? { where: { slug: { equals: slug } } } : {}),
  })

  if (docs.length === 0) throw new Error(`No tenant with the slug "${slug}"`)

  for (const tenant of docs) {
    if (tenant.isAggregate) {
      console.log(`${tenant.slug}: aggregate tenant, no pages`)
      continue
    }

    const created = await seedSystemPages(payload, { tenantID: tenant.id })
    console.log(`${tenant.slug}: ${created.length} page(s) created`)
  }
} finally {
  await payload.destroy()
}
