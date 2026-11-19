import type { SiteTenant } from '../../src/tenant/types'
import type { FilterDefinition } from '../../src/tenant/filters'
import type { JobSummary, OrgSummary } from '../../src/types'
import type { ListingFacets, ListingJob } from '../../src/jobs/listing'

// Sample data for the demo build. A real site app loads the tenant from the CMS with its
// site key; none of this is tenant-specific code.
export const tenant: SiteTenant = {
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
    isVolunteer: true,
    jobType: 'Voluntary',
    location: 'Luganville, Vanuatu',
    organisation: { name: 'Santo Community Trust' },
    summary: 'Support a village water project for three months.',
    title: 'Water Project Volunteer',
    url: '/jobs/water-project-volunteer',
  },
  {
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
