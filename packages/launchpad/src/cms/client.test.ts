import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { CmsError, createCmsClient, SITE_KEY_HEADER, stringifyQuery } from './client'
import type { CmsDoc } from './types'

const KEY = 'sk_secret-value'
const BASE = 'https://cms.test'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })

const list = <T>(docs: T[]) => ({
  docs,
  hasNextPage: false,
  hasPrevPage: false,
  limit: 0,
  page: 1,
  totalDocs: docs.length,
  totalPages: 1,
})

const setup = (respond: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    respond(new URL(String(input)), init ?? {}),
  )
  const client = createCmsClient({ baseUrl: BASE, fetch: fetchMock as typeof fetch, siteKey: KEY })

  return { client, fetchMock }
}

afterEach(() => vi.unstubAllGlobals())

describe('stringifyQuery', () => {
  it('uses the bracket notation Payload parses, including arrays and dates', () => {
    const query = stringifyQuery({
      sort: '-publishedAt',
      where: {
        and: [{ status: { equals: 'published' } }, { expiresAt: { greater_than: new Date('2026-01-02T00:00:00Z') } }],
        category: { in: [1, 2] },
      },
    })

    expect(decodeURIComponent(query).split('&')).toEqual([
      'sort=-publishedAt',
      'where[and][0][status][equals]=published',
      'where[and][1][expiresAt][greater_than]=2026-01-02T00:00:00.000Z',
      'where[category][in][0]=1',
      'where[category][in][1]=2',
    ])
  })

  it('skips undefined and null and encodes values', () => {
    expect(stringifyQuery({ a: undefined, b: null, q: 'a&b=c d' })).toBe('q=a%26b%3Dc%20d')
  })
})

describe('createCmsClient', () => {
  it('sends the site key header and no other credentials', async () => {
    const { client, fetchMock } = setup(() => json(list([])))

    await client.find('organisations')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(`${BASE}/api/organisations`)
    const headers = init!.headers as Record<string, string>
    expect(headers[SITE_KEY_HEADER]).toBe(KEY)
    expect(Object.keys(headers).toSorted()).toEqual(['accept', SITE_KEY_HEADER])
    expect(String(url)).not.toContain(KEY)
  })

  it('returns documents typed from the generated payload types', async () => {
    const org = { id: 1, name: 'Acme', slug: 'acme' }
    const { client } = setup(() => json(list([org])))

    const docs = await client.findAll('organisations')
    const one = await client.findBySlug('organisations', 'acme')

    expectTypeOf(docs).toEqualTypeOf<CmsDoc<'organisations'>[]>()
    expectTypeOf(one).toEqualTypeOf<CmsDoc<'organisations'> | null>()
    expectTypeOf(docs[0]!.slug).toBeString()
    // @ts-expect-error not a collection in the generated types
    void client.find('nope')
    expect(docs).toEqual([org])
  })

  it('findAll asks for everything in one request, with no page parameter', async () => {
    const { client, fetchMock } = setup(() => json(list([{ id: 1 }, { id: 2 }, { id: 3 }])))

    const docs = await client.findAll('job-categories', {
      sort: ['name', '-id'],
      where: { slug: { not_equals: 'x' } },
    })

    expect(docs).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = new URL(String(fetchMock.mock.calls[0]![0]))
    expect(url.searchParams.get('limit')).toBe('0')
    expect(url.searchParams.get('pagination')).toBe('false')
    expect(url.searchParams.get('page')).toBeNull()
    expect(url.searchParams.get('sort')).toBe('name,-id')
    expect(url.searchParams.get('where[slug][not_equals]')).toBe('x')
  })

  it('findBySlug adds no status filter, so a hidden (expired) document still resolves', async () => {
    const { client, fetchMock } = setup(() => json(list([{ id: 9, slug: 'old' }])))

    expect(await client.findBySlug('organisations', 'old')).toEqual({ id: 9, slug: 'old' })

    const url = new URL(String(fetchMock.mock.calls[0]![0]))
    expect([...url.searchParams.keys()].toSorted()).toEqual(['limit', 'where[slug][equals]'])
  })

  it('findBySlug and findByID answer null when nothing matches or the CMS says 404', async () => {
    const empty = setup(() => json(list([])))
    expect(await empty.client.findBySlug('organisations', 'none')).toBeNull()

    const missing = setup(() => json({ errors: [] }, 404))
    expect(await missing.client.findByID('organisations', 7)).toBeNull()
    expect(String(missing.fetchMock.mock.calls[0]![0])).toBe(`${BASE}/api/organisations/7`)
  })

  it('does not hardcode a tenant: the origin and key come from the caller', async () => {
    const seen: string[] = []
    const make = (baseUrl: string, siteKey: string) =>
      createCmsClient({
        baseUrl,
        fetch: (async (url: string, init: RequestInit) => {
          seen.push(`${new URL(url).origin} ${(init.headers as Record<string, string>)[SITE_KEY_HEADER]}`)

          return json(list([]))
        }) as unknown as typeof fetch,
        siteKey,
      })

    await make('https://a.example/', 'sk_a').find('organisations')
    await make('https://b.example', 'sk_b').find('organisations')

    expect(seen).toEqual(['https://a.example sk_a', 'https://b.example sk_b'])
  })

  it('reads a global', async () => {
    const { client, fetchMock } = setup(() => json({ id: 1 }))
    await client.global('system-status' as never)
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/api/globals/system-status`)
  })

  describe('errors', () => {
    it('throws CmsError with the status on a non-2xx, without leaking the key', async () => {
      const { client } = setup(() => json({ error: 'nope' }, 401))

      const error = await client.find('organisations').catch((e: unknown) => e)

      expect(error).toBeInstanceOf(CmsError)
      expect(error).toMatchObject({ code: 'http', status: 401 })
      expect(JSON.stringify(error) + String((error as Error).message) + (error as CmsError).url).not.toContain(KEY)
    })

    it('treats a 404 on a list as an error, and a 500 on findByID as an error', async () => {
      const list404 = setup(() => json({}, 404))
      await expect(list404.client.find('organisations')).rejects.toMatchObject({ isNotFound: true, status: 404 })

      const byId = setup(() => json({}, 500))
      await expect(byId.client.findByID('organisations', 1)).rejects.toMatchObject({ status: 500 })
    })

    it('wraps network failures, timeouts and bad bodies', async () => {
      const network = setup(() => Promise.reject(new TypeError('boom')))
      await expect(network.client.find('organisations')).rejects.toMatchObject({ code: 'network' })

      const timeout = setup(() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })))
      await expect(timeout.client.find('organisations')).rejects.toMatchObject({ code: 'timeout' })

      const html = setup(() => new Response('<html>', { status: 200 }))
      await expect(html.client.find('organisations')).rejects.toMatchObject({ code: 'invalid_response' })
    })

    it('passes an abort signal so a hung CMS cannot hang the page', async () => {
      const { client, fetchMock } = setup(() => json(list([])))
      await client.find('organisations')
      expect(fetchMock.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal)
    })
  })

  describe('server-side only', () => {
    it('refuses to be created in a browser-like environment', () => {
      vi.stubGlobal('window', {})
      expect(() => createCmsClient({ baseUrl: BASE, siteKey: KEY })).toThrow(/server-side only/)
    })

    it('requires a site key and an absolute base URL', () => {
      expect(() => createCmsClient({ baseUrl: BASE, siteKey: '  ' })).toThrow(/siteKey/)
      expect(() => createCmsClient({ baseUrl: '/relative', siteKey: KEY })).toThrow(/baseUrl/)
    })
  })
})
