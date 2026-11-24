import type { TenantJobPageSource } from '../../src/tenant/job-page-settings'
import type { SiteTenant } from '../../src/tenant/types'
import type { FilterDefinition } from '../../src/tenant/filters'
import type { JobSummary, OrgSummary } from '../../src/types'
import type { DetailJob } from '../../src/jobs/detail'
import type { ListingFacets, ListingJob } from '../../src/jobs/listing'

// Sample data for the demo build. A real site app loads the tenant from the CMS with its
// site key; none of this is tenant-specific code.
export const tenant: SiteTenant & TenantJobPageSource = {
  branding: {
    colorAccent: '#dd3333',
    colorHover: '#b02a2a',
    colorPrimary: '#06914b',
  },
  currency: 'VUV',
  currencyMinorUnits: 0,
  defaultLocale: 'en',
  domains: ['vanuatuwok.vu'],
  locales: ['en'],
  name: 'Vanuatu Wok',
  // The demo turns the public view counter on, so the build exercises the beacon and its script.
  publicJobViews: true,
  slug: 'vwok',
  timezone: 'Pacific/Efate',
}

export const definitions: FilterDefinition[] = [
  { name: 'q' },
  { allowed: ['hospitality', 'trades'], name: 'category' },
  { allowed: ['luganville', 'port-vila'], name: 'location' },
  { name: 'page' },
]

export const jobs: JobSummary[] = [
  {
    closes: '2026-12-01',
    featured: true,
    id: 1,
    jobType: 'Full time',
    location: 'Port Vila, Vanuatu',
    organisation: { name: 'Vanuatu Wok', url: '/organisations/vanuatu-wok' },
    salary: { amountMinor: 150000, currency: 'VUV', minorUnits: 0, period: 'month' },
    summary: 'Run the kitchen at a waterfront restaurant in Port Vila.',
    title: 'Head Chef',
    url: '/jobs/head-chef',
  },
  {
    closes: '2026-11-30',
    id: 2,
    isVolunteer: true,
    jobType: 'Voluntary',
    location: 'Luganville, Vanuatu',
    organisation: { name: 'Santo Community Trust' },
    summary: 'Support a village water project for three months.',
    title: 'Water Project Volunteer',
    url: '/jobs/water-project-volunteer',
  },
  {
    id: 3,
    jobType: 'Part time',
    location: 'Port Vila, Vanuatu',
    organisation: { name: 'Blue Lagoon Tours', url: '/organisations/blue-lagoon-tours' },
    salary: { amountMinor: 90000, currency: 'VUV', minorUnits: 0, period: 'month' },
    summary: 'Greet guests and run the booking desk.',
    title: 'Booking Clerk',
    url: '/jobs/booking-clerk',
  },
]

export const organisations: OrgSummary[] = [
  {
    description: 'Restaurants and catering across Efate.',
    jobCount: 4,
    location: 'Port Vila',
    name: 'Vanuatu Wok',
    url: '/organisations/vanuatu-wok',
  },
  {
    description: 'Community projects on Espiritu Santo.',
    jobCount: 1,
    location: 'Luganville',
    name: 'Santo Community Trust',
    url: '/organisations/santo-community-trust',
  },
  {
    description: 'Day tours around Efate.',
    jobCount: 0,
    location: 'Port Vila',
    name: 'Blue Lagoon Tours',
    url: '/organisations/blue-lagoon-tours',
  },
]

// The tenant's taxonomies, as the listing's filter controls and query would receive them.
export const facets: ListingFacets = {
  categories: [
    { id: 1, name: 'Hospitality', slug: 'hospitality' },
    { id: 2, name: 'Trades', slug: 'trades' },
  ],
  locations: [
    { id: 10, name: 'Vanuatu', parentID: null, slug: 'vanuatu' },
    { id: 11, name: 'Efate', parentID: 10, slug: 'efate' },
    { id: 12, name: 'Port Vila', parentID: 11, slug: 'port-vila' },
    { id: 13, name: 'Espiritu Santo', parentID: 10, slug: 'espiritu-santo' },
    { id: 14, name: 'Luganville', parentID: 13, slug: 'luganville' },
  ],
  types: [
    { id: 20, isVolunteer: false, name: 'Full time', slug: 'full-time' },
    { id: 21, isVolunteer: false, name: 'Part time', slug: 'part-time' },
    { id: 22, isVolunteer: true, name: 'Voluntary', slug: 'voluntary' },
  ],
}

// Jobs as the CMS returns them: relationships populated at depth 2, `slug` and `expiresAt` set.
export const listingJobs: ListingJob[] = [
  {
    categories: [facets.categories[0]!],
    companyName: 'Vanuatu Wok',
    displayedSalary: 'Vt 150,000 a month',
    expiresAt: '2026-12-01',
    id: 101,
    jobType: facets.types[0]!,
    location: facets.locations[2]!,
    organisation: { id: 201, name: 'Vanuatu Wok', slug: 'vanuatu-wok' },
    slug: 'head-chef',
    title: 'Head Chef',
  },
  {
    categories: [facets.categories[0]!],
    companyName: 'Santo Community Trust',
    expiresAt: '2026-11-30',
    id: 102,
    jobType: facets.types[2]!,
    location: facets.locations[4]!,
    organisation: { id: 202, name: 'Santo Community Trust', slug: 'santo-community-trust' },
    slug: 'water-project-volunteer',
    title: 'Water Project Volunteer',
  },
  {
    categories: [facets.categories[1]!],
    companyName: 'Blue Lagoon Tours',
    expiresAt: '2026-12-15',
    id: 103,
    jobType: facets.types[1]!,
    location: facets.locations[2]!,
    organisation: { id: 203, name: 'Blue Lagoon Tours', slug: 'blue-lagoon-tours' },
    slug: 'booking-clerk',
    title: 'Booking Clerk',
  },
]

// The job documents the detail page reads: refs populated, a description, and one closed job so
// the demo builds the notice page too. `expiresAt` is fixed and compared with the demo clock.
export const detailJobs: DetailJob[] = [
  {
    ...(listingJobs[0] as DetailJob),
    description: { root: { children: [] } },
    displayedSalary: 'Vt 150,000 a month',
    howToApply: 'Send a CV to the restaurant in Port Vila.',
    jobDescriptionPdf: { filename: 'head-chef.pdf', url: '/jobs/head-chef.pdf' },
    locationDetails: 'Waterfront',
    organisation: { approved: true, id: 201, name: 'Vanuatu Wok', pageEnabled: true, slug: 'vanuatu-wok' },
    publishedAt: '2026-10-01T00:00:00.000Z',
    salaryBand: { id: 30, name: 'Vt 100,000–200,000', slug: 'vt-100k-200k' },
    status: 'published',
  },
  {
    ...(listingJobs[1] as DetailJob),
    description: { root: { children: [] } },
    organisation: { id: 202, name: 'Santo Community Trust', slug: 'santo-community-trust' },
    publishedAt: '2026-10-01T00:00:00.000Z',
    status: 'published',
  },
  {
    ...(listingJobs[2] as DetailJob),
    description: { root: { children: [] } },
    organisation: { approved: true, id: 203, name: 'Blue Lagoon Tours', pageEnabled: true, slug: 'blue-lagoon-tours' },
    publishedAt: '2026-10-01T00:00:00.000Z',
    status: 'published',
  },
  {
    categories: [facets.categories[0]!],
    companyName: 'Vanuatu Wok',
    description: { root: { children: [] } },
    expiresAt: '2026-09-01',
    id: 104,
    jobType: facets.types[0]!,
    location: facets.locations[2]!,
    organisation: { approved: true, id: 201, name: 'Vanuatu Wok', pageEnabled: true, slug: 'vanuatu-wok' },
    publishedAt: '2026-08-01T00:00:00.000Z',
    slug: 'sous-chef',
    status: 'expired',
    title: 'Sous Chef',
  },
]
