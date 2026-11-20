/**
 * The demo's listing data. A site app calls `loadJobListing` against the CMS; the demo calls the
 * same function against an in-memory CMS holding its sample rows, so the demo exercises the real
 * filters, the real live-jobs rule and the real mapping. The pages add the path's filter
 * (`locked`) and render the view.
 */
import type { CmsClient } from '../../src/cms/client'
import { loadJobListing, type JobListingView } from '../../src/jobs/listing'
import { createDemoCms } from './cms'
import { facets, listingJobs, tenant } from './data'
import type { FilterValues } from '../../src/tenant/filters'

const taxonomyRows = (facet: { id: number; name: string; slug: string }) => facet

const cms = createDemoCms({
  'job-categories': facets.categories.map(taxonomyRows),
  'job-types': facets.types.map((type) => ({ isVolunteer: type.isVolunteer, ...taxonomyRows(type) })),
  jobs: listingJobs.map((job) => ({
    ...job,
    publishedAt: '2026-05-01T00:00:00.000Z',
    status: 'published',
  })),
  locations: facets.locations.map((location) => ({
    ...taxonomyRows(location),
    parent: location.parentID,
  })),
})

// The demo CMS holds sample rows, not the generated Payload documents, so it is narrowed to the
// two read methods `loadJobListing` uses.
const readOnlyCms = cms as unknown as Pick<CmsClient, 'find' | 'findAll'>

// Fixed, so the demo build does not start showing an empty listing once the sample jobs expire.
const DEMO_NOW = new Date('2026-11-01T00:00:00.000Z')

/**
 * The view for `basePath`, with the route's own filter applied and the path's query string
 * honoured. `now` is fixed: a static demo must not empty out on a date.
 */
export const demoListing = async (input: {
  basePath: string
  locked?: FilterValues
  search?: string
}): Promise<JobListingView> => {
  const result = await loadJobListing({
    basePath: input.basePath,
    cms: readOnlyCms,
    locked: input.locked,
    now: DEMO_NOW,
    search: input.search ?? '',
    tenant,
  })

  if (!result.found) throw new Error(`demo: unknown section at ${input.basePath}`)

  return result.view
}

export { facets, tenant }
