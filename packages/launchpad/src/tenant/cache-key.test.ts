import { describe, expect, it } from 'vitest'

import { createMemoryContentVersionStore } from '@mission-control/content-cache'

import {
  cacheQueryString,
  contentCacheKey,
  normaliseCacheRequest,
  readCacheQuery,
  siteContentVersion,
  type CacheParamRule,
} from './cache-key'

const rules: CacheParamRule[] = [
  { kind: 'keyword', maxLength: 10, name: 'q' },
  { kind: 'value', name: 'category' },
  { kind: 'flag', name: 'voluntary', value: '1' },
  { kind: 'page', max: 3, name: 'page' },
]

describe('readCacheQuery @S-241', () => {
  it('keeps only the parameters the page owns', () => {
    expect(readCacheQuery('q=chef&category=trades&utm_source=news&evil=1', rules)).toEqual({
      page: 1,
      values: { category: 'trades', q: 'chef' },
    })
  })

  it('cuts a keyword rather than dropping it, so a long search is still a search', () => {
    expect(readCacheQuery(`q=${'x'.repeat(40)}`, rules).values.q).toBe('x'.repeat(10))
  })

  it('accepts a flag only at its documented value, so `voluntary=yes` applies nothing', () => {
    expect(readCacheQuery('voluntary=1', rules).values).toEqual({ voluntary: '1' })
    expect(readCacheQuery('voluntary=yes', rules).values).toEqual({})
  })

  it('clamps a page to the range the page serves', () => {
    expect(readCacheQuery('page=0', rules).page).toBe(1)
    expect(readCacheQuery('page=99', rules).page).toBe(3)
    expect(readCacheQuery('page=abc', rules).page).toBe(1)
    expect(readCacheQuery('page=2', rules).page).toBe(2)
  })

  it('drops a value that could not be a slug, so junk never reaches the CMS', () => {
    expect(readCacheQuery('category=%3Cscript%3E', rules).values).toEqual({})
    expect(readCacheQuery('category=a b', rules).values).toEqual({})
    expect(readCacheQuery('category=port-vila', rules).values).toEqual({ category: 'port-vila' })
  })

  it('reads a URLSearchParams as well as a raw string', () => {
    expect(readCacheQuery(new URLSearchParams('q=chef'), rules).values).toEqual({ q: 'chef' })
  })

  it('drops a duplicated parameter to the first value, so one page is one entry', () => {
    expect(readCacheQuery('q=chef&q=clerk', rules).values).toEqual({ q: 'chef' })
  })
})

describe('cacheQueryString @S-241', () => {
  it('sorts values by name and puts the page last', () => {
    expect(cacheQueryString({ q: 'chef', category: 'trades' }, 2)).toBe(
      'category=trades&q=chef&page=2',
    )
  })

  it('omits the page when it is the first, and every empty value', () => {
    expect(cacheQueryString({ q: 'chef', category: '   ' }, 1)).toBe('q=chef')
    expect(cacheQueryString({}, 1)).toBe('')
  })
})

describe('normaliseCacheRequest @S-241', () => {
  const base = { pathname: '/jobs', rules, tracking: undefined }

  it('leaves a canonical URL alone, so it is served rather than redirected', () => {
    const request = normaliseCacheRequest({ ...base, search: '?category=trades&q=chef' })

    expect(request).toEqual({ changed: false, url: '/jobs?category=trades&q=chef' })
  })

  it('sorts a reordered URL and reports it changed, so it becomes a 301', () => {
    const request = normaliseCacheRequest({ ...base, search: '?q=chef&category=trades' })

    expect(request).toEqual({ changed: true, url: '/jobs?category=trades&q=chef' })
  })

  it('redirects junk and `?page=1` to the bare path', () => {
    expect(normaliseCacheRequest({ ...base, search: '?type=asdf123' })).toEqual({
      changed: true,
      url: '/jobs',
    })
    expect(normaliseCacheRequest({ ...base, search: '?page=1' })).toEqual({
      changed: true,
      url: '/jobs',
    })
  })

  it('keeps tracking parameters in the URL and never redirects because of them', () => {
    const request = normaliseCacheRequest({ ...base, search: '?q=chef&utm_source=chatgpt.com' })

    expect(request).toEqual({ changed: false, url: '/jobs?q=chef&utm_source=chatgpt.com' })
  })

  it('keeps tracking parameters when it redirects for another reason', () => {
    const request = normaliseCacheRequest({ ...base, search: '?utm_source=news&q=chef&category=trades' })

    expect(request.changed).toBe(true)
    expect(request.url).toBe('/jobs?category=trades&q=chef&utm_source=news')
  })

  it('honours a tenant’s extra tracking names', () => {
    const request = normaliseCacheRequest({
      ...base,
      search: '?q=chef&campaign=news',
      tracking: { extra: ['campaign'] },
    })

    expect(request.changed).toBe(false)
    expect(request.url).toBe('/jobs?q=chef&campaign=news')
  })
})

describe('contentCacheKey @S-240', () => {
  it('includes the site, the content version and the canonical URL', () => {
    expect(contentCacheKey({ site: 'vwok', url: '/jobs', version: 'abc' })).toBe(
      'vwok:html:abc:/jobs',
    )
  })

  it('keys every page of a site by the same version, so one bump misses the whole site', () => {
    const at = (version: string) => [
      contentCacheKey({ site: 'vwok', url: '/jobs', version }),
      contentCacheKey({ site: 'vwok', url: '/jobs?page=2', version }),
      contentCacheKey({ site: 'vwok', url: '/organisations', version }),
    ]

    expect(at('v1')).not.toEqual(at('v2'))
    expect(at('v1').every((key) => key.includes(':v1:'))).toBe(true)
  })
})

describe('siteContentVersion @S-240', () => {
  it('reads the tenant’s version from the store', async () => {
    const store = createMemoryContentVersionStore({ vwok: 'v7' })

    expect(await siteContentVersion(store, 'vwok')).toBe('v7')
  })

  it('falls back to the default when there is no store, as in `astro dev`', async () => {
    expect(await siteContentVersion(undefined, 'vwok')).toBe('0')
  })
})
