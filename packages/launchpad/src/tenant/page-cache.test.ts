import { describe, expect, it, vi } from 'vitest'

import { createMemoryContentVersionStore } from '@mission-control/content-cache'

import type { CacheLike } from '../cms/cache'
import {
  HTML_BROWSER_MAX_AGE_SECONDS,
  HTML_EDGE_TTL_SECONDS,
  IMMUTABLE_ASSET_CACHE_CONTROL,
  MEDIA_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  htmlCacheControl,
} from '../cms/headers'
import { servePublicPage } from './page-cache'
import type { CacheParamRule } from './cache-key'

describe('cache lifetimes @S-242', () => {
  it('holds HTML at the edge for seven days but tells the browser to revalidate after a minute', () => {
    expect(HTML_EDGE_TTL_SECONDS).toBe(7 * 24 * 60 * 60)
    expect(HTML_BROWSER_MAX_AGE_SECONDS).toBe(60)
    expect(htmlCacheControl(HTML_EDGE_TTL_SECONDS)).toEqual({
      browser: 'public, max-age=60, s-maxage=604800',
      edge: 'public, max-age=604800',
    })
  })

  it('keeps hashed assets and media for a year', () => {
    expect(IMMUTABLE_ASSET_CACHE_CONTROL).toBe('public, max-age=31536000, immutable')
    expect(MEDIA_CACHE_CONTROL).toBe('public, max-age=31536000')
  })

  it('never caches health checks, account pages or forms', () => {
    expect(NO_STORE_CACHE_CONTROL).toBe('no-store')
  })

  it('rounds a fractional lifetime down to whole seconds', () => {
    expect(htmlCacheControl(10.9, 0.5)).toEqual({ browser: 'public, max-age=0, s-maxage=10', edge: 'public, max-age=10' })
  })
})

const pageCache = () => {
  const store = new Map<string, Response>()
  const cache: CacheLike = {
    async match(request) {
      const hit = store.get(request.url)
      return hit ? hit.clone() : undefined
    },
    async put(request, response) {
      store.set(request.url, response.clone())
    },
  }

  return { cache, store }
}

const rules: CacheParamRule[] = [{ kind: 'value', name: 'category' }]

const renderBody = (body: string) =>
  vi.fn(async () => new Response(`<html>${body}</html>`, { headers: { 'content-type': 'text/html' } }))

describe('servePublicPage @S-242', () => {
  it('renders once, then serves the stored page from the cache', async () => {
    const { cache } = pageCache()
    const store = createMemoryContentVersionStore({ vwok: 'v1' })
    const render = renderBody('first')
    const options = { cache, normalise: { pathname: '/jobs', rules, search: '' }, render, site: 'vwok', store }

    const first = await servePublicPage(options)
    const second = await servePublicPage(options)

    expect(await first.text()).toBe('<html>first</html>')
    expect(await second.text()).toBe('<html>first</html>')
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('stores the edge lifetime but answers the browser with the short one, even on a hit', async () => {
    const { cache, store: entries } = pageCache()
    const store = createMemoryContentVersionStore({ vwok: 'v1' })
    const options = {
      cache,
      normalise: { pathname: '/jobs', rules, search: '' },
      render: renderBody('page'),
      site: 'vwok',
      store,
    }

    const first = await servePublicPage(options)
    const hit = await servePublicPage(options)

    expect(first.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=604800')
    expect(hit.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=604800')
    // The entry itself is held for the edge lifetime.
    const stored = [...entries.values()].find((response) => response.headers.get('cache-control')?.includes('604800'))
    expect(stored?.headers.get('cache-control')).toBe('public, max-age=604800')
  })

  it('misses after the site’s content version is bumped, so a change reaches the page', async () => {
    const { cache } = pageCache()
    const store = createMemoryContentVersionStore({ vwok: 'before' })
    const render = renderBody('old')
    const options = { cache, normalise: { pathname: '/jobs', rules, search: '' }, render, site: 'vwok', store }

    await servePublicPage(options)
    store.values.set('content-version:vwok', 'after')
    render.mockImplementation(async () => new Response('<html>new</html>'))

    const response = await servePublicPage(options)

    expect(await response.text()).toBe('<html>new</html>')
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('answers a non-canonical URL with a 301 before it touches the cache or the page', async () => {
    const { cache, store: entries } = pageCache()
    const store = createMemoryContentVersionStore()
    const render = renderBody('page')

    const response = await servePublicPage({
      cache,
      normalise: { pathname: '/jobs', rules, search: '?utm_source=news&category=trades&junk=1' },
      render,
      site: 'vwok',
      store,
    })

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/jobs?category=trades&utm_source=news')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(render).not.toHaveBeenCalled()
    expect(entries.size).toBe(0)
  })

  it('serves the canonical URL itself, keeping its tracking parameters in the key-free reply', async () => {
    const { cache } = pageCache()
    const store = createMemoryContentVersionStore()
    const render = renderBody('page')

    const response = await servePublicPage({
      cache,
      normalise: { pathname: '/jobs', rules, search: '?category=trades&utm_source=news' },
      render,
      site: 'vwok',
      store,
    })

    expect(response.status).toBe(200)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('renders every time with no cache, so a preview is never stale', async () => {
    const store = createMemoryContentVersionStore()
    const render = renderBody('page')
    const options = { normalise: { pathname: '/jobs', rules, search: '' }, render, site: 'vwok', store }

    await servePublicPage(options)
    await servePublicPage(options)

    expect(render).toHaveBeenCalledTimes(2)
  })

  it('holds the page only five minutes when there is no version store to invalidate it', async () => {
    const { cache } = pageCache()
    const options = {
      cache,
      normalise: { pathname: '/jobs', rules, search: '' },
      render: renderBody('page'),
      site: 'vwok',
      store: undefined,
    }

    const response = await servePublicPage(options)

    expect(response.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300')
  })
})
