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
      depth: 0,
      name: 'Efate',
      parentSlug: null,
      slug: 'efate',
    })
    expect(bySlug.get('port-vila')).toEqual({
      depth: 1,
      name: 'Port Vila',
      parentSlug: 'efate',
      slug: 'port-vila',
    })
    expect(bySlug.get('espiritu-santo')).toMatchObject({ depth: 0, parentSlug: null })
    expect(bySlug.get('luganville')).toMatchObject({
      depth: 1,
      parentSlug: 'espiritu-santo',
    })
  })

  it('treats the catch-alls as roots and keeps their real towns', () => {
    expect(bySlug.get('overseas')).toEqual({
      depth: 0,
      name: 'Overseas',
      parentSlug: null,
      slug: 'overseas',
    })
    expect(bySlug.get('other')).toMatchObject({ depth: 0, parentSlug: null })
    expect(bySlug.get('anywhere-work-from-home')).toMatchObject({
      depth: 1,
      parentSlug: 'other',
    })

    // The picker's `Overseas: ["Overseas"]` and `Other: ["Other"]` self-pairs are dropped.
    expect(seeds.filter((seed) => seed.slug === 'overseas')).toHaveLength(1)
    expect(seeds.filter((seed) => seed.slug === 'other')).toHaveLength(1)
  })

  it('seeds Nationwide and Remote / anywhere as childless roots', () => {
    expect(bySlug.get('nationwide')).toEqual({
      depth: 0,
      name: 'Nationwide',
      parentSlug: null,
      slug: 'nationwide',
    })
    expect(bySlug.get('remote-anywhere')).toMatchObject({ depth: 0, parentSlug: null })
    expect(seeds.some((seed) => seed.parentSlug === 'nationwide')).toBe(false)
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

  it('gives every child its parent’s depth plus one', () => {
    for (const seed of seeds) {
      if (seed.parentSlug === null) {
        expect(seed.depth, `${seed.slug} should be a root`).toBe(0)
        continue
      }

      const parent = bySlug.get(seed.parentSlug)
      expect(parent, `${seed.slug} has no parent`).toBeDefined()
      expect(seed.depth, `${seed.slug} should sit one level under ${seed.parentSlug}`).toBe(
        (parent?.depth ?? -1) + 1,
      )
    }
  })

  it('fails when two legacy entries would collapse to one slug', () => {
    expect(() =>
      parseVanuatuLocations({ ...LEGACY_REGIONS_AND_TOWNS, Pentecost: ['Port Vila'] }),
    ).toThrow('duplicate slug')
  })
})
