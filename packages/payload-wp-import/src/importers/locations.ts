import type { MysqlReader } from '../mysql-reader'
import { legacyText } from '../legacy-text'
import type { Importer, ImportContext } from '../types'

/**
 * Mapping of legacy JobRoller job locations onto the tenant's `locations` tree.
 *
 * The legacy site stores a location as post meta, not as a WordPress taxonomy: the job form
 * writes the picker address (`Town, Island`) or a free-text geocoded address, and the theme
 * parses the picker back out of that string (`regions-and-towns.js`, `displaySavedAddress`).
 * There are therefore no location terms to import: the tree is the tenant's own (seeded by
 * PJ-17), and this module resolves the legacy strings onto it.
 *
 * A label that matches nothing is a real data gap. The job importer (PJ-64) must not invent a
 * place, and neither does this: the `locations` importer reports every unmatched label as a
 * failure, so a dry run lists exactly what would lose its location before anything is written.
 */

/**
 * Meta keys a legacy job's location can be in. JobRoller's geocoder stores the address it shows
 * on the listing (`shortAddress`); `address` is the full address, and the picker halves are read
 * too in case the site saved them separately. All four are optional.
 */
const META = {
  address: '_jr_geo_address',
  region: '_jr_geo_region',
  shortAddress: '_jr_geo_short_address',
  town: '_jr_geo_town',
} as const

/** The same keys as a list, for the one query that reads them all. */
export const LOCATION_META_KEYS = [META.shortAddress, META.address, META.town, META.region] as const

/** {@link LOCATION_META_KEYS} as a map, for callers holding one post's meta. */
export type LegacyLocationMeta = Partial<
  Record<(typeof LOCATION_META_KEYS)[number], null | string>
>

/**
 * Legacy spellings that are not the seeded name. `Santo` is how the site's own search
 * placeholder names Espiritu Santo (`e.g Efate, Santo, Tanna`). An alias only applies when it
 * resolves to a location that exists, so a tenant with its own tree is unaffected.
 */
export const LOCATION_ALIASES: Record<string, string> = {
  santo: 'espiritu-santo',
}

/** The part of a `locations` document the resolver needs. */
export type LocationDoc = {
  id: number | string
  kind?: null | string
  name: string
  parent?: LocationDoc | number | string | null
  slug: string
}

export type LocationMatch = {
  doc: LocationDoc
  /** How the label matched, for the import report. */
  via: 'name' | 'name-and-parent' | 'slug'
}

/** Case, punctuation and spacing removed: `White Sands` and `Whitesands` compare equal. */
export const locationKey = (value: null | string | undefined): string =>
  legacyText(value)
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '')

export type LocationIndex = {
  /** Name key → location, for islands, catch-alls and towns whose name is unambiguous. */
  byName: Map<string, LocationDoc>
  /** `<parent key>|<town key>`, for towns that share a name with a place elsewhere. */
  byParentAndName: Map<string, LocationDoc>
  /** Slug key → location. */
  bySlug: Map<string, LocationDoc>
}

const setFirst = (map: Map<string, LocationDoc>, key: string, doc: LocationDoc): void => {
  if (key && !map.has(key)) map.set(key, doc)
}

/**
 * Index a tenant's locations by slug, name and name-with-parent. A key keeps its first
 * document, so a given tree always answers the same way. `doc.parent` is read as a document
 * when the query asked for `depth: 1` and as an id otherwise; both resolve to the same parent.
 */
export const buildLocationIndex = (
  docs: readonly LocationDoc[],
  aliases: Record<string, string> = LOCATION_ALIASES,
): LocationIndex => {
  const byId = new Map(docs.map((doc) => [String(doc.id), doc]))
  const byName = new Map<string, LocationDoc>()
  const byParentAndName = new Map<string, LocationDoc>()
  const bySlug = new Map<string, LocationDoc>()

  for (const doc of docs) {
    setFirst(bySlug, locationKey(doc.slug), doc)
    setFirst(byName, locationKey(doc.name), doc)

    const parentRef = doc.parent
    const parent =
      parentRef && typeof parentRef === 'object' ? parentRef : byId.get(String(parentRef ?? ''))

    if (parent) {
      setFirst(byParentAndName, `${locationKey(parent.name)}|${locationKey(doc.name)}`, doc)
      setFirst(byParentAndName, `${locationKey(parent.slug)}|${locationKey(doc.name)}`, doc)
    }
  }

  for (const [alias, target] of Object.entries(aliases)) {
    const doc = bySlug.get(locationKey(target))
    if (doc) setFirst(byName, locationKey(alias), doc)
  }

  return { byName, byParentAndName, bySlug }
}

/**
 * A legacy address as parts. The job form writes `Town, Island`, and the theme reads it back by
 * splitting on the comma (`displaySavedAddress`), so the same split is used here. A string
 * without a comma is a single part: an island, a town, a catch-all or a free-text address.
 */
export const parseLegacyAddress = (value: null | string | undefined): string[] =>
  legacyText(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

/** Resolve one legacy address string, or `null` when the tenant's tree has no such place. */
export const resolveLegacyLocation = (
  address: null | string | undefined,
  index: LocationIndex,
): LocationMatch | null => {
  const parts = parseLegacyAddress(address).map(locationKey).filter(Boolean)
  if (parts.length === 0) return null

  const lookup = (key: string): LocationMatch | null => {
    const byName = index.byName.get(key)
    if (byName) return { doc: byName, via: 'name' }
    const bySlug = index.bySlug.get(key)
    if (bySlug) return { doc: bySlug, via: 'slug' }

    return null
  }

  // The picker writes exactly `Town, Island`. A town only counts when an island in the same
  // string is its parent, so the pairs are tried before any single part.
  for (let i = 0; i < parts.length - 1; i++) {
    const pair = index.byParentAndName.get(`${parts[i + 1]!}|${parts[i]!}`)
    if (pair) return { doc: pair, via: 'name-and-parent' }
  }

  // Then the most specific single part: a free-text address ends in its own place name
  // (`… Campus, Santo, Vanuatu`), and the island is what the legacy listing shows for a town
  // that is no longer in that island's subtree.
  for (let i = parts.length - 1; i >= 0; i--) {
    const match = lookup(parts[i]!)
    if (match) return match
  }

  return null
}

/** One or more addresses in a single label, separated by `;` or `|` (a job may list several). */
export const resolveLegacyLocations = (
  label: null | string | undefined,
  index: LocationIndex,
): { label: string; matched: LocationMatch[]; unmatched: string[] } => {
  const addresses = legacyText(label)
    .split(/[;|]/)
    .map((part) => part.trim())
    .filter(Boolean)
  const matched: LocationMatch[] = []
  const unmatched: string[] = []

  for (const address of addresses) {
    const match = resolveLegacyLocation(address, index)
    if (!match) {
      unmatched.push(address)
      continue
    }

    if (!matched.some((candidate) => String(candidate.doc.id) === String(match.doc.id))) {
      matched.push(match)
    }
  }

  return { label: legacyText(label), matched, unmatched }
}

/**
 * The location of one job, from its meta: the picker pair when both halves are there (the form
 * writes them from the same string), otherwise whatever address the form stored. `null` when
 * the meta has no location at all.
 */
export const legacyAddressLabel = (meta: LegacyLocationMeta): null | string => {
  const town = legacyText(meta[META.town])
  const region = legacyText(meta[META.region])

  if (town && region) return locationKey(town) === locationKey(region) ? region : `${town}, ${region}`
  if (region) return region
  if (town) return town

  return legacyText(meta[META.shortAddress]) || legacyText(meta[META.address]) || null
}

/** Sort a copy. `toSorted` is ES2023, past this package's lib, and `apps/cms` builds this. */
const sorted = <T>(values: readonly T[], compare: (a: T, b: T) => number): T[] => {
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...values].sort(compare)
}

export type LegacyLocationLabel = { label: string; postIds: number[] }

/**
 * The distinct location labels used by legacy jobs, sorted, so a report reads the same on every
 * run. Read from the meta table alone: the posts add nothing, and this way meta left behind by
 * a deleted post still shows up as a label to check.
 */
export const readLegacyLocationLabels = async (
  reader: MysqlReader,
): Promise<LegacyLocationLabel[]> => {
  const where = `meta_key IN (${LOCATION_META_KEYS.map(() => '?').join(', ')})`
  const metaByPost = new Map<number, LegacyLocationMeta>()

  for await (const row of reader.rows<Record<string, unknown>>('postmeta', {
    key: 'meta_id',
    params: [...LOCATION_META_KEYS],
    where,
  })) {
    const postId = Number(row.post_id)
    const key = String(row.meta_key ?? '') as (typeof LOCATION_META_KEYS)[number]
    if (!Number.isInteger(postId) || !LOCATION_META_KEYS.includes(key)) continue

    metaByPost.set(postId, {
      ...metaByPost.get(postId),
      [key]: row.meta_value === null ? '' : String(row.meta_value ?? ''),
    })
  }

  const postsByLabel = new Map<string, number[]>()
  for (const [postId, meta] of metaByPost) {
    const label = legacyAddressLabel(meta)
    if (!label) continue

    const posts = postsByLabel.get(label) ?? []
    posts.push(postId)
    postsByLabel.set(label, posts)
  }

  const labels = [...postsByLabel.entries()].map(([label, postIds]) => ({
    label,
    postIds: sorted(postIds, (a, b) => a - b),
  }))

  return sorted(labels, (a, b) => a.label.localeCompare(b.label))
}

const tenantLocationIndex = async (
  ctx: ImportContext,
  cache: Map<string, LocationIndex>,
): Promise<LocationIndex> => {
  const cached = cache.get(String(ctx.tenant))
  if (cached) return cached

  const { docs } = await ctx.payload.find({
    collection: 'locations',
    // The parent is compared by name or slug, so it has to be resolved.
    depth: 1,
    overrideAccess: true,
    pagination: false,
    where: { tenant: { equals: ctx.tenant } },
  })
  const index = buildLocationIndex(docs as unknown as LocationDoc[])
  cache.set(String(ctx.tenant), index)

  return index
}

/**
 * Audit importer: every distinct legacy job location must already exist in the tenant's tree
 * (seeded by PJ-17; the tree is tenant content, not import data). A matched label counts as
 * skipped — there is nothing to write — and an unmatched label is a failure, because a job
 * using it would import without a location. Run it with `--dry-run` to list the gaps, add the
 * missing places to the tenant, and run it again.
 */
export const locationsImporter = (): Importer<LegacyLocationLabel> => {
  const cache = new Map<string, LocationIndex>()

  return {
    collection: 'locations',
    dependsOn: [],
    map: async (row, ctx) => {
      const index = await tenantLocationIndex(ctx, cache)
      const { unmatched } = resolveLegacyLocations(row.label, index)

      if (unmatched.length > 0) {
        throw new Error(
          `Legacy location "${row.label}" (post ${row.postIds.join(', ') || 'unknown'}) ` +
            `matches no location in this tenant: ${unmatched.join(' / ')}`,
        )
      }

      return null
    },
    name: 'locations',
    read: async function* (reader) {
      for (const label of await readLegacyLocationLabels(reader)) yield label
    },
  }
}
