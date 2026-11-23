import { getPayload } from 'payload'

import { seedLegalPages } from '@mission-control/payload-jobs'

import { payloadJobsCollectionSlugs } from '../job-board-slugs'
import config from '../payload.config'

// mission-control: the tenant hook seeds a new site's privacy policy and terms (PJ-89), but
// vwok and Pacific Jobs were created before it. This backfills them as drafts; it is
// idempotent, so a page the site manager already edited is left alone.
if (process.env.SEED_LEGAL_PAGES_CONFIRM !== '1') {
  throw new Error(
    'Refusing to seed legal pages. Set SEED_LEGAL_PAGES_CONFIRM=1 for the intended database.',
  )
}

const scriptPath = process.argv.findIndex((arg) => /seed[/\\]legal-pages\.ts$/.test(arg))
const args = scriptPath === -1 ? [] : process.argv.slice(scriptPath + 1)

const slug = args[0] || process.env.SEED_LEGAL_PAGES_TENANT

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

  const blockSlugs = (payload.config.blocks ?? []).map((block) => block.slug)

  for (const tenant of docs) {
    if (tenant.isAggregate) {
      console.log(`${tenant.slug}: aggregate tenant, no pages`)
      continue
    }

    const created = await seedLegalPages(payload, {
      blockSlugs,
      collectionSlug: payloadJobsCollectionSlugs.pages,
      tenantID: tenant.id,
    })
    console.log(`${tenant.slug}: ${created.length} legal page(s) created`)
  }
} finally {
  await payload.destroy()
}
