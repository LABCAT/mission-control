import { legacyText } from '../legacy-text'
import {
  buildLocationIndex,
  locationKey,
  parseLegacyAddress,
  resolveLegacyLocation,
  type LocationDoc,
  type LocationIndex,
} from './locations'

/**
 * Legacy job address → location chips (20 Nov decision). The legacy `_jr_address` is free text
 * typed by employers: `Port Vila, Efate`, `Efate,Port Vila`, `Luganville - SANTO`, `Port Vila,
 * Santo and Tanna`, `Isankel, Tanna`, `Tafea,Shefa,Malampa`. This matcher splits it into places,
 * resolves each on the tenant's own tree (never inventing one), and tells the importer whether
 * the chips say everything the text did. When they do not, the text is kept as `locationDetails`.
 */

/**
 * Legacy provinces expand to the islands below them. Only islands that exist in the tenant's
 * tree are used. This is vwok's default; a tenant passes its own table (or `{}`).
 */
export const DEFAULT_PROVINCE_ISLANDS: Record<string, string[]> = {
  malampa: ['Malekula', 'Ambrym', 'Paama'],
  penama: ['Pentecost', 'Ambae', 'Maewo'],
  sanma: ['Espiritu Santo', 'Malo'],
  shefa: ['Efate', 'Epi', 'Shepherd Islands'],
  tafea: ['Tanna', 'Aniwa', 'Futuna', 'Aneityum', 'Erromango'],
  torba: ['Torres Islands', 'Banks Islands', 'Vanua Lava', 'Gaua', 'Mota Lava'],
}

export type JobLocationOptions = {
  /** Extra spellings: key (any case) → location name or slug. */
  aliases?: Record<string, string>
  /** Province → island names. Default {@link DEFAULT_PROVINCE_ISLANDS}. */
  provinces?: Record<string, string[]>
}

export type JobLocationMatch = {
  /** The chips, most specific only: a place whose descendant is also matched is dropped. */
  locations: LocationDoc[]
  /** Every chunk matched a location by its exact name (no spelling help, nothing left over). */
  exact: boolean
  /** Parts of the text that matched nothing. */
  unmatched: string[]
}

const editDistanceWithin = (a: string, b: string, max: number): boolean => {
  if (Math.abs(a.length - b.length) > max) return false
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = row
  }
  return previous[b.length]! <= max
}

/** Chunks of one label: `;` `|` `+` ` and ` ` & ` ` / ` ` - ` and ` or ` separate places. */
const chunksOf = (label: string): string[] =>
  legacyText(label)
    .split(/\s*[;|+]\s*|\s+(?:and|&|or)\s+|\s+[-–/]\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)

export const buildJobLocationMatcher = (docs: readonly LocationDoc[], options: JobLocationOptions = {}) => {
  const index: LocationIndex = buildLocationIndex(docs, {
    santo: 'espiritu-santo',
    ...Object.fromEntries(Object.entries(options.aliases ?? {}).map(([k, v]) => [locationKey(k), v])),
  })
  const provinces = Object.fromEntries(
    Object.entries(options.provinces ?? DEFAULT_PROVINCE_ISLANDS).map(([k, v]) => [locationKey(k), v]),
  )
  const byId = new Map(docs.map((doc) => [String(doc.id), doc]))
  const parentOf = (doc: LocationDoc): LocationDoc | undefined => {
    const ref = doc.parent
    if (!ref) return undefined
    return typeof ref === 'object' ? ref : byId.get(String(ref))
  }
  const fuzzyKeys = [...new Set([...index.byName.keys(), ...index.bySlug.keys()])]

  /** One part of a comma list, with spelling help. */
  const resolvePart = (part: string): { doc: LocationDoc; exact: boolean }[] => {
    const key = locationKey(part)
    if (!key) return []
    const province = provinces[key]
    if (province) {
      return province.flatMap((name) => {
        const doc = index.byName.get(locationKey(name))
        return doc ? [{ doc, exact: false }] : []
      })
    }
    const direct = resolveLegacyLocation(part, index)
    if (direct) return [{ doc: direct.doc, exact: direct.via !== 'slug' && locationKey(direct.doc.name) === key }]
    // Typos: one edit for names of 6+ letters, only when exactly one place is that close.
    if (key.length >= 6) {
      const close = fuzzyKeys.filter((candidate) => candidate.length >= 6 && editDistanceWithin(key, candidate, 1))
      const docs = [...new Set(close.map((c) => index.byName.get(c) ?? index.bySlug.get(c)!))]
      if (docs.length === 1) return [{ doc: docs[0]!, exact: false }]
    }
    return []
  }

  return (label: null | string | undefined): JobLocationMatch => {
    const found = new Map<string, LocationDoc>()
    const unmatched: string[] = []
    let exact = true

    for (const chunk of chunksOf(label ?? '')) {
      // `Town, Island` as the picker writes it is one place.
      const pair = resolveLegacyLocation(chunk, index)
      const parts = parseLegacyAddress(chunk)
      if (pair?.via === 'name-and-parent' && parts.length === 2) {
        found.set(String(pair.doc.id), pair.doc)
        continue
      }
      // Anything else: every part is its own place, so `Efate,Santo` keeps both. A chunk with
      // text no place explains (a street, `Vanuatu`) is no longer an exact match.
      let any = false
      for (const part of parts) {
        const matches = resolvePart(part)
        if (matches.length === 0) {
          unmatched.push(part)
          exact = false
          continue
        }
        any = true
        for (const match of matches) {
          found.set(String(match.doc.id), match.doc)
          if (!match.exact) exact = false
        }
      }
      if (!any && parts.length === 0) exact = false
    }

    // Drop a place when one of its descendants is also a chip: location pages include them.
    const ancestors = new Set<string>()
    for (const doc of found.values()) {
      let parent = parentOf(doc)
      for (let depth = 0; parent && depth < 10; depth++) {
        ancestors.add(String(parent.id))
        parent = parentOf(parent)
      }
    }
    const locations = [...found.values()].filter((doc) => !ancestors.has(String(doc.id)))
    return { exact: exact && locations.length > 0, locations, unmatched }
  }
}

export type JobLocationMatcher = ReturnType<typeof buildJobLocationMatcher>

/** The address meta keys of a legacy job, most specific first (QUERY-RESULTS 13 and 36). */
export const JOB_ADDRESS_KEYS = [
  '_jr_address',
  'geo_short_address',
  '_jr_geo_short_address',
  'geo_address',
  '_jr_geo_address',
] as const

/** The free-text address of one job, or `''`. */
export const jobAddressLabel = (meta: Record<string, string | undefined>): string => {
  for (const key of JOB_ADDRESS_KEYS) {
    const text = legacyText(meta[key])
    if (text) return text
  }
  const town = legacyText(meta._jr_geo_town)
  const region = legacyText(meta._jr_geo_region)
  return town && region ? `${town}, ${region}` : town || region
}
