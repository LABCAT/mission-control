import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { locationsCollection } from './collections/locations'
import { DEFAULT_RESERVED_SLUGS, slugRulesFor } from './slug-rules'
import { taxonomyCollections } from './taxonomies'
import { bootTestPayload, type TestHarness } from './test'

/** Payload's top-level message is generic, so assert on the per-field messages. */
const fieldMessages = (error: unknown): string =>
  ((error as { data?: { errors?: { message: string }[] } }).data?.errors ?? [])
    .map((fieldError) => fieldError.message)
    .join(' | ')

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => '',
    (reason: unknown) => fieldMessages(reason),
  )

type Kind = 'job-categories' | 'job-types' | 'locations'

describe('slugs are unique across categories, locations and job types per tenant @S-120', () => {
  let harness: TestHarness
  let counter = 0

  beforeAll(async () => {
    const rules = slugRulesFor({
      jobCategories: 'job-categories',
      jobTypes: 'job-types',
      locations: 'locations',
    })
    harness = await bootTestPayload({
      collections: [
        locationsCollection({ requireTenant: true, slugRules: rules }),
        ...taxonomyCollections({ tenantScoped: true }),
      ],
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  const create = (collection: Kind, slug: string, tenant: number | string, extra = {}) =>
    harness.payload.create({
      collection,
      data: { name: `n${counter++}`, slug, tenant, ...extra } as never,
      overrideAccess: true,
    }) as Promise<{ id: number | string }>

  const kinds: Kind[] = ['job-categories', 'locations', 'job-types']

  for (const first of kinds) {
    for (const second of kinds.filter((kind) => kind !== first)) {
      it(`refuses a ${second} slug already used by a ${first}, in this direction`, async () => {
        const slug = `${first}-then-${second}`
        await create(first, slug, harness.tenantA.id)
        expect(await failure(create(second, slug, harness.tenantA.id))).toMatch(/already used by a/)
      })
    }
  }

  it('applies to every level of the location tree', async () => {
    const island = await create('locations', 'deep-island', harness.tenantA.id)
    const town = await create('locations', 'deep-town', harness.tenantA.id, { parent: island.id })
    await create('locations', 'deep-village', harness.tenantA.id, { parent: town.id })

    expect(await failure(create('job-categories', 'deep-village', harness.tenantA.id))).toMatch(
      /location/,
    )
    expect(await failure(create('job-types', 'deep-town', harness.tenantA.id))).toMatch(/location/)
  })

  it('still refuses a duplicate inside one collection', async () => {
    await create('job-categories', 'dup-category', harness.tenantA.id)
    expect(await failure(create('job-categories', 'dup-category', harness.tenantA.id))).toMatch(
      /another job category/,
    )
  })

  it('refuses every reserved word in each collection', async () => {
    for (const word of DEFAULT_RESERVED_SLUGS) {
      for (const kind of kinds) {
        expect(await failure(create(kind, word, harness.tenantA.id)), `${kind} ${word}`).toMatch(
          /reserved/,
        )
      }
    }
  })

  it('keeps tenants isolated: another tenant may reuse a slug', async () => {
    await create('job-categories', 'shared-by-tenants', harness.tenantA.id)
    await expect(create('locations', 'shared-by-tenants', harness.tenantB.id)).resolves.toBeDefined()
    await expect(create('job-types', 'shared-by-tenants', harness.tenantB.id)).rejects.toBeDefined()
  })

  it('lets a document keep its own slug when it is updated', async () => {
    const category = await create('job-categories', 'keeps-slug', harness.tenantA.id)
    await expect(
      harness.payload.update({
        collection: 'job-categories',
        data: { name: 'Renamed', slug: 'keeps-slug' } as never,
        id: category.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ slug: 'keeps-slug' })
  })

  it('checks a rename against the other collections and releases the old slug', async () => {
    await create('locations', 'taken-by-location', harness.tenantA.id)
    const category = await create('job-categories', 'rename-me', harness.tenantA.id)

    const rename = (slug: string) =>
      harness.payload.update({
        collection: 'job-categories',
        data: { slug } as never,
        id: category.id,
        overrideAccess: true,
      })

    expect(await failure(rename('taken-by-location'))).toMatch(/location/)
    expect(await failure(rename('page'))).toMatch(/reserved/)

    await rename('renamed-free')
    // The old slug is free again, for any of the three.
    await expect(create('job-types', 'rename-me', harness.tenantA.id)).resolves.toBeDefined()
    // And the new one is taken.
    expect(await failure(create('locations', 'renamed-free', harness.tenantA.id))).toMatch(
      /job category/,
    )
  })

  it('renames a location against categories and job types', async () => {
    await create('job-types', 'type-slug', harness.tenantA.id)
    const location = await create('locations', 'loc-rename', harness.tenantA.id)
    const error = await harness.payload
      .update({
        collection: 'locations',
        data: { slug: 'type-slug' } as never,
        id: location.id,
        overrideAccess: true,
      })
      .then(
        () => '',
        (reason: unknown) => fieldMessages(reason),
      )
    expect(error).toMatch(/job type/)
  })
})
