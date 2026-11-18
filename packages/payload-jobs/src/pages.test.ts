import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pagesCollection } from './pages'
import { bootTestPayload, type TestHarness } from './test'

const richText = (text: string) => ({
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
})

let harness: TestHarness

beforeAll(async () => {
  harness = await bootTestPayload({ collections: [pagesCollection()], media: true })
}, 120_000)

afterAll(async () => {
  await harness.destroy()
})

const createPage = (data: Record<string, unknown>, user: 'a' | 'b' | 'super' = 'a') =>
  harness.payload.create({
    collection: 'pages',
    data: { tenant: user === 'b' ? harness.tenantB.id : harness.tenantA.id, ...data } as never,
    user: user === 'super' ? harness.superAdmin : user === 'b' ? harness.tenantAdminB : harness.tenantAdminA,
  } as never)

describe('pages', () => {
  it('derives a slug from the title when none is given', async () => {
    const page = (await createPage({ title: 'Working in Vanuatu' })) as { slug?: string }

    expect(page.slug).toBe('working-in-vanuatu')
  })

  it('slugifies an explicitly supplied slug instead of storing it verbatim', async () => {
    const page = (await createPage({ slug: 'Our Team!', title: 'Our team' })) as { slug?: string }

    expect(page.slug).toBe('our-team')
  })

  it('normalizes a messy explicit slug rather than storing it verbatim', async () => {
    const page = (await createPage({ slug: 'Not A Slug', title: 'Messy slug' })) as { slug?: string }

    expect(page.slug).toBe('not-a-slug')
  })

  it('falls back to the title when the supplied slug slugifies to nothing', async () => {
    const page = (await createPage({ slug: '!!!', title: 'Fallback title' })) as { slug?: string }

    expect(page.slug).toBe('fallback-title')
  })

  it('rejects a page without a title', async () => {
    await expect(createPage({ slug: 'no-title' })).rejects.toThrow(/title/i)
  })

  it('keeps slugs unique inside a tenant', async () => {
    await createPage({ slug: 'about-us', title: 'About us' })

    await expect(createPage({ slug: 'about-us', title: 'About us again' })).rejects.toThrow()
  })

  it('allows the same slug in two tenants', async () => {
    const other = (await harness.payload.create({
      collection: 'pages',
      data: { slug: 'terms', tenant: harness.tenantB.id, title: 'Terms' } as never,
      depth: 0,
      user: harness.tenantAdminB,
    })) as { slug?: string; tenant?: number }

    const mine = (await createPage({ slug: 'terms', title: 'Terms' })) as { slug?: string }

    expect(other.slug).toBe('terms')
    expect(mine.slug).toBe('terms')
    expect(other.tenant).toBe(harness.tenantB.id)
  })

  it('stores rich text content and the SEO group', async () => {
    const created = (await createPage({
      content: richText('Jobs in Port Vila'),
      seo: { description: 'Find work in Port Vila', noIndex: true, title: 'Jobs — Port Vila' },
      slug: 'jobs-port-vila',
      title: 'Jobs in Port Vila',
    })) as {
      content?: { root?: { children?: { children?: { text?: string }[] }[] } }
      seo?: { description?: string; noIndex?: boolean; title?: string }
    }

    expect(created.content?.root?.children?.[0]?.children?.[0]?.text).toBe('Jobs in Port Vila')
    expect(created.seo).toMatchObject({
      description: 'Find work in Port Vila',
      noIndex: true,
      title: 'Jobs — Port Vila',
    })
  })

  it('keeps the WordPress post ID so the importer can match a page', async () => {
    const created = (await createPage({ legacyId: 4211, slug: 'contact', title: 'Contact' })) as {
      legacyId?: number
    }

    expect(created.legacyId).toBe(4211)

    const without = (await createPage({ slug: 'faq', title: 'FAQ' })) as { legacyId?: number | null }
    expect(without.legacyId ?? null).toBeNull()
  })

  it('hides one tenant’s pages from the other tenant’s admin', async () => {
    await createPage({ slug: 'private-to-a', title: 'Private to A' })

    const seenByB = await harness.payload.find({
      collection: 'pages',
      user: harness.tenantAdminB,
      where: { slug: { equals: 'private-to-a' } },
    })
    const seenByA = await harness.payload.find({
      collection: 'pages',
      user: harness.tenantAdminA,
      where: { slug: { equals: 'private-to-a' } },
    })

    expect(seenByB.totalDocs).toBe(0)
    expect(seenByA.totalDocs).toBe(1)
  })

  it('refuses to create a page in another tenant', async () => {
    await expect(
      harness.payload.create({
        collection: 'pages',
        data: { slug: 'sneaky', tenant: harness.tenantB.id, title: 'Sneaky' } as never,
        user: harness.tenantAdminA,
      }),
    ).rejects.toThrow()
  })

  it('refuses to update another tenant’s page', async () => {
    const theirs = (await createPage({ slug: 'theirs', title: 'Theirs' }, 'b')) as { id: number }

    await expect(
      harness.payload.update({
        collection: 'pages',
        data: { title: 'Hijacked' },
        id: theirs.id,
        user: harness.tenantAdminA,
      }),
    ).rejects.toThrow()
  })

  it('denies anonymous reads and employer writes', async () => {
    const employer = (await harness.payload.create({
      collection: 'users',
      data: {
        email: `employer-${Date.now()}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants: [{ role: 'employer', tenant: harness.tenantA.id }],
      } as never,
      overrideAccess: true,
    })) as { id: number; collection: string }

    await expect(
      harness.payload.find({ collection: 'pages', overrideAccess: false }),
    ).rejects.toThrow(/not allowed/)

    await expect(
      harness.payload.create({
        collection: 'pages',
        data: { slug: 'by-employer', tenant: harness.tenantA.id, title: 'By employer' } as never,
        user: employer,
      }),
    ).rejects.toThrow()
  })

  it('lets a super-admin read every tenant', async () => {
    const all = await harness.payload.find({
      collection: 'pages',
      overrideAccess: false,
      user: harness.superAdmin,
    })

    expect(all.totalDocs).toBeGreaterThan(1)
    expect(new Set(all.docs.map((doc) => (doc as { tenant?: number }).tenant)).size).toBe(2)
  })
})

describe('pages on a single-tenant host', () => {
  let single: TestHarness

  beforeAll(async () => {
    single = await bootTestPayload({
      collections: [pagesCollection({ tenantScoped: false })],
      media: true,
      tenancy: 'single',
    })
  }, 120_000)

  afterAll(async () => {
    await single.destroy()
  })

  it('lets an ordinary signed-in user create, update and delete a page', async () => {
    const created = (await single.payload.create({
      collection: 'pages',
      data: { slug: 'about-us', title: 'About us' } as never,
      user: single.member,
    })) as { id: number }

    expect(created.id).toBeDefined()

    const updated = (await single.payload.update({
      collection: 'pages',
      data: { title: 'About us (updated)' },
      id: created.id,
      user: single.member,
    })) as { title?: string }

    expect(updated.title).toBe('About us (updated)')

    await expect(
      single.payload.delete({
        collection: 'pages',
        id: created.id,
        user: single.member,
      }),
    ).resolves.toBeDefined()
  })

  it('still denies anonymous reads and writes', async () => {
    await expect(
      single.payload.create({
        collection: 'pages',
        data: { slug: 'anonymous', title: 'Anonymous' } as never,
      }),
    ).rejects.toThrow()
  })
})
