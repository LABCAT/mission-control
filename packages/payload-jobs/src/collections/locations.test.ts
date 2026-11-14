import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { payloadJobs } from '../index'
import {
  ALLOWED_PARENT_KINDS,
  LOCATION_KINDS,
  Locations,
  slugifyLocationName,
} from './locations'

const baseConfig = {
  collections: [{ slug: 'users', fields: [] }],
  secret: 'test',
} as unknown as Config

const fieldNamed = (name: string) =>
  Locations.fields.find((field) => 'name' in field && field.name === name)

const requestFor = (user: unknown) => ({ req: { user } }) as never

describe('locations collection', () => {
  it('is registered by the plugin without touching the host collections', async () => {
    const config = await payloadJobs()(baseConfig)

    expect(config.collections?.map((collection) => collection.slug)).toEqual(['users', 'locations'])
    expect(Locations.slug).toBe('locations')
    expect(Locations.versions).toBe(false)
  })

  it('refuses to register twice rather than silently dropping one definition', () => {
    expect(() =>
      payloadJobs()({
        collections: [{ slug: 'users', fields: [] }, { slug: 'locations', fields: [] }],
        secret: 'test',
      } as unknown as Config),
    ).toThrow('locations')
  })

  it('has the tree fields the task asks for, plus legacyId for the importer', () => {
    expect(Locations.fields.map((field) => ('name' in field ? field.name : field.type))).toEqual([
      'name',
      'slug',
      'kind',
      'parent',
      'legacyId',
    ])

    expect(fieldNamed('kind')).toMatchObject({ type: 'select', required: true })
    expect(fieldNamed('parent')).toMatchObject({ relationTo: 'locations', type: 'relationship' })
    expect(fieldNamed('legacyId')).toMatchObject({ index: true, type: 'number' })
  })

  it('lets anyone read locations but only tenant staff write them', () => {
    const { access } = Locations

    expect(access?.read?.(requestFor(null))).toBe(true)

    expect(access?.create?.(requestFor(null))).toBe(false)
    expect(access?.create?.(requestFor({ role: 'user', tenants: [] }))).toBe(false)
    expect(
      access?.create?.(requestFor({ role: 'user', tenants: [{ role: 'employer', tenant: 1 }] })),
    ).toBe(false)
    expect(
      access?.create?.(requestFor({ role: 'user', tenants: [{ role: 'editor', tenant: 1 }] })),
    ).toBe(true)
    expect(
      access?.update?.(requestFor({ role: 'user', tenants: [{ role: 'tenant-admin', tenant: 1 }] })),
    ).toBe(true)
    expect(access?.delete?.(requestFor({ role: 'super-admin' }))).toBe(true)
  })

  it('orders kinds strictly so a parent cycle is impossible', () => {
    expect([...LOCATION_KINDS]).toEqual(['region', 'island', 'town'])
    expect(ALLOWED_PARENT_KINDS.region).toEqual([])
    expect(ALLOWED_PARENT_KINDS.island).toEqual(['region'])
    expect(ALLOWED_PARENT_KINDS.town).toEqual(['region', 'island'])
  })

  it('slugifies legacy names into lowercase ASCII slugs', () => {
    expect(slugifyLocationName('Port Vila')).toBe('port-vila')
    expect(slugifyLocationName('Espiritu Santo')).toBe('espiritu-santo')
    expect(slugifyLocationName('Anywhere/Work From Home')).toBe('anywhere-work-from-home')
    expect(slugifyLocationName('Sulphur Bay')).toBe('sulphur-bay')
  })
})
