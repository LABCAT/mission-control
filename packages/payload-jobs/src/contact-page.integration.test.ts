import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { BlocksField, CollectionConfig } from 'payload'

import { bootTestPayload, type TestHarness } from './test'
import {
  contactFormData,
  contactPageLayout,
  seedContactPage,
  type ContactPageSeed,
} from './contact-page'
import { pagesCollection } from './collections/pages'

/**
 * The contact page seed against a real Postgres: a site's contact page is the generic Form
 * block pointing at a contact form, then the Map block. What is under test is the shape and
 * the idempotency, not the block renderers (rocketship-payload covers those).
 */

const Forms: CollectionConfig = {
  slug: 'forms',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'submitButtonLabel', type: 'text' },
    {
      name: 'fields',
      type: 'blocks',
      blocks: ['text', 'email', 'textarea'].map((slug) => ({
        slug,
        fields: [
          { name: 'name', type: 'text' },
          { name: 'label', type: 'text' },
          { name: 'required', type: 'checkbox' },
          { name: 'width', type: 'number' },
        ],
      })),
    },
  ],
  versions: false,
}

/**
 * `blockSlugs` only names the blocks (the CMS registers the configs in `config.blocks`); the
 * harness has no `blocks` option, so the two block configs are supplied here.
 */
const blockConfig = (slug: string): NonNullable<BlocksField['blocks']>[number] => ({
  slug,
  fields:
    slug === 'form'
      ? [{ name: 'form', type: 'relationship', relationTo: 'forms' }]
      : [{ name: 'latitude', type: 'number' }],
})

const Pages = (): CollectionConfig => {
  const collection = pagesCollection({ blockSlugs: ['form', 'map'], mediaSlug: null })

  return {
    ...collection,
    fields: collection.fields.map((field) =>
      'name' in field && field.name === 'layout'
        ? { ...field, blocks: ['form', 'map'].map(blockConfig) }
        : field,
    ),
  }
}

const seed: ContactPageSeed = {
  fields: [
    { kind: 'text', label: 'Your Name', name: 'your-name', required: true },
    { kind: 'email', label: 'Your email', name: 'your-email', required: true },
    { kind: 'textarea', label: 'Message', name: 'message', required: true },
  ],
  formTitle: 'Contact',
  heading: 'Contact us',
  map: { latitude: -17.7495, longitude: 168.3149, provider: 'google', zoom: 16 },
}

type StoredPage = {
  id: number
  layout?: { blockType?: string; form?: unknown }[]
  role?: null | string
  slug?: null | string
}

let harness: TestHarness

const pagesOf = async (tenantID: number | string): Promise<StoredPage[]> =>
  (
    await harness.payload.find({
      collection: 'pages',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      where: { tenant: { equals: tenantID } },
    })
  ).docs as unknown as StoredPage[]

const formsOf = async (tenantID: number | string) =>
  (
    await harness.payload.find({
      collection: 'forms',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      where: { tenant: { equals: tenantID } },
    })
  ).docs as unknown as { id: number; title: string; fields?: unknown[] }[]

const run = (tenantID: number | string) =>
  seedContactPage(harness.payload, { seed, tenantID })

describe('contact page seed @S-323', () => {
  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [Pages(), Forms],
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('creates the form, and the contact page with the form block before the map', async () => {
    const result = await run(harness.tenantA.id)

    expect(result.formCreated).toBe(true)
    expect(result.blocksAdded).toEqual(['form', 'map'])

    const forms = await formsOf(harness.tenantA.id)
    expect(forms).toHaveLength(1)
    expect(forms[0]).toMatchObject({ title: 'Contact' })
    expect(forms[0]!.fields).toHaveLength(3)

    const page = (await pagesOf(harness.tenantA.id)).find((doc) => doc.role === 'contact')!
    expect(page.slug).toBe('contact')
    expect(page.layout?.map((block) => block.blockType)).toEqual(['form', 'map'])
    expect(page.layout?.[0]!.form).toBe(result.formID)
  })

  it('is idempotent: a second run creates nothing and adds no block @S-323', async () => {
    const before = { forms: (await formsOf(harness.tenantA.id)).length, pages: (await pagesOf(harness.tenantA.id)).length }

    const result = await run(harness.tenantA.id)

    expect(result.formCreated).toBe(false)
    expect(result.blocksAdded).toEqual([])
    expect((await formsOf(harness.tenantA.id)).length).toBe(before.forms)
    expect((await pagesOf(harness.tenantA.id)).length).toBe(before.pages)
  })

  it('keeps the blocks an editor already arranged, and adds only what is missing', async () => {
    // Seed once, then drop the map block as an editor would.
    await run(harness.tenantB.id)

    const seeded = (await pagesOf(harness.tenantB.id)).find((doc) => doc.role === 'contact')!
    await harness.payload.update({
      collection: 'pages',
      data: { layout: (seeded.layout ?? []).filter((block) => block.blockType === 'form') } as never,
      id: seeded.id,
      overrideAccess: true,
    })

    const result = await run(harness.tenantB.id)

    expect(result.blocksAdded).toEqual(['map'])

    const updated = (await pagesOf(harness.tenantB.id)).find((doc) => doc.role === 'contact')!
    expect(updated.layout?.map((block) => block.blockType)).toEqual(['form', 'map'])
  })

  it('gives each site its own form, never another site’s', async () => {
    const formsA = await formsOf(harness.tenantA.id)
    const formsB = await formsOf(harness.tenantB.id)

    expect(formsA).toHaveLength(1)
    expect(formsB).toHaveLength(1)
    expect(formsA[0]!.id).not.toBe(formsB[0]!.id)
  })
})

describe('contact page shape', () => {
  it('marks the fields the legacy page required @S-323', () => {
    const data = contactFormData(seed) as { fields: { blockType: string; required: boolean }[] }

    expect(data.fields.filter((field) => field.required)).toHaveLength(3)
  })

  it('carries the map settings through to the block', () => {
    const [, map] = contactPageLayout(1, seed)

    expect(map).toMatchObject({ blockType: 'map', latitude: -17.7495, provider: 'google', zoom: 16 })
  })
})
