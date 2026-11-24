import { getPayload } from 'payload'

import { seedContactPage } from '@mission-control/payload-jobs'

import { FORMS_SLUG } from '../forms'
import { payloadJobsCollectionSlugs } from '../job-board-slugs'
import config from '../payload.config'
import { vwokContact } from './vwok-contact'

if (process.env.SEED_CONTACT_CONFIRM !== '1') {
  throw new Error('Refusing to seed the contact page. Set SEED_CONTACT_CONFIRM=1 for the intended database.')
}

// mission-control: the contact page is two generic blocks (PJ-102). Idempotent, so re-running
// after an editor changed the page only adds a block that is missing.
const tenantSlug = process.env.SEED_CONTACT_TENANT ?? 'vwok'
const seeds = { vwok: vwokContact }
const seed = seeds[tenantSlug as keyof typeof seeds]
if (!seed) throw new Error(`No contact page seed for tenant "${tenantSlug}"`)

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

  const result = await seedContactPage(payload, {
    formsSlug: FORMS_SLUG,
    pagesSlug: payloadJobsCollectionSlugs.pages,
    seed,
    tenantID: tenant.id,
  })

  console.log(
    `${tenantSlug}: contact form ${result.formCreated ? 'created' : 'kept'}, ` +
      `blocks added [${result.blocksAdded.join(', ')}]`,
  )
} finally {
  await payload.destroy()
}
