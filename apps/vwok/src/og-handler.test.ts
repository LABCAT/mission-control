import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { describe, expect, it, vi } from 'vitest'

const resolve = createRequire(import.meta.url).resolve

const bucket = {
  objects: new Map<string, { bytes: ArrayBuffer; customMetadata: Record<string, string> }>(),
  get: async (key: string) => {
    const found = bucket.objects.get(key)

    return found ? { arrayBuffer: async () => found.bytes, customMetadata: found.customMetadata } : null
  },
  put: async (key: string, value: ArrayBuffer, options?: { customMetadata?: Record<string, string> }) => {
    bucket.objects.set(key, { bytes: value, customMetadata: options?.customMetadata ?? {} })
  },
}

/** A CMS with one live job, so the job card is drawn from real page data. */
const jobDoc = {
  id: 7,
  jobType: { id: 20, name: 'Full time', slug: 'full-time' },
  location: [{ id: 11, name: 'Port Vila', slug: 'port-vila' }],
  organisation: { approved: true, id: 3, name: 'Acme Hospitality', pageEnabled: true, slug: 'acme' },
  slug: 'head-chef',
  status: 'published',
  title: 'Head Chef',
}

const fakeCms = {
  findAll: async (collection: string) =>
    collection === 'pages' ? [{ id: 1, role: 'home', slug: null, title: 'Find a job in Vanuatu' }] : [],
  find: async () => ({ docs: [], totalDocs: 0 }),
  findBySlug: async (collection: string, slug: string) =>
    collection === 'jobs' && slug === jobDoc.slug ? jobDoc : null,
  global: async () => ({}),
  tenantSettings: async () => null,
}

// The Worker's environment and CMS come from `cloudflare:workers`, which only exists in workerd.
// The renderer below is real; only the WASM import form is swapped, because `?module` is Vite's
// Worker transform and Node cannot load it.
vi.mock('./env', () => ({ aiCrawlersAllowed: () => true, siteEnv: async () => ({ OG_IMAGES: bucket }) }))
vi.mock('./site', async (importOriginal) => ({ ...(await importOriginal<object>()), cmsFromEnv: () => fakeCms }))
vi.mock('@mission-control/launchpad/og/worker', async () => {
  const { createOgRenderer } = await import('@mission-control/launchpad/og/render')
  const { ogFonts } = await import('@mission-control/launchpad/og/fonts')
  const renderer = createOgRenderer({
    fonts: ogFonts(),
    resvgWasm: await readFile(resolve('@resvg/resvg-wasm/index_bg.wasm')),
  })

  return { ogRenderer: () => renderer }
})

const { GET } = await import('./pages/og/[...path]')

// A refused port, not the real host: satori fetches the card's logo itself, and a test must not
// depend on the network. The fallback here is a site logo path, so the fetch fails fast.
const ORIGIN = 'http://127.0.0.1:9'

const request = (path: string) =>
  ({
    params: { path },
    site: new URL(ORIGIN),
    url: new URL(`${ORIGIN}/og/${path}`),
  }) as unknown as Parameters<typeof GET>[0]

const pngSize = (png: ArrayBuffer): { height: number; width: number } => {
  const view = new DataView(png)

  return { height: view.getUint32(20), width: view.getUint32(16) }
}

describe('share image route handler @S-250', () => {
  it('answers a job page with a 1200x630 PNG, and stores it in R2 @S-256', async () => {
    const response = await GET(request('jobs/head-chef.png'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(pngSize(await response.arrayBuffer())).toEqual({ height: 630, width: 1200 })
    // One object per page, so a later isolate reads the PNG instead of rendering it.
    expect([...bucket.objects.keys()]).toEqual(['og/job/Vanuatu%20Wok/jobs%2Fhead-chef'])
  })

  it('serves a second request for the same job from storage, byte for byte @S-258', async () => {
    const first = await GET(request('jobs/head-chef.png'))
    const bytes = await first.arrayBuffer()

    const second = await GET(request('jobs/head-chef.png'))
    expect(await second.arrayBuffer()).toEqual(bytes)
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'))
  })

  it('regenerates when the job changes, over the same R2 object @S-257', async () => {
    const before = await GET(request('jobs/head-chef.png'))
    const key = [...bucket.objects.keys()].at(-1)!

    const title = jobDoc.title
    jobDoc.title = 'Sous Chef'
    const after = await GET(request('jobs/head-chef.png'))
    jobDoc.title = title

    expect(after.headers.get('etag')).not.toBe(before.headers.get('etag'))
    const beforeBytes = new Uint8Array(await before.arrayBuffer())
    const afterBytes = new Uint8Array(await after.arrayBuffer())
    expect(afterBytes).not.toEqual(beforeBytes)
    // The version changed, the key did not: one object per page, overwritten.
    expect([...bucket.objects.keys()].at(-1)).toBe(key)
  })

  it('answers the home page PNG @S-254', async () => {
    const response = await GET(request('home.png'))

    expect(response.status).toBe(200)
    expect(pngSize(await response.arrayBuffer())).toEqual({ height: 630, width: 1200 })
  })

  it('is a 404 for a path that is not a share image @S-259', async () => {
    const response = await GET(request('jobs/head-chef.jpg'))

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe('text/plain')
  })

  it('is a 404 for a job that does not exist @S-259', async () => {
    expect((await GET(request('jobs/no-such-job.png'))).status).toBe(404)
  })
})
