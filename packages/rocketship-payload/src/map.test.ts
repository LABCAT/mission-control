import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAP_PROVIDER,
  DEFAULT_MAP_ZOOM,
  mapEmbedUrl,
  mapHeightPixels,
  mapPoint,
  mapZoom,
} from './map'

const portVila = { latitude: -17.7333, longitude: 168.3167 }

describe('mapPoint', () => {
  it('accepts a point inside the coordinate ranges', () => {
    expect(mapPoint(portVila)).toEqual(portVila)
  })

  it('rejects a point outside the coordinate ranges', () => {
    expect(mapPoint({ latitude: 91, longitude: 0 })).toBeNull()
    expect(mapPoint({ latitude: 0, longitude: -181 })).toBeNull()
  })

  it('rejects a half point rather than guessing the other side', () => {
    expect(mapPoint({ latitude: -17.7, longitude: null })).toBeNull()
    expect(mapPoint({})).toBeNull()
  })

  it('accepts the poles and the date line', () => {
    expect(mapPoint({ latitude: 90, longitude: 180 })).toEqual({ latitude: 90, longitude: 180 })
  })
})

describe('mapZoom', () => {
  it('defaults to the town-level zoom', () => {
    expect(DEFAULT_MAP_ZOOM).toBe(14)
    expect(mapZoom(undefined)).toBe(14)
  })

  it('refuses a zoom outside the range instead of passing it to the provider', () => {
    expect(mapZoom(0)).toBe(DEFAULT_MAP_ZOOM)
    expect(mapZoom(25)).toBe(DEFAULT_MAP_ZOOM)
    expect(mapZoom(3)).toBe(3)
  })
})

describe('mapEmbedUrl', () => {
  it('builds a keyless OpenStreetMap embed for a point @S-321', () => {
    const url = mapEmbedUrl({ ...portVila, provider: 'openstreetmap' })

    expect(DEFAULT_MAP_PROVIDER).toBe('openstreetmap')
    expect(url).toContain('https://www.openstreetmap.org/export/embed.html')
    expect(url).toContain('marker=-17.7333%2C168.3167')
    expect(url).not.toContain('key=')
  })

  it('centres a bounding box on the point', () => {
    const url = mapEmbedUrl({ ...portVila, zoom: 4 })!
    const bbox = new URL(url).searchParams.get('bbox')!.split(',').map(Number)

    const [west, south, east, north] = bbox
    expect(west).toBeLessThan(portVila.longitude)
    expect(east).toBeGreaterThan(portVila.longitude)
    expect(south).toBeLessThan(portVila.latitude)
    expect(north).toBeGreaterThan(portVila.latitude)
    // 360 / 2^4 = 22.5 degrees wide.
    expect(east - west).toBeCloseTo(22.5, 3)
  })

  it('clamps the bounding box at the date line', () => {
    const url = mapEmbedUrl({ latitude: 0, longitude: 179.9, zoom: 6 })!
    const [west, , east] = new URL(url).searchParams.get('bbox')!.split(',').map(Number)

    expect(west).toBeGreaterThanOrEqual(-180)
    expect(east).toBeLessThanOrEqual(180)
  })

  it('builds a keyless Google embed for a point', () => {
    const url = mapEmbedUrl({ ...portVila, provider: 'google' })!

    expect(url).toContain('https://www.google.com/maps?q=-17.7333,168.3167')
    expect(url).toContain('output=embed')
    expect(url).not.toContain('key=')
  })

  it('searches the address on Google when there is no point', () => {
    const url = mapEmbedUrl({ address: 'Kumul Highway, Port Vila', provider: 'google' })!

    expect(url).toContain('q=Kumul%20Highway%2C%20Port%20Vila')
  })

  it('prefers the point over the address', () => {
    const url = mapEmbedUrl({ ...portVila, address: 'Somewhere else', provider: 'google' })!

    expect(url).not.toContain('Somewhere')
  })

  it('draws nothing without a point or an address', () => {
    expect(mapEmbedUrl({})).toBeNull()
    expect(mapEmbedUrl({ address: '   ' })).toBeNull()
    expect(mapEmbedUrl({ provider: 'google' })).toBeNull()
  })

  it('draws nothing for OpenStreetMap with only an address, which it cannot look up', () => {
    expect(mapEmbedUrl({ address: 'Port Vila', provider: 'openstreetmap' })).toBeNull()
  })

  it('ignores an unknown provider', () => {
    const url = mapEmbedUrl({ ...portVila, provider: 'bing' as never })

    expect(url).toContain('openstreetmap.org')
  })
})

describe('mapHeightPixels', () => {
  it('maps the three sizes and defaults to medium', () => {
    expect(mapHeightPixels('small')).toBe(240)
    expect(mapHeightPixels('medium')).toBe(400)
    expect(mapHeightPixels('large')).toBe(560)
    expect(mapHeightPixels(undefined)).toBe(400)
  })
})
