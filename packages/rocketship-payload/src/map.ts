import type { MapBlock, MapProvider } from './types'

export const MAP_PROVIDERS: readonly MapProvider[] = ['openstreetmap', 'google']

export const DEFAULT_MAP_PROVIDER: MapProvider = 'openstreetmap'
export const DEFAULT_MAP_ZOOM = 14
export const MIN_MAP_ZOOM = 1
export const MAX_MAP_ZOOM = 20

/** A coordinate pair the map can point at. */
export type MapPoint = {
  latitude: number
  longitude: number
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export const validLatitude = (value: unknown): value is number =>
  isNumber(value) && value >= -90 && value <= 90

export const validLongitude = (value: unknown): value is number =>
  isNumber(value) && value >= -180 && value <= 180

/** The block's coordinates, or `null` when either value is missing or out of range. */
export const mapPoint = (block: Pick<MapBlock, 'latitude' | 'longitude'>): MapPoint | null =>
  validLatitude(block.latitude) && validLongitude(block.longitude)
    ? { latitude: block.latitude, longitude: block.longitude }
    : null

export const mapZoom = (zoom: MapBlock['zoom']): number =>
  isNumber(zoom) && zoom >= MIN_MAP_ZOOM && zoom <= MAX_MAP_ZOOM
    ? Math.round(zoom)
    : DEFAULT_MAP_ZOOM

const providerOf = (provider: MapBlock['provider']): MapProvider =>
  provider && MAP_PROVIDERS.includes(provider) ? provider : DEFAULT_MAP_PROVIDER

/** Degrees of longitude spanned either side of the centre at a zoom level (256px tiles). */
const longitudeSpan = (zoom: number): number => 360 / 2 ** zoom

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const round = (value: number): string => value.toFixed(6).replace(/\.?0+$/, '')

/**
 * The src of the map iframe, or `null` when the block has nothing to show. A point wins over
 * the address; neither means no map rather than a map of nowhere.
 *
 * Both providers render keyless embeds, so no key travels in the page or the config.
 */
export const mapEmbedUrl = (
  block: Pick<MapBlock, 'address' | 'latitude' | 'longitude' | 'provider' | 'zoom'>,
): null | string => {
  const point = mapPoint(block)
  const address = typeof block.address === 'string' ? block.address.trim() : ''
  const zoom = mapZoom(block.zoom)
  const provider = providerOf(block.provider)

  if (provider === 'google') {
    if (point) {
      return `https://www.google.com/maps?q=${round(point.latitude)},${round(point.longitude)}&z=${zoom}&output=embed`
    }

    return address
      ? `https://www.google.com/maps?q=${encodeURIComponent(address)}&z=${zoom}&output=embed`
      : null
  }

  if (!point) return null

  // OpenStreetMap's embed takes a bounding box; centre a box of about one tile around the
  // point, so the zoom level points at the same place as the other provider.
  const span = longitudeSpan(zoom)
  const latSpan = span / 2
  const west = clamp(point.longitude - span / 2, -180, 180)
  const east = clamp(point.longitude + span / 2, -180, 180)
  const south = clamp(point.latitude - latSpan, -90, 90)
  const north = clamp(point.latitude + latSpan, -90, 90)

  const bbox = [west, south, east, north].map(round).join('%2C')

  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${round(point.latitude)}%2C${round(point.longitude)}`
}

export type MapHeight = 'large' | 'medium' | 'small'

/** A CSS pixel height for the iframe; an unknown value falls back to medium. */
export const mapHeightPixels = (height: MapBlock['height']): number =>
  height === 'small' ? 240 : height === 'large' ? 560 : 400
