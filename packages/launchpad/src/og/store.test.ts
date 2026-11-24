import { describe, expect, it, vi } from 'vitest'

import type { CacheLike } from '../cms/cache'
import { cardVersion, ogKey, PNG_CONTENT_TYPE, servedPng, type PngBucket } from './store'

/** A bucket that keeps objects in a map and counts the calls made against it. */
const fakeBucket = () => {
  const objects = new Map<string, { bytes: ArrayBuffer; customMetadata: Record<string, string> }>()
  const bucket: PngBucket = {
    get: async (key) => {
      const found = objects.get(key)
      if (!found) return null

      return {
        arrayBuffer: async () => found.bytes,
        customMetadata: found.customMetadata,
      }
    },
    put: async (key, value, options) => {
      objects.set(key, {
        bytes: value,
        customMetadata: (options?.customMetadata as Record<string, string>) ?? {},
      })
    },
  }

  return { bucket, objects }
}

/** A cache that keeps responses in a map keyed by URL, like the real edge cache does. */
const fakeCache = () => {
  const entries = new Map<string, Response>()
  const cache: CacheLike = {
    match: async (request) => entries.get(String(request.url))?.clone(),
    put: async (request, res) => {
      entries.set(String(request.url), res)
    },
  }

  return { cache, entries }
}

const png = (...bytes: number[]): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...bytes])

describe('share image store', () => {
  it('versions a card by its content, so a changed card is a new version @S-257', async () => {
    const before = await cardVersion({ title: 'Head Chef', facts: ['Port Vila'] })
    const after = await cardVersion({ title: 'Sous Chef', facts: ['Port Vila'] })

    expect(before).toMatch(/^[0-9a-f]{16}$/)
    expect(before).not.toBe(after)
    // Stable for the same card, whatever the key order of the object passed in.
    expect(await cardVersion({ facts: ['Port Vila'], title: 'Head Chef' })).toBe(before)
  })

  it('keys one R2 object per page, without the version @S-257', () => {
    expect(ogKey('job', 'Vanuatu Wok', 'jobs/head-chef')).toBe(
      'og/job/Vanuatu%20Wok/jobs%2Fhead-chef',
    )
    expect(ogKey('home', 'Vanuatu Wok')).toBe('og/home/Vanuatu%20Wok')
  })

  it('renders on a miss, then serves the same bytes from the edge @S-258', async () => {
    const { cache, entries } = fakeCache()
    const render = vi.fn(async () => png(1))

    const first = await servedPng('jobs/a', 'v1', render, { cache })
    expect(first.headers.get('content-type')).toBe(PNG_CONTENT_TYPE)
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(png(1))
    expect(render).toHaveBeenCalledOnce()
    expect(entries.size).toBe(1)

    const second = await servedPng('jobs/a', 'v1', render, { cache })
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(png(1))
    // No second render: the edge answered.
    expect(render).toHaveBeenCalledOnce()
  })

  it('regenerates when the card version changes, and keeps the old entry unreachable @S-258', async () => {
    const { cache, entries } = fakeCache()
    const render = vi.fn(async (colour: number) => png(colour))

    await servedPng('jobs/a', 'v1', () => render(1), { cache })
    await servedPng('jobs/a', 'v2', () => render(2), { cache })

    expect(render).toHaveBeenCalledTimes(2)
    // Two entries, addressed by version: the new one is read, the old one expires on its TTL.
    expect(entries.size).toBe(2)
    const current = await servedPng('jobs/a', 'v2', () => render(9), { cache })
    expect(new Uint8Array(await current.arrayBuffer())).toEqual(png(2))
  })

  it('writes the PNG to R2 with the version, and reads it back after the edge is lost @S-258', async () => {
    const { bucket, objects } = fakeBucket()
    const now = fakeCache()

    await servedPng('jobs/a', 'v1', async () => png(7), { bucket, cache: now.cache })
    expect(objects.get('jobs/a')?.customMetadata).toMatchObject({ height: '630', version: 'v1', width: '1200' })

    // A new isolate: the edge cache is empty, but R2 is not.
    const later = fakeCache()
    const render = vi.fn(async () => png(8))
    const fromStore = await servedPng('jobs/a', 'v1', render, { bucket, cache: later.cache })

    expect(new Uint8Array(await fromStore.arrayBuffer())).toEqual(png(7))
    expect(render).not.toHaveBeenCalled()
    expect(later.entries.size).toBe(1)
  })

  it('ignores an R2 object from an older version and renders again @S-258', async () => {
    const { bucket } = fakeBucket()
    await servedPng('jobs/a', 'v1', async () => png(1), { bucket })

    const render = vi.fn(async () => png(2))
    const fresh = await servedPng('jobs/a', 'v2', render, { bucket })

    expect(new Uint8Array(await fresh.arrayBuffer())).toEqual(png(2))
    expect(render).toHaveBeenCalledOnce()
  })

  it('still renders when there is no bucket and no cache @S-258', async () => {
    const only = await servedPng('jobs/a', 'v1', async () => png(3), {})

    expect(new Uint8Array(await only.arrayBuffer())).toEqual(png(3))
  })

  it('serves the image when storage fails, and tries again next time @S-258', async () => {
    const put = vi.fn(async () => {
      throw new Error('R2 down')
    })
    const bucket: PngBucket = { get: async () => null, put }
    const render = vi.fn(async () => png(4))

    const res = await servedPng('jobs/a', 'v1', render, { bucket })

    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png(4))
    expect(put).toHaveBeenCalledOnce()
  })

  it('does not hold a failed render @S-258', async () => {
    const { cache, entries } = fakeCache()
    const render = vi
      .fn<() => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new Error('satori failed'))
      .mockResolvedValueOnce(png(5))

    await expect(servedPng('jobs/a', 'v1', render, { cache })).rejects.toThrow('satori failed')
    expect(entries.size).toBe(0)

    const second = await servedPng('jobs/a', 'v1', render, { cache })
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(png(5))
  })

  it('sets an immutable cache-control and the version as its ETag @S-258', async () => {
    const res = await servedPng('jobs/a', 'abc123', async () => png(1), {})

    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('etag')).toBe('"abc123"')
    expect(res.headers.get('x-og-version')).toBe('abc123')
  })
})
