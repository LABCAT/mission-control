import type { CollectionSlug, Payload } from 'payload'

import { slugifyLocationName, type LocationKind } from '../collections/locations'
import { LEGACY_CATCH_ALL_REGIONS, LEGACY_REGIONS_AND_TOWNS } from './legacy-regions-and-towns'

/** A location to create, with its parent addressed by slug so parents are created first. */
export type LocationSeed = {
  kind: LocationKind
  name: string
  parentSlug: null | string
  slug: string
}

/**
 * The legacy picker is two levels deep: island keys, town values, and no province layer. The
 * seed keeps that shape — inventing a region above each island would add data the migration
 * cannot verify. `Overseas` and `Other` are catch-alls rather than places, so they become
 * region roots; the duplicate children they list (the key repeated as its own town) are dropped.
 */
const CATCH_ALL: readonly string[] = LEGACY_CATCH_ALL_REGIONS

const rootKindFor = (legacyKey: string): LocationKind =>
  CATCH_ALL.includes(legacyKey) ? 'region' : 'island'

/**
 * Build the Vanuatu location tree from the legacy picker. Pure, so tests can check it without
 * a database.
 *
 * Throws when two nodes would share a slug: that means the seed no longer matches the source
 * data, and it would collide on the per-tenant slug index at seed time.
 */
export const parseVanuatuLocations = (
  regionsAndTowns: Record<string, string[]> = LEGACY_REGIONS_AND_TOWNS,
): LocationSeed[] => {
  const seeds: LocationSeed[] = []
  const add = (name: string, kind: LocationKind, parentSlug: null | string): string => {
    const slug = slugifyLocationName(name)
    seeds.push({ kind, name, parentSlug, slug })

    return slug
  }

  for (const [legacyKey, towns] of Object.entries(regionsAndTowns)) {
    const rootSlug = add(legacyKey, rootKindFor(legacyKey), null)

    for (const town of towns) {
      if (slugifyLocationName(town) === rootSlug) continue

      add(town, 'town', rootSlug)
    }
  }

  const seen = new Set<string>()
  for (const seed of seeds) {
    if (seen.has(seed.slug)) {
      throw new Error(`The Vanuatu seed produces the duplicate slug "${seed.slug}"`)
    }

    seen.add(seed.slug)
  }

  return seeds
}

type TenantRef = number | { id: number }

type SeedVanuatuOptions = {
  /** Resolved locations collection slug. Defaults to `locations`. */
  collectionSlug?: string
  log?: (message: string) => void
  /** The three calls the seed needs; a full `Payload` instance satisfies this. */
  payload: Pick<Payload, 'create' | 'find' | 'update'>
  tenant: TenantRef
}

const tenantIDOf = (tenant: TenantRef): number =>
  typeof tenant === 'object' ? tenant.id : tenant

/**
 * Create or update one tenant's Vanuatu locations. Safe to run repeatedly: locations are
 * matched by slug inside the tenant, so a second run updates names, kinds and parents rather
 * than duplicating the tree. Seed data, not tenant configuration — a tenant that wants a
 * different tree edits its own locations.
 */
export const seedVanuatuLocations = async ({
  collectionSlug = 'locations',
  log,
  payload,
  tenant,
}: SeedVanuatuOptions): Promise<{ created: number; updated: number }> => {
  const tenantID = tenantIDOf(tenant)
  const seeds = parseVanuatuLocations()

  const existing = await payload.find({
    collection: collectionSlug as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: { tenant: { equals: tenantID } },
  })

  const idsBySlug = new Map<string, number>()
  for (const doc of existing.docs) {
    const slug = (doc as { slug?: null | string }).slug
    if (slug) idsBySlug.set(slug, Number(doc.id))
  }

  let created = 0
  let updated = 0

  for (const seed of seeds) {
    const parent = seed.parentSlug === null ? null : (idsBySlug.get(seed.parentSlug) ?? null)
    if (seed.parentSlug !== null && parent === null) {
      throw new Error(`Seed order is broken: "${seed.slug}" needs "${seed.parentSlug}" first`)
    }

    const data = { kind: seed.kind, name: seed.name, parent, slug: seed.slug, tenant: tenantID }
    const found = idsBySlug.get(seed.slug)

    if (found === undefined) {
      const doc = await payload.create({ collection: collectionSlug as CollectionSlug, data, overrideAccess: true })
      idsBySlug.set(seed.slug, Number(doc.id))
      created += 1
    } else {
      await payload.update({ collection: collectionSlug as CollectionSlug, data, id: found, overrideAccess: true })
      updated += 1
    }
  }

  log?.(`Vanuatu locations for tenant ${String(tenantID)}: ${created} created, ${updated} updated`)

  return { created, updated }
}
