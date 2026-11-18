import { describe, expect, it } from 'vitest'

import { LEGACY_REGIONS_AND_TOWNS } from './legacy-regions-and-towns'
import { parseVanuatuLocations } from './vanuatu'

const seeds = parseVanuatuLocations()
const bySlug = new Map(seeds.map((seed) => [seed.slug, seed]))

const legacyTownNames = Object.entries(LEGACY_REGIONS_AND_TOWNS).flatMap(([region, towns]) =>
  towns.filter((town) => town !== region),
)

describe('Vanuatu location seed', () => {
  it('keeps every legacy key and town', () => {
    for (const legacyKey of Object.keys(LEGACY_REGIONS_AND_TOWNS)) {
      expect(bySlug.get(legacyKey.toLowerCase().replace(/\s+/g, '-')), legacyKey).toBeDefined()
    }

    for (const town of legacyTownNames) {
      expect(
        seeds.find((seed) => seed.name === town),
        `missing legacy town ${town}`,
      ).toBeDefined()
    }
  })

  it('mirrors the legacy two-level picker: island → town', () => {
    expect(bySlug.get('efate')).toEqual({
      kind: 'island',
      name: 'Efate',
      parentSlug: null,
      slug: 'efate',
    })
    expect(bySlug.get('port-vila')).toEqual({
      kind: 'town',
      name: 'Port Vila',
      parentSlug: 'efate',
      slug: 'port-vila',
    })
    expect(bySlug.get('espiritu-santo')).toMatchObject({ kind: 'island', parentSlug: null })
    expect(bySlug.get('luganville')).toMatchObject({
      kind: 'town',
      parentSlug: 'espiritu-santo',
    })
  })

  it('treats the catch-alls as roots and keeps their real towns', () => {
    expect(bySlug.get('overseas')).toEqual({
      kind: 'region',
      name: 'Overseas',
      parentSlug: null,
      slug: 'overseas',
    })
    expect(bySlug.get('other')).toMatchObject({ kind: 'region', parentSlug: null })
    expect(bySlug.get('anywhere-work-from-home')).toMatchObject({
      kind: 'town',
      parentSlug: 'other',
    })

    // The picker's `Overseas: ["Overseas"]` and `Other: ["Other"]` self-pairs are dropped.
    expect(seeds.filter((seed) => seed.slug === 'overseas')).toHaveLength(1)
    expect(seeds.filter((seed) => seed.slug === 'other')).toHaveLength(1)
  })

  it('hangs every legacy town off the island the picker lists it under', () => {
    for (const [legacyKey, towns] of Object.entries(LEGACY_REGIONS_AND_TOWNS)) {
      const root = bySlug.get(legacyKey.toLowerCase().replace(/\s+/g, '-'))

      for (const town of towns) {
        if (town === legacyKey) continue

        expect(
          bySlug.get(town.toLowerCase().replace(/[^a-z0-9]+/g, '-'))?.parentSlug,
          `${town} should hang off ${legacyKey}`,
        ).toBe(root?.slug)
      }
    }
  })

  it('produces unique slugs and parents that exist before their children', () => {
    const slugs = seeds.map((seed) => seed.slug)
    expect(new Set(slugs).size).toBe(slugs.length)

    const seen: string[] = []
    for (const seed of seeds) {
      if (seed.parentSlug !== null) {
        expect(seen, `${seed.slug} is seeded before its parent`).toContain(seed.parentSlug)
      }

      seen.push(seed.slug)
    }
  })

  it('creates no towns without an island or catch-all parent', () => {
    for (const town of seeds.filter((seed) => seed.kind === 'town')) {
      const parent = bySlug.get(town.parentSlug ?? '')

      expect(parent, `${town.slug} has no parent`).toBeDefined()
      expect(['island', 'region']).toContain(parent?.kind)
    }
  })

  it('fails when two legacy entries would collapse to one slug', () => {
    expect(() =>
      parseVanuatuLocations({ ...LEGACY_REGIONS_AND_TOWNS, Pentecost: ['Port Vila'] }),
    ).toThrow('duplicate slug')
  })
})
