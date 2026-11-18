import type { SiteTenant } from '../../src/tenant/types'
import type { FilterDefinition } from '../../src/tenant/filters'
import type { JobSummary, OrgSummary } from '../../src/types'

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
