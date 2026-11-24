import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  legalPageLayout,
  legalPlaceholderContent,
  LEGAL_PAGE_SEEDS,
  seedLegalPages,
  seedTenantLegalPages,
} from './legal-pages'
import type { Block } from 'payload'
import { pagesCollection } from './collections/pages'
import { bootTestPayload, type TestHarness, type TestTenant } from './test'

type StoredPage = {
  _status?: string
  id: number | string
  layout?: { blockType?: string; content?: unknown; heading?: string }[]
  slug?: null | string
  tenant: number | string
  title: string
}

// The host registers this in `config.blocks` (PJ-84); the seed only needs the slug to exist.
const richTextBlock: Block = {
  slug: 'rich-text',
  fields: [{ name: 'content', type: 'richText', required: true }],
}

const fieldMessages = (error: unknown): string =>
  ((error as { data?: { errors?: { message: string }[] } }).data?.errors ?? [])
    .map((fieldError) => fieldError.message)
    .join(' | ')

const pagesOf = async (harness: TestHarness, tenantID: number | string): Promise<StoredPage[]> =>
  (
    await harness.payload.find({
      collection: 'pages',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      where: { tenant: { equals: tenantID } },
    })
  ).docs as unknown as StoredPage[]

describe('legal pages', () => {
  it('seeds a privacy policy and terms page, with fixed slugs and no system role', () => {
    expect(LEGAL_PAGE_SEEDS.map((seed) => seed.slug)).toEqual(['privacy', 'terms'])
    expect(LEGAL_PAGE_SEEDS.map((seed) => seed.title)).toEqual(['Privacy policy', 'Terms of use'])
  })

  it('puts a placeholder body in only when the host registered the rich-text block', () => {
    const withBlock = legalPageLayout(['hero', 'rich-text'])
    const withoutBlock = legalPageLayout(['hero'])

    expect(withBlock).toHaveLength(1)
    expect(withBlock[0]).toMatchObject({ blockType: 'rich-text' })
    expect(JSON.stringify(withBlock)).toContain('PLACEHOLDER')
    // The policy wording is the founder's: the placeholder must not state any policy.
    expect(JSON.stringify(withBlock)).toContain('founder writes or approves')
    expect(withoutBlock).toEqual([])
  })

  it('writes a Lexical value the rich-text block accepts', () => {
    const content = legalPlaceholderContent() as { root: { children: { type: string }[]; type: string } }

    expect(content.root.type).toBe('root')
    expect(content.root.children.length).toBeGreaterThan(0)
    expect(content.root.children.every((node) => node.type === 'paragraph')).toBe(true)
  })
})

describe('legal pages in Postgres @S-310', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = await bootTestPayload({
      blocks: [richTextBlock],
      collections: [pagesCollection({ blockSlugs: ['rich-text'], mediaSlug: null })],
      tenantFields: [{ name: 'isAggregate', type: 'checkbox', defaultValue: false }],
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('creates the two pages as drafts with placeholder text @S-310', async () => {
    const created = await seedLegalPages(harness.payload, {
      blockSlugs: ['rich-text'],
      tenantID: harness.tenantA.id,
    })

    expect(created).toHaveLength(2)

    const pages = await pagesOf(harness, harness.tenantA.id)
    expect(pages.map((page) => page.slug).sort()).toEqual(['privacy', 'terms'])
    for (const page of pages) {
      expect(page._status).toBe('draft')
      expect(JSON.stringify(page.layout)).toContain('PLACEHOLDER')
    }
  })

  it('leaves an edited page alone on a re-run, published or not @S-310', async () => {
    const [privacy] = (await pagesOf(harness, harness.tenantA.id)).filter(
      (page) => page.slug === 'privacy',
    )
    await harness.payload.update({
      collection: 'pages',
      data: { _status: 'published', title: 'Our privacy promise' } as never,
      id: privacy.id,
      overrideAccess: true,
    })

    await seedLegalPages(harness.payload, {
      blockSlugs: ['rich-text'],
      tenantID: harness.tenantA.id,
    })

    const pages = await pagesOf(harness, harness.tenantA.id)
    expect(pages).toHaveLength(2)
    const stored = pages.find((page) => page.slug === 'privacy')
    expect(stored?.title).toBe('Our privacy promise')
    expect(stored?._status).toBe('published')
  })

  it('seeds each site separately @S-310', async () => {
    await seedLegalPages(harness.payload, { tenantID: harness.tenantB.id })

    const pages = await pagesOf(harness, harness.tenantB.id)
    expect(pages.map((page) => page.slug).sort()).toEqual(['privacy', 'terms'])
    expect(new Set(pages.map((page) => page.tenant)).size).toBe(1)
  })

  it('runs from the tenant hook on create and skips the aggregate tenant @S-310', async () => {
    const hook = seedTenantLegalPages({ blockSlugs: ['rich-text'] })
    const req = { payload: harness.payload } as never

    const site = (await harness.payload.create({
      collection: 'tenants',
      data: { name: 'Tenant C', slug: `tenant-c-${Date.now().toString(36)}` } as never,
      overrideAccess: true,
    })) as TestTenant
    await hook({ doc: site as unknown as Record<string, unknown>, operation: 'create', req })
    expect(await pagesOf(harness, site.id)).toHaveLength(2)

    const directory = (await harness.payload.create({
      collection: 'tenants',
      data: { isAggregate: true, name: 'Directory', slug: `directory-${Date.now().toString(36)}` } as never,
      overrideAccess: true,
    })) as TestTenant
    await hook({ doc: directory as unknown as Record<string, unknown>, operation: 'create', req })
    expect(await pagesOf(harness, directory.id)).toHaveLength(0)

    // Only a create seeds: an update must not add pages to a site that deleted them.
    await hook({ doc: site as unknown as Record<string, unknown>, operation: 'update', req })
    expect(await pagesOf(harness, site.id)).toHaveLength(2)

    await harness.payload.delete({ collection: 'tenants', id: site.id, overrideAccess: true })
    await harness.payload.delete({ collection: 'tenants', id: directory.id, overrideAccess: true })
  })

  it('refuses a second page on the same address, so the seed never duplicates one @S-310', async () => {
    const error = await harness.payload
      .create({
        collection: 'pages',
        data: {
          _status: 'draft',
          slug: 'privacy',
          tenant: harness.tenantB.id,
          title: 'Another privacy policy',
        } as never,
        overrideAccess: true,
      })
      .catch((caught: unknown) => caught)

    expect(fieldMessages(error)).toMatch(/already used/)
  })
})
