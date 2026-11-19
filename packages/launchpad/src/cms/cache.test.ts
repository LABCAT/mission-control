import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cached, cachedResponse, cacheTag, purgeTags, type CacheLike } from './cache'

/** In-memory Cache API that honours `max-age` against the (fake) clock. */
const memoryCache = () => {
  const store = new Map<string, { expires: number; body: string; headers: Headers }>()
  const cache: CacheLike & { store: typeof store } = {
    async match(request) {
      const entry = store.get(request.url)
      if (!entry || entry.expires <= Date.now()) return undefined

      return new Response(entry.body, { headers: entry.headers })
    },
    async put(request, response) {
      const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 0)
      store.set(request.url, {
        body: await response.text(),
        expires: Date.now() + maxAge * 1000,
        headers: response.headers,
      })
    },
    store,
  }

  return cache
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, status: 200 })

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') }))
afterEach(() => vi.useRealTimers())

describe('cached', () => {
  it('misses once, then serves the value without calling fn', async () => {
    const cache = memoryCache()
    const fn = vi.fn(async () => ({ n: 1 }))

    expect(await cached('jobs:list', 60, fn, { cache })).toEqual({ n: 1 })
    expect(await cached('jobs:list', 60, fn, { cache })).toEqual({ n: 1 })

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('expires after the ttl and calls fn again', async () => {
    const cache = memoryCache()
    let n = 0
    const fn = async () => ++n

    expect(await cached('k', 60, fn, { cache })).toBe(1)
    vi.advanceTimersByTime(59_000)
    expect(await cached('k', 60, fn, { cache })).toBe(1)
    vi.advanceTimersByTime(2_000)
    expect(await cached('k', 60, fn, { cache })).toBe(2)
  })

  it('stores the ttl as max-age, and the tags as Cache-Tag', async () => {
    const cache = memoryCache()
    await cached('k', 300, async () => 1, { cache, tags: ['site:vwok', 'jobs'] })

    const entry = [...cache.store.entries()].find(([url]) => url.includes('/entry/'))![1]
    expect(entry.headers.get('cache-control')).toBe('public, max-age=300')
    expect(entry.headers.get('cache-tag')).toBe('jobs,site:vwok')
  })

  it('keeps different keys and namespaces apart', async () => {
    const cache = memoryCache()
    await cached('a', 60, async () => 'a', { cache })

    expect(await cached('b', 60, async () => 'b', { cache })).toBe('b')
    expect(await cached('a', 60, async () => 'other', { cache, namespace: 'x' })).toBe('other')
    expect(await cached('a', 60, async () => 'new', { cache })).toBe('a')
  })

  it('does not cache a failure, and does not cache undefined', async () => {
    const cache = memoryCache()
    const fn = vi.fn().mockRejectedValueOnce(new Error('cms down')).mockResolvedValue('ok')

    await expect(cached('k', 60, fn, { cache })).rejects.toThrow('cms down')
    expect(await cached('k', 60, fn, { cache })).toBe('ok')
    expect(await cached('k', 60, fn, { cache })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)

    const none = vi.fn(async () => undefined)
    await cached('u', 60, none, { cache })
    await cached('u', 60, none, { cache })
    expect(none).toHaveBeenCalledTimes(2)
  })

  it('calls fn straight through with no cache or a non-positive ttl', async () => {
    const fn = vi.fn(async () => 1)
    await cached('k', 60, fn)
    await cached('k', 0, fn, { cache: memoryCache() })

    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('survives a cache that throws on read, write or with a corrupt body', async () => {
    const broken: CacheLike = {
      match: async () => {
        throw new Error('read')
      },
      put: async () => {
        throw new Error('write')
      },
    }
    expect(await cached('k', 60, async () => 7, { cache: broken })).toBe(7)

    const corrupt = memoryCache()
    await cached('k', 60, async () => 1, { cache: corrupt })
    for (const entry of corrupt.store.values()) if (entry.headers.get('content-type')) entry.body = '{oops'
    expect(await cached('k', 60, async () => 2, { cache: corrupt })).toBe(2)
  })
})

describe('tags', () => {
  it('builds tags from parts', () => {
    expect(cacheTag('site', 'vwok', 'jobs')).toBe('site:vwok:jobs')
  })

  it('purging a tag invalidates entries carrying it, and only those', async () => {
    const cache = memoryCache()
    let n = 0
    const fn = async () => ++n
    await cached('list', 600, fn, { cache, tags: ['jobs', 'site:vwok'] })
    await cached('org', 600, fn, { cache, tags: ['organisations'] })

    await purgeTags(['jobs'], { cache })

    expect(await cached('list', 600, fn, { cache, tags: ['jobs', 'site:vwok'] })).toBe(3)
    expect(await cached('org', 600, fn, { cache, tags: ['organisations'] })).toBe(2)
  })

  it('the entry address does not depend on tag order', async () => {
    const cache = memoryCache()
    const fn = vi.fn(async () => 1)
    await cached('k', 60, fn, { cache, tags: ['a', 'b'] })
    await cached('k', 60, fn, { cache, tags: ['b', 'a', 'a'] })

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a purge outlives the entry ttl, so a re-stored entry is fresh and stays cached', async () => {
    const cache = memoryCache()
    let n = 0
    const fn = async () => ++n
    await cached('k', 60, fn, { cache, tags: ['t'] })
    await purgeTags(['t'], { cache })
    vi.advanceTimersByTime(3_600_000)

    expect(await cached('k', 60, fn, { cache, tags: ['t'] })).toBe(2)
    expect(await cached('k', 60, fn, { cache, tags: ['t'] })).toBe(2)
  })

  it('purge with no cache available is a no-op', async () => {
    await expect(purgeTags(['t'])).resolves.toBeUndefined()
  })
})

describe('cachedResponse', () => {
  it('stores the whole page and serves it back without rendering again', async () => {
    const cache = memoryCache()
    const render = vi.fn(async () => html('<h1>Jobs</h1>'))

    const first = await cachedResponse('vwok:html:/jobs', 300, render, { cache, tags: ['site:vwok:jobs'] })
    const second = await cachedResponse('vwok:html:/jobs', 300, render, { cache, tags: ['site:vwok:jobs'] })

    expect(await first.text()).toBe('<h1>Jobs</h1>')
    expect(await second.text()).toBe('<h1>Jobs</h1>')
    expect(second.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('writes the ttl and the purge tag into the stored page', async () => {
    const cache = memoryCache()
    await cachedResponse('k', 300, async () => html('<p>hi</p>'), { cache, tags: ['site:vwok', 'site:vwok:jobs'] })

    const entry = [...cache.store.entries()].find(([url]) => url.includes('/page/'))![1]
    expect(entry.headers.get('cache-control')).toBe('public, max-age=300')
    expect(entry.headers.get('cache-tag')).toBe('site:vwok,site:vwok:jobs')
  })

  it('expires the page after the ttl and renders again', async () => {
    const cache = memoryCache()
    let n = 0
    const render = async () => html(`<p>${++n}</p>`)

    expect(await (await cachedResponse('k', 300, render, { cache })).text()).toBe('<p>1</p>')
    vi.advanceTimersByTime(299_000)
    expect(await (await cachedResponse('k', 300, render, { cache })).text()).toBe('<p>1</p>')
    vi.advanceTimersByTime(2_000)
    expect(await (await cachedResponse('k', 300, render, { cache })).text()).toBe('<p>2</p>')
  })

  it('never stores a page that is not a 200, so a temporary error is not held for five minutes', async () => {
    const cache = memoryCache()
    const render = vi.fn(async () => new Response('boom', { status: 500 }))

    expect((await cachedResponse('k', 300, render, { cache })).status).toBe(500)
    expect((await cachedResponse('k', 300, render, { cache })).status).toBe(500)
    expect(render).toHaveBeenCalledTimes(2)
    expect([...cache.store.keys()].filter((url) => url.includes('/page/'))).toHaveLength(0)
  })

  it('purges with the page tag: the next request renders again', async () => {
    const cache = memoryCache()
    let n = 0
    const render = async () => html(`<p>${++n}</p>`)

    await cachedResponse('k', 300, render, { cache, tags: ['site:vwok:jobs'] })
    await purgeTags(['site:vwok:jobs'], { cache })

    expect(await (await cachedResponse('k', 300, render, { cache, tags: ['site:vwok:jobs'] })).text()).toBe(
      '<p>2</p>',
    )
  })

  it('renders every time when there is no cache or the ttl is not positive', async () => {
    const render = vi.fn(async () => html('<p>x</p>'))

    await cachedResponse('k', 300, render)
    await cachedResponse('k', 0, render, { cache: memoryCache() })

    expect(render).toHaveBeenCalledTimes(2)
  })

  it('does not escape the cache namespace into another site', async () => {
    const cache = memoryCache()
    const render = vi.fn(async () => html('<p>x</p>'))

    await cachedResponse('html:/jobs', 300, render, { cache, namespace: 'vwok' })
    await cachedResponse('html:/jobs', 300, render, { cache, namespace: 'hub' })

    expect(render).toHaveBeenCalledTimes(2)
  })
})
