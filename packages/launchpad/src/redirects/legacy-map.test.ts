import { describe, expect, it } from 'vitest'

import {
  defaultLegacyRoutePaths,
  FEED_JOBS,
  FEED_VOLUNTARY_JOBS,
  isLegacyListingQuery,
  legacyListingQuery,
  legacyRedirect,
  normaliseLegacyPath,
  type LegacyTarget,
} from './legacy-map'
import { legacySlug, organisationSlug } from './slug'

/** The target's location, or the failure that it is not a redirect. */
const locationOf = (target: LegacyTarget | null): string => {
  expect(target?.kind).toBe('redirect')
  return (target as Extract<LegacyTarget, { kind: 'redirect' }>).location
}

const statusOf = (target: LegacyTarget | null): number => {
  expect(target).not.toBeNull()
  return (target as LegacyTarget).status
}

describe('legacySlug @S-350', () => {
  it('produces the shape Payload’s slug validator accepts @S-350', () => {
    expect(legacySlug('Trades & Services')).toBe('trades-services')
    expect(legacySlug('Non Government Organisation (NGO)')).toBe('non-government-organisation-ngo')
    expect(legacySlug('Construction & roading')).toBe('construction-roading')
    expect(legacySlug('MASON（BRICKLAYER / BRICKMASON）')).toBe('mason-bricklayer-brickmason')
  })

  it('strips accents and macrons rather than deleting the letter @S-350', () => {
    expect(legacySlug('Vendeur, Préparateur')).toBe('vendeur-preparateur')
    expect(legacySlug('Ē')).toBe('e')
  })

  it('returns an empty string when nothing usable is left @S-350', () => {
    expect(legacySlug('   ')).toBe('')
    expect(legacySlug('---')).toBe('')
  })

  it('reads an organisation nickname as the importer wrote its slug @S-350', () => {
    // The nickname used `-` where the name had a space, and kept the brackets.
    expect(organisationSlug('bred-bank-(vanuatu)-limited')).toBe('bred-bank-vanuatu-limited')
    expect(organisationSlug('83-islands-distillery')).toBe('83-islands-distillery')
    expect(organisationSlug('wanfuteng-bank')).toBe('wanfuteng-bank')
  })
})

describe('normaliseLegacyPath @S-350', () => {
  it('drops the query, the trailing slash and empty segments @S-350', () => {
    expect(normaliseLegacyPath('/jobs/?s=chef').path).toBe('/jobs')
    expect(normaliseLegacyPath('//about-us//').path).toBe('/about-us')
    expect(normaliseLegacyPath('/').path).toBe('/')
    expect(normaliseLegacyPath('').path).toBe('/')
  })

  it('decodes a percent-encoded segment @S-350', () => {
    expect(normaliseLegacyPath('/jobs/mason%ef%bc%88bricklayer%ef%bc%89/').segments).toEqual([
      'jobs',
      'mason（bricklayer）',
    ])
  })

  it('keeps a malformed escape as typed so the lookup misses @S-350', () => {
    expect(normaliseLegacyPath('/jobs/%zz/').segments).toEqual(['jobs', '%zz'])
  })
})

describe('legacyRedirect: job taxonomies → clean filter URLs @S-351', () => {
  it('maps a job category to /jobs/{category} @S-351', () => {
    expect(locationOf(legacyRedirect({ pathname: '/job-category/trades-services/' }))).toBe(
      '/jobs/trades-services',
    )
    expect(locationOf(legacyRedirect({ pathname: '/job-category/non-government-organisation-ngo' }))).toBe(
      '/jobs/non-government-organisation-ngo',
    )
  })

  it('maps a job type to /jobs/{type} @S-351', () => {
    expect(locationOf(legacyRedirect({ pathname: '/job-type/full-time/' }))).toBe('/jobs/full-time')
    expect(locationOf(legacyRedirect({ pathname: '/job-type/not-stated/' }))).toBe('/jobs/not-stated')
  })

  it('uses the deepest segment of a nested job type @S-351', () => {
    // `voluntary` was a parent term; `board-position` is the type a job actually has.
    expect(locationOf(legacyRedirect({ pathname: '/job-type/voluntary/board-position/' }))).toBe(
      '/jobs/board-position',
    )
    expect(locationOf(legacyRedirect({ pathname: '/job-type/voluntary/internship-voluntary/' }))).toBe(
      '/jobs/internship-voluntary',
    )
  })

  it('maps a salary band to the listing’s salary query @S-351', () => {
    expect(locationOf(legacyRedirect({ pathname: '/job-salary/not-stated/' }))).toBe('/jobs?salary=not-stated')
    expect(locationOf(legacyRedirect({ pathname: '/job-salary/4000000-or-more/' }))).toBe(
      '/jobs?salary=4000000-or-more',
    )
  })

  it('falls back to the listing when a taxonomy path carries no slug @S-351', () => {
    expect(locationOf(legacyRedirect({ pathname: '/job-category/' }))).toBe('/jobs')
    expect(locationOf(legacyRedirect({ pathname: '/job-type/' }))).toBe('/jobs')
    expect(locationOf(legacyRedirect({ pathname: '/job-salary/' }))).toBe('/jobs')
  })

  it('keeps a taxonomy feed on its taxonomy page @S-351', () => {
    expect(locationOf(legacyRedirect({ pathname: '/job-category/education/feed/' }))).toBe('/jobs/education')
    expect(locationOf(legacyRedirect({ pathname: '/job-type/contract/feed/' }))).toBe('/jobs/contract')
    expect(locationOf(legacyRedirect({ pathname: '/job-salary/not-stated/feed/' }))).toBe(
      '/jobs?salary=not-stated',
    )
  })

  it('takes the paths a site overrides, so a filter page can move without touching a rule @S-351', () => {
    const paths = {
      ...defaultLegacyRoutePaths,
      category: (slug: string) => `/jobs/category/${slug}`,
      type: (slug: string) => `/jobs/type/${slug}`,
    }
    expect(locationOf(legacyRedirect({ pathname: '/job-category/it/' }, { paths }))).toBe('/jobs/category/it')
    expect(locationOf(legacyRedirect({ pathname: '/job-type/casual/' }, { paths }))).toBe('/jobs/type/casual')
  })
})

describe('legacyRedirect: organisations and authors @S-352', () => {
  it('maps an organisation nickname to its new slug @S-352', () => {
    expect(locationOf(legacyRedirect({ pathname: '/organisation/giz/' }))).toBe('/organisations/giz')
    expect(locationOf(legacyRedirect({ pathname: '/organisation/bred-bank-(vanuatu)-limited/' }))).toBe(
      '/organisations/bred-bank-vanuatu-limited',
    )
  })

  it('maps an author archive to the organisation it belongs to @S-352', () => {
    expect(locationOf(legacyRedirect({ pathname: '/author/vanuatu-brewing-ltd/' }))).toBe(
      '/organisations/vanuatu-brewing-ltd',
    )
  })

  it('maps an organisation feed to that organisation’s page @S-352', () => {
    expect(locationOf(legacyRedirect({ pathname: '/organisation/oxfam/feed/' }))).toBe('/organisations/oxfam')
  })

  it('sends a bare organisation or author path to the directory @S-352', () => {
    expect(locationOf(legacyRedirect({ pathname: '/organisation/' }))).toBe('/organisations')
    expect(locationOf(legacyRedirect({ pathname: '/author/' }))).toBe('/organisations')
  })
})

describe('legacyRedirect: retired pages are 410 @S-353', () => {
  it('answers 410 for the CV module, every level of it @S-353', () => {
    for (const path of [
      '/resumes/',
      '/resumes/page/2/',
      '/resumes/feed/',
      '/resumes/some-seeker-cv/',
      '/resumes/skills/plumbing/',
      '/resumes/location/port-vila/',
    ]) {
      expect(statusOf(legacyRedirect({ pathname: path })), path).toBe(410)
    }
  })

  it('answers 410 for the pages the founder did not carry over @S-353', () => {
    for (const path of [
      '/land-law-reforms/',
      '/organisation-competition/',
      '/job-email-text/',
      '/no-resumes/',
    ]) {
      const target = legacyRedirect({ pathname: path })
      expect(target, path).toMatchObject({ kind: 'gone', status: 410 })
    }
  })

  it('answers 410 for the attachments on a retired page @S-353', () => {
    expect(statusOf(legacyRedirect({ pathname: '/land-law-reforms/press-release-lands-reforms-_compressed/' }))).toBe(
      410,
    )
    expect(
      statusOf(legacyRedirect({ pathname: '/organisation-competition/screen-shot-2020-06-19-at-4-08-42-pm/' })),
    ).toBe(410)
  })

  it('answers 410 for the XML-RPC endpoint, which has no successor @S-353', () => {
    expect(statusOf(legacyRedirect({ pathname: '/wp/xmlrpc.php' }))).toBe(410)
  })
})

describe('legacyRedirect: pages and WordPress machinery @S-354', () => {
  it('sends every /wp/ URL to the home page except XML-RPC @S-354', () => {
    expect(locationOf(legacyRedirect({ pathname: '/wp/jobs/' }))).toBe('/')
    expect(locationOf(legacyRedirect({ pathname: '/wp/rss-feed/' }))).toBe('/')
    expect(locationOf(legacyRedirect({ pathname: '/wp/wp-login.php' }))).toBe('/')
  })

  it('maps a legacy page whose new address differs @S-354', () => {
    expect(locationOf(legacyRedirect({ pathname: '/about-us/' }))).toBe('/about')
    expect(locationOf(legacyRedirect({ pathname: '/contact-2/' }))).toBe('/contact')
    expect(locationOf(legacyRedirect({ pathname: '/employer/' }))).toBe('/employers')
  })

  it('maps the legacy account pages onto the dashboard @S-354', () => {
    expect(locationOf(legacyRedirect({ pathname: '/login/' }))).toBe('/account/login')
    expect(locationOf(legacyRedirect({ pathname: '/register/' }))).toBe('/account/register')
    expect(locationOf(legacyRedirect({ pathname: '/dashboard/' }))).toBe('/account')
    expect(locationOf(legacyRedirect({ pathname: '/my-profile/' }))).toBe('/account')
    expect(locationOf(legacyRedirect({ pathname: '/edit-job/' }))).toBe('/account')
    expect(locationOf(legacyRedirect({ pathname: '/password-recovery/' }))).toBe('/account')
  })

  it('collapses the duplicate home and sample pages onto / @S-354', () => {
    expect(locationOf(legacyRedirect({ pathname: '/home-2/' }))).toBe('/')
    expect(locationOf(legacyRedirect({ pathname: '/sample-page/' }))).toBe('/')
    expect(locationOf(legacyRedirect({ pathname: '/blog/' }))).toBe('/')
  })

  it('maps a site feed to the job feed route @S-354', () => {
    expect(locationOf(legacyRedirect({ pathname: '/feed/' }))).toBe(FEED_JOBS)
    expect(locationOf(legacyRedirect({ pathname: '/rss-feed/' }))).toBe(FEED_JOBS)
    expect(locationOf(legacyRedirect({ pathname: '/jobs/feed/' }))).toBe(FEED_JOBS)
  })

  it('maps the volunteer feed to the voluntary feed route @S-354', () => {
    expect(locationOf(legacyRedirect({ pathname: '/volunteer-jobs/rss-feed/' }))).toBe(FEED_VOLUNTARY_JOBS)
  })

  it('leaves a page that has its own new route to that route @S-354', () => {
    // `/organisations/`, `/terms-conditions/` and `/volunteer-jobs/` are imported pages.
    expect(legacyRedirect({ pathname: '/organisations/' })).toBeNull()
    expect(legacyRedirect({ pathname: '/terms-conditions/' })).toBeNull()
    expect(legacyRedirect({ pathname: '/volunteer-jobs/' })).toBeNull()
    // `/contact/` is the seeded Contact page, not a legacy address needing a hop.
    expect(legacyRedirect({ pathname: '/contact/' })).toBeNull()
  })
})

describe('legacyRedirect: job archive and pagination @S-355', () => {
  it('leaves the job archive and a job page to their own routes @S-355', () => {
    expect(legacyRedirect({ pathname: '/jobs/' })).toBeNull()
    expect(legacyRedirect({ pathname: '/jobs' })).toBeNull()
    expect(legacyRedirect({ pathname: '/jobs/executive-chef-16/' })).toBeNull()
  })

  it('drops page 1 and keeps a later page @S-355', () => {
    expect(locationOf(legacyRedirect({ pathname: '/jobs/page/1/' }))).toBe('/jobs')
    expect(locationOf(legacyRedirect({ pathname: '/jobs/page/2/' }))).toBe('/jobs?page=2')
  })

  it('sends a job attachment page to the file on R2, or 410 when it was not imported @S-355', () => {
    // A job attachment page is a file, not a page (STATUS.md 20 Nov). The file table is the media
    // import's output, so it is passed in; an id it does not know was not imported.
    const files = new Map([[141642, 'https://media.example.com/t1-abc-welder-2.pdf']])

    expect(locationOf(legacyRedirect({ pathname: '/jobs/welder-2/attachment/141642/' }, { attachments: files }))).toBe(
      'https://media.example.com/t1-abc-welder-2.pdf',
    )
    expect(statusOf(legacyRedirect({ pathname: '/jobs/welder-2/attachment/141642/' }))).toBe(410)
    expect(statusOf(legacyRedirect({ pathname: '/jobs/welder-2/attachment/999999/' }, { attachments: files }))).toBe(410)
  })

  it('sends a legacy upload to its R2 copy, and 410 when it was not imported @S-355', () => {
    const files = new Map([['/app/uploads/2021/05/booklet.pdf', 'https://media.example.com/t1-abc-booklet.pdf']])

    expect(locationOf(legacyRedirect({ pathname: '/app/uploads/2021/05/booklet.pdf' }, { files }))).toBe(
      'https://media.example.com/t1-abc-booklet.pdf',
    )
    expect(statusOf(legacyRedirect({ pathname: '/app/uploads/2021/05/booklet.pdf' }))).toBe(410)
  })

  it('sends anything else nested under a job to the job page @S-355', () => {
    expect(locationOf(legacyRedirect({ pathname: '/jobs/welder-2/iiss-logo/' }))).toBe('/jobs/welder-2')
  })

  it('sends a job feed to the job page @S-355', () => {
    expect(locationOf(legacyRedirect({ pathname: '/jobs/enumerator/feed/' }))).toBe('/jobs/enumerator')
  })
})

describe('legacy search query strings @S-356', () => {
  it('recognises the legacy archive’s own parameters @S-356', () => {
    expect(isLegacyListingQuery(new URLSearchParams('s=chef'))).toBe(true)
    expect(isLegacyListingQuery(new URLSearchParams('location=Port+Vila'))).toBe(true)
    expect(isLegacyListingQuery(new URLSearchParams('full-time=show&action=Filter'))).toBe(true)
    expect(isLegacyListingQuery(new URLSearchParams('time=week&jobs_by_date=1'))).toBe(true)
    expect(isLegacyListingQuery(new URLSearchParams('radius=10'))).toBe(true)
  })

  it('does not treat a modern filter or a tracking tag as a legacy search @S-356', () => {
    expect(isLegacyListingQuery(new URLSearchParams('q=chef'))).toBe(false)
    expect(isLegacyListingQuery(new URLSearchParams('utm_source=newsletter'))).toBe(false)
    expect(isLegacyListingQuery(new URLSearchParams(''))).toBe(false)
  })

  it('maps the keyword to q @S-356', () => {
    expect(legacyListingQuery(new URLSearchParams('s=chef'))).toBe('q=chef')
  })

  it('slugs the free-text location @S-356', () => {
    expect(legacyListingQuery(new URLSearchParams('location=Port+Vila'))).toBe('location=port-vila')
  })

  it('turns a job-type checkbox into the listing’s type @S-356', () => {
    expect(legacyListingQuery(new URLSearchParams('full-time=show&action=Filter'))).toBe('type=full-time')
    expect(legacyListingQuery(new URLSearchParams('contract=show&action=Filter'))).toBe('type=contract')
  })

  it('drops the date window, the action and unknown parameters @S-356', () => {
    expect(legacyListingQuery(new URLSearchParams('time=week&jobs_by_date=1'))).toBe('')
    expect(legacyListingQuery(new URLSearchParams('s=chef&utm_source=x&foo=bar'))).toBe('q=chef')
    expect(legacyListingQuery(new URLSearchParams('radius=25&s=nurse'))).toBe('q=nurse')
  })

  it('redirects a legacy search on /jobs/ to the new filter URL @S-356', () => {
    expect(locationOf(legacyRedirect({ pathname: '/jobs/', search: '?s=chef' }))).toBe('/jobs?q=chef')
    expect(locationOf(legacyRedirect({ pathname: '/jobs/', search: '?s=chef&location=Port+Vila' }))).toBe(
      '/jobs?q=chef&location=port-vila',
    )
    expect(locationOf(legacyRedirect({ pathname: '/jobs', search: '?full-time=show&action=Filter' }))).toBe(
      '/jobs?type=full-time',
    )
  })

  it('redirects a legacy search at the root, where JobRoller also served it @S-356', () => {
    expect(locationOf(legacyRedirect({ pathname: '/', search: '?s=teacher' }))).toBe('/jobs?q=teacher')
  })

  it('redirects the job-date-archive window to the listing @S-356', () => {
    expect(locationOf(legacyRedirect({ pathname: '/job-date-archive/' }))).toBe('/jobs')
    expect(locationOf(legacyRedirect({ pathname: '/job-date-archive/', search: '?time=week&jobs_by_date=1' }))).toBe(
      '/jobs',
    )
  })

  it('leaves the home page alone when the query is not a search @S-356', () => {
    expect(legacyRedirect({ pathname: '/', search: '?utm_source=x' })).toBeNull()
  })
})

describe('legacyRedirect: ?p= shortlinks @S-357', () => {
  const shortlinks = new Map([
    [10, '/terms-conditions'],
    [3983, '/about'],
    [140040, '/jobs/experienced-chef-bar-kitchen-reception-office'],
  ])

  it('sends a known shortlink to its post @S-357', () => {
    expect(locationOf(legacyRedirect({ pathname: '/', search: '?p=10' }, { shortlinks }))).toBe('/terms-conditions')
    expect(locationOf(legacyRedirect({ pathname: '/', search: '?p=140040' }, { shortlinks }))).toBe(
      '/jobs/experienced-chef-bar-kitchen-reception-office',
    )
  })

  it('answers 410 for an id the site did not carry over @S-357', () => {
    expect(statusOf(legacyRedirect({ pathname: '/', search: '?p=999999' }, { shortlinks }))).toBe(410)
  })

  it('answers 410 for a shortlink that is not a number @S-357', () => {
    expect(statusOf(legacyRedirect({ pathname: '/', search: '?p=abc' }, { shortlinks }))).toBe(410)
  })

  it('resolves a shortlink on any path, as WordPress did @S-357', () => {
    expect(locationOf(legacyRedirect({ pathname: '/some-old-path/', search: '?p=3983' }, { shortlinks }))).toBe('/about')
  })
})

describe('legacyRedirect: a site’s own table @S-358', () => {
  it('answers an exact path before any rule @S-358', () => {
    const table = new Map([['/about-us', { kind: 'redirect', location: '/about-the-company', status: 301 } as const]])
    expect(locationOf(legacyRedirect({ pathname: '/about-us/' }, { table }))).toBe('/about-the-company')
  })

  it('can turn a rule into a 410 @S-358', () => {
    const table = new Map([['/employer', { kind: 'gone', status: 410 } as const]])
    expect(statusOf(legacyRedirect({ pathname: '/employer/' }, { table }))).toBe(410)
  })

  it('is not consulted for a path it does not name @S-358', () => {
    const table = new Map([['/about-us', { kind: 'gone', status: 410 } as const]])
    expect(locationOf(legacyRedirect({ pathname: '/employer/' }, { table }))).toBe('/employers')
  })
})

describe('no redirect chains @S-359', () => {
  const allPaths = [
    '/job-category/education/',
    '/job-type/contract/',
    '/job-type/voluntary/board-position/',
    '/job-salary/not-stated/',
    '/organisation/oxfam/',
    '/organisation/bred-bank-(vanuatu)-limited/',
    '/author/oxfam/',
    '/wp/jobs/',
    '/about-us/',
    '/contact-2/',
    '/employer/',
    '/login/',
    '/register/',
    '/sign-up/',
    '/home-2/',
    '/sample-page/',
    '/blog/',
    '/feed/',
    '/jobs/feed/',
    '/volunteer-jobs/rss-feed/',
    '/jobs/page/2/',
    '/jobs/welder-2/iiss-logo/',
    '/job-date-archive/',
  ]

  it('never sends a legacy URL to another legacy URL @S-359', () => {
    for (const pathname of allPaths) {
      const first = locationOf(legacyRedirect({ pathname }))
      const second = legacyRedirect({ pathname: first.split('?')[0]! })
      // A filter target (`/jobs/{slug}`) has no rule of its own, so it is either null or the
      // listing itself; anything else would be a hop a crawler has to pay for twice.
      expect(second, `${pathname} -> ${first}`).toBeNull()
    }
  })

  it('never sends a search URL to another redirect @S-358', () => {
    const first = locationOf(legacyRedirect({ pathname: '/jobs/', search: '?s=chef' }))
    expect(legacyRedirect({ pathname: first.split('?')[0]!, search: first.split('?')[1] ?? '' })).toBeNull()
  })

  it('always answers 301, never a temporary redirect @S-359', () => {
    for (const pathname of allPaths) {
      expect(statusOf(legacyRedirect({ pathname })), pathname).toBe(301)
    }
  })
})
