import type { CollectionConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection } from './add-ons'
import { jobsCollection } from './collections/jobs'
import { locationsCollection } from './collections/locations'
import { organisationField, organisationsCollection } from './collections/organisations'
import { planCollection } from './plans'
import { resolvePayloadJobsSlugs } from './slugs'
import { taxonomyCollections } from './taxonomies'
import { bootTestPayload, type TestHarness } from './test'

/**
 * The plugin's build-time test only proves the config points at overridden slugs. This boots a
 * Payload instance with every slug renamed, then creates documents through those relations, so
 * a literal slug left in a hook or query fails here instead of on an installer's site.
 */
const overrides = {
  addOns: { slug: 'extras' },
  jobCategories: { slug: 'categories' },
  jobs: { slug: 'vacancies' },
  jobTypes: { slug: 'employment-types' },
  locations: { slug: 'job-locations' },
  organisations: { slug: 'employers' },
  plans: { slug: 'packages' },
  salaryBands: { slug: 'salaries' },
} as const

const slugs = resolvePayloadJobsSlugs(overrides)

const collections = (): CollectionConfig[] => [
  locationsCollection({ requireTenant: true, slug: slugs.locations }),
  organisationsCollection({
    mediaSlug: null,
    locationsSlug: slugs.locations,
    slug: slugs.organisations,
    tenantScoped: true,
  }),
  ...taxonomyCollections({ slugs, tenantScoped: true }),
  planCollection({ slugs, tenantScoped: true }),
  addOnCollection({ slugs, tenantScoped: true }),
  jobsCollection({ slugs, tenantScoped: true }),
]

describe('every collection slug overridden', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: collections(),
      tenantData: () => ({ currency: 'VUV' }),
      tenantFields: [{ name: 'currency', type: 'text' }],
      userFields: [organisationField(true, slugs.organisations)],
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('creates and resolves every relationship under the overridden slugs', async () => {
    const { payload, tenantA } = harness
    const create = async (collection: string, data: Record<string, unknown>) =>
      (await payload.create({
        collection,
        data: { ...data, tenant: tenantA.id },
        overrideAccess: true,
      })) as { id: number }

    const location = await create(slugs.locations, {
      kind: 'region',
      name: 'Shefa',
      slug: 'shefa',
    })
    const organisation = await create(slugs.organisations, {
      location: location.id,
      name: 'Vanuatu Health',
      slug: 'vanuatu-health',
    })
    const jobType = await create(slugs.jobTypes, { name: 'Full time', slug: 'full-time' })
    const category = await create(slugs.jobCategories, { name: 'Health', slug: 'health' })
    const salaryBand = await create(slugs.salaryBands, { name: 'Vt 1–2m', slug: 'vt-1-2m' })
    const addOn = await create(slugs.addOns, {
      durationDays: 30,
      key: 'enhanced',
      name: 'Enhanced',
      placement: 'featured-in-listings',
      price: 1000,
    })
    const plan = await create(slugs.plans, {
      allowedJobCategories: [category.id],
      allowedJobTypes: [jobType.id],
      durationDays: 30,
      includedAddOns: [{ addOn: addOn.id }],
      key: 'regular',
      name: 'Regular',
      price: 5000,
    })

    const job = await create(slugs.jobs, {
      categories: [category.id],
      jobType: jobType.id,
      location: [location.id],
      organisation: organisation.id,
      plan: plan.id,
      salaryBand: salaryBand.id,
      title: 'Community nurse',
    })

    const stored = (await payload.findByID({
      collection: slugs.jobs,
      depth: 0,
      id: job.id,
      overrideAccess: true,
    })) as Record<string, unknown>

    expect(stored).toMatchObject({
      categories: [category.id],
      jobType: jobType.id,
      location: [location.id],
      organisation: organisation.id,
      plan: plan.id,
      salaryBand: salaryBand.id,
    })
    expect(payload.collections[slugs.jobs]).toBeDefined()
    expect(payload.collections['jobs']).toBeUndefined()
  })
})
