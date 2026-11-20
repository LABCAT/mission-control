import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootTestPayload, tenantIsolation, type TestHarness, type TestTenant } from '../test'
import {
  SYSTEM_PAGE_SEEDS,
  removeTenantPages,
  seedSystemPages,
  seedTenantSystemPages,
  type PageRole,
} from '../system-pages'
import { pagesCollection } from './pages'
import { menusCollection, removeTenantMenus } from './menus'

type StoredPage = {
  _status?: string
  id: number | string
  layout?: unknown[]
  parent?: null | number | string | { id: number | string }
  role?: null | PageRole
  slug?: null | string
  tenant: number | string
  title: string
}

// `sort` mutates and the repo's lib target has no `toSorted`.
const sortRoles = (roles: (null | PageRole | undefined)[]): string[] =>
  [...roles].map((role) => String(role)).sort()

const fieldMessages = (error: unknown): string =>
  ((error as { data?: { errors?: { message: string }[] } }).data?.errors ?? [])
    .map((fieldError) => fieldError.message)
    .join(' | ')

// The harness has no upload collection, so the SEO image field is left out.
const PEER_COLLECTIONS = [pagesCollection({ mediaSlug: null }), menusCollection()]

tenantIsolation({
  boot: {},
  collection: pagesCollection({ mediaSlug: null }),
  createData: (tenant: TestTenant) => ({
    _status: 'published',
    slug: `page-${tenant.id}`,
    title: `Page for ${tenant.name}`,
  }),
  extraCollections: [],
})

describe('system pages', () => {
  let harness: TestHarness

  const createPage = async (
    data: Record<string, unknown>,
    tenantID: number | string,
    user: unknown = harness.tenantAdminA,
  ): Promise<StoredPage> =>
    (await harness.payload.create({
      collection: 'pages',
      data: { tenant: tenantID, ...data } as never,
      user: user as never,
    })) as unknown as StoredPage

  const readPage = async (id: number | string): Promise<StoredPage> =>
    (await harness.payload.findByID({
      collection: 'pages',
      depth: 0,
      id,
      overrideAccess: true,
    })) as unknown as StoredPage

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

  beforeAll(async () => {
    harness = await bootTestPayload({ collections: PEER_COLLECTIONS })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  describe('seeding', () => {
    it('creates the four system pages, published, with an empty layout @S-144', async () => {
      await seedSystemPages(harness.payload, { tenantID: harness.tenantA.id })

      const pages = await pagesOf(harness.tenantA.id)
      const byRole = new Map(pages.map((page) => [page.role, page]))

      expect(sortRoles([...byRole.keys()])).toEqual(['about', 'contact', 'home', 'organisations'])
      for (const seed of SYSTEM_PAGE_SEEDS) {
        const page = byRole.get(seed.role)
        expect(page?._status).toBe('published')
        expect(page?.slug).toBe(seed.slug)
        expect(page?.title).toBe(seed.title)
        expect(page?.layout).toEqual([])
      }
    })

    it('is idempotent, so a re-run seed or import creates no duplicate @S-144', async () => {
      const before = await pagesOf(harness.tenantA.id)
      await seedSystemPages(harness.payload, { tenantID: harness.tenantA.id })
      await seedSystemPages(harness.payload, { tenantID: harness.tenantA.id })

      expect(await pagesOf(harness.tenantA.id)).toHaveLength(before.length)
    })

    it('keeps an existing page as it is instead of resetting its content', async () => {
      const home = (await pagesOf(harness.tenantA.id)).find((page) => page.role === 'home')!
      await harness.payload.update({
        collection: 'pages',
        data: { title: 'Vanuatu Wok' } as never,
        id: home.id,
        overrideAccess: true,
      })

      await seedSystemPages(harness.payload, { tenantID: harness.tenantA.id })

      expect((await readPage(home.id)).title).toBe('Vanuatu Wok')
    })

    it('gives each site its own pages, so a new tenant is seeded separately', async () => {
      await seedSystemPages(harness.payload, { tenantID: harness.tenantB.id })

      const tenantB = await pagesOf(harness.tenantB.id)
      expect(tenantB).toHaveLength(SYSTEM_PAGE_SEEDS.length)
      expect(new Set(tenantB.map((page) => page.tenant)).size).toBe(1)
    })
  })

  describe('role rules', () => {
    it('allows one page per role per site', async () => {
      const error = await createPage(
        { role: 'about', title: 'Second about' },
        harness.tenantA.id,
        harness.superAdmin,
      ).catch((caught: unknown) => caught)

      expect(fieldMessages(error)).toMatch(/already has a about page/)
    })

    it('gives the home page no slug, whatever was submitted', async () => {
      const page = await createPage(
        { role: 'home', slug: 'start', title: 'Start' },
        harness.tenantB.id,
        harness.superAdmin,
      ).catch((error: Error) => error)

      // Tenant B already has its seeded home page, so this is the role-uniqueness error.
      expect(page).toBeInstanceOf(Error)

      const tenantBHome = (await pagesOf(harness.tenantB.id)).find(
        (candidate) => candidate.role === 'home',
      )!
      expect(tenantBHome.slug).toBeNull()
    })

    it('derives a slug from the title when none is given', async () => {
      const page = await createPage({ title: 'For Employers' }, harness.tenantA.id)
      expect(page.slug).toBe('for-employers')
    })

    it('keeps the existing slug when an update leaves the field out @S-144', async () => {
      const page = await createPage({ slug: 'our-services', title: 'Our services' }, harness.tenantA.id)

      await harness.payload.update({
        collection: 'pages',
        data: { title: 'Our services and prices' } as never,
        id: page.id,
        user: harness.tenantAdminA as never,
      })

      expect((await readPage(page.id)).slug).toBe('our-services')
    })

    it('derives a slug from the title when an update clears it @S-144', async () => {
      const page = await createPage({ slug: 'old-address', title: 'Contact the team' }, harness.tenantA.id)

      await harness.payload.update({
        collection: 'pages',
        data: { slug: '' } as never,
        id: page.id,
        user: harness.tenantAdminA as never,
      })

      expect((await readPage(page.id)).slug).toBe('contact-the-team')
    })

    it('refuses a parent on the home page', async () => {
      const about = (await pagesOf(harness.tenantA.id)).find((page) => page.role === 'about')!
      const home = (await pagesOf(harness.tenantA.id)).find((page) => page.role === 'home')!

      const error = await harness.payload
        .update({
          collection: 'pages',
          data: { parent: about.id } as never,
          id: home.id,
          user: harness.tenantAdminA as never,
        })
        .catch((caught: unknown) => caught)

      expect(fieldMessages(error)).toMatch(/home page cannot have a parent/)
    })

    it('lets about and contact have children but not home or organisations', async () => {
      const about = (await pagesOf(harness.tenantA.id)).find((page) => page.role === 'about')!
      const organisations = (await pagesOf(harness.tenantA.id)).find(
        (page) => page.role === 'organisations',
      )!

      const child = await createPage(
        { parent: about.id, slug: 'our-team', title: 'Our team' },
        harness.tenantA.id,
      )
      expect(String((await readPage(child.id)).parent)).toBe(String(about.id))

      const error = await createPage(
        { parent: organisations.id, slug: 'members', title: 'Members' },
        harness.tenantA.id,
      ).catch((caught: unknown) => caught)

      // The parent picker offers only about, contact and normal pages; the hook holds the
      // rule for a write that bypasses the picker.
      expect(fieldMessages(error)).toMatch(/invalid selections|organisations page cannot have children/)
    })

    it('refuses a parent from another tenant', async () => {
      const otherSitePage = (await pagesOf(harness.tenantB.id)).find(
        (page) => page.role === 'contact',
      )!

      await expect(
        createPage(
          { parent: otherSitePage.id, slug: 'moved', title: 'Moved' },
          harness.tenantA.id,
        ),
      ).rejects.toThrow()
    })

    it('refuses a page as its own parent', async () => {
      const page = await createPage({ slug: 'self-parent', title: 'Self' }, harness.tenantA.id)

      const error = await harness.payload
        .update({
          collection: 'pages',
          data: { parent: page.id } as never,
          id: page.id,
          user: harness.tenantAdminA as never,
        })
        .catch((caught: unknown) => caught)

      expect(fieldMessages(error)).toMatch(/cannot be its own parent/)
    })

    it('refuses a two-page parent cycle', async () => {
      const first = await createPage({ slug: 'cycle-a', title: 'Cycle A' }, harness.tenantA.id)
      const second = await createPage(
        { parent: first.id, slug: 'cycle-b', title: 'Cycle B' },
        harness.tenantA.id,
      )

      // B already sits under A, so making A a child of B would close the loop.
      const error = await harness.payload
        .update({
          collection: 'pages',
          data: { parent: second.id } as never,
          id: first.id,
          user: harness.tenantAdminA as never,
        })
        .catch((caught: unknown) => caught)

      expect(fieldMessages(error)).toMatch(/cannot be its own ancestor/)
    })

    it('refuses a cycle through a longer chain of ancestors', async () => {
      const top = await createPage({ slug: 'chain-top', title: 'Chain top' }, harness.tenantA.id)
      const middle = await createPage(
        { parent: top.id, slug: 'chain-middle', title: 'Chain middle' },
        harness.tenantA.id,
      )
      const bottom = await createPage(
        { parent: middle.id, slug: 'chain-bottom', title: 'Chain bottom' },
        harness.tenantA.id,
      )

      const error = await harness.payload
        .update({
          collection: 'pages',
          data: { parent: bottom.id } as never,
          id: top.id,
          user: harness.tenantAdminA as never,
        })
        .catch((caught: unknown) => caught)

      expect(fieldMessages(error)).toMatch(/cannot be its own ancestor/)
    })

    it('blocks moving a page with children under organisations', async () => {
      const organisations = (await pagesOf(harness.tenantA.id)).find(
        (page) => page.role === 'organisations',
      )!
      const parent = await createPage({ slug: 'resources', title: 'Resources' }, harness.tenantA.id)
      await createPage(
        { parent: parent.id, slug: 'guides', title: 'Guides' },
        harness.tenantA.id,
      )

      // Simulate an import that gives a page with children the organisations role.
      const roleError = await harness.payload
        .update({
          collection: 'pages',
          data: { role: 'organisations' } as never,
          id: parent.id,
          user: harness.superAdmin as never,
        })
        .catch((caught: unknown) => caught)
      expect(fieldMessages(roleError)).toMatch(/cannot have children|already has a organisations/)

      await expect(
        harness.payload.update({
          collection: 'pages',
          data: { parent: organisations.id } as never,
          id: parent.id,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toThrow()
    })
  })

  describe('role is immutable for site managers', () => {
    it('refuses a role change from a site manager, and the page keeps its role', async () => {
      const about = (await pagesOf(harness.tenantA.id)).find((page) => page.role === 'about')!

      const error = await harness.payload
        .update({
          collection: 'pages',
          data: { role: null, title: 'About' } as never,
          id: about.id,
          overrideAccess: false,
          user: harness.tenantAdminA as never,
        })
        .catch((caught: unknown) => caught)

      expect((error as Error).message).toMatch(/Only a super admin can change a page’s role/)
      expect((await readPage(about.id)).role).toBe('about')
    })

    it('refuses to create a page with a role as a site manager, and allows it as a super admin', async () => {
      const refused = await createPage(
        { role: 'about', title: 'Sneaky about' },
        harness.tenantB.id,
      ).catch((caught: unknown) => caught)
      expect((refused as Error).message).toMatch(/Only a super admin can create a page with a role/)

      const allowed = await createPage(
        { role: 'about', title: 'Import about' },
        harness.tenantB.id,
        harness.superAdmin,
      ).catch((caught: unknown) => caught)
      // Tenant B already has a seeded about page, so the role clash is what stops this one.
      expect(fieldMessages(allowed)).toMatch(/already has a about page/)
    })

    it('refuses to give a normal page a role through a local write by a site manager', async () => {
      const page = await createPage({ slug: 'promo', title: 'Promo' }, harness.tenantA.id)

      const error = await harness.payload
        .update({
          collection: 'pages',
          data: { role: 'contact' } as never,
          id: page.id,
          overrideAccess: false,
          user: harness.tenantAdminA as never,
        })
        .catch((caught: unknown) => caught)

      // No update means no role change, whichever layer refuses it.
      expect(error).toBeInstanceOf(Error)
      expect(
        ((await readPage(page.id)).role ?? null),
      ).toBeNull()
    })

    it('lets a super admin move a role when repairing an import, but only onto a free role', async () => {
      const page = await createPage({ slug: 'contact-old', title: 'Contact old' }, harness.tenantA.id)

      // Tenant A already has a contact page: one page per role per site.
      const taken = await harness.payload
        .update({
          collection: 'pages',
          data: { role: 'contact' } as never,
          id: page.id,
          user: harness.superAdmin as never,
        })
        .catch((caught: unknown) => caught)
      expect(fieldMessages(taken)).toMatch(/already has a contact page/)

      // Tenant C has no pages yet, so the role is free there.
      const tenantC = await harness.payload.create({
        collection: 'tenants',
        data: { name: 'Tenant C', slug: `tenant-c-${Date.now().toString(36)}` } as never,
        overrideAccess: true,
      })
      const otherSite = await createPage(
        { slug: 'about-old', title: 'About old' },
        tenantC.id as number,
        harness.superAdmin,
      )

      const updated = (await harness.payload.update({
        collection: 'pages',
        data: { role: 'about' } as never,
        id: otherSite.id,
        user: harness.superAdmin as never,
      })) as unknown as StoredPage

      expect(updated.role).toBe('about')
    })
  })

  describe('deletion', () => {
    it('refuses to delete a system page and says to unpublish instead @S-144', async () => {
      const contact = (await pagesOf(harness.tenantA.id)).find((page) => page.role === 'contact')!

      await expect(
        harness.payload.delete({
          collection: 'pages',
          id: contact.id,
          user: harness.superAdmin as never,
        }),
      ).rejects.toThrow(/unpublish it instead of deleting it/)

      expect((await readPage(contact.id)).id).toEqual(contact.id)
    })

    it('refuses the delete for a site manager too', async () => {
      const about = (await pagesOf(harness.tenantA.id)).find((page) => page.role === 'about')!

      await expect(
        harness.payload.delete({
          collection: 'pages',
          id: about.id,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toThrow()
    })

    it('refuses to detach a system page from its site', async () => {
      const contact = (await pagesOf(harness.tenantA.id)).find((page) => page.role === 'contact')!

      // Tenant is required, so a page cannot be orphaned and then deleted as "not a live
      // system page". Clearing it is refused before the delete guard is even reached.
      await expect(
        harness.payload.update({
          collection: 'pages',
          data: { tenant: null } as never,
          id: contact.id,
          user: harness.superAdmin as never,
        }),
      ).rejects.toThrow(/Assigned Tenant|required/)
    })

    it('allows deleting a normal page', async () => {
      const page = await createPage({ slug: 'temporary', title: 'Temporary' }, harness.tenantA.id)

      await harness.payload.delete({
        collection: 'pages',
        id: page.id,
        user: harness.tenantAdminA as never,
      })

      await expect(readPage(page.id)).rejects.toThrow()
    })

    it('lets an editor unpublish a system page instead of removing it', async () => {
      const organisations = (await pagesOf(harness.tenantA.id)).find(
        (page) => page.role === 'organisations',
      )!

      await harness.payload.update({
        collection: 'pages',
        data: { _status: 'draft' } as never,
        id: organisations.id,
        user: harness.tenantAdminA as never,
      })

      expect((await readPage(organisations.id))._status).toBe('draft')
    })
  })

  describe('public reads', () => {
    it('shows a site the only published pages of its own tenant', async () => {
      const { docs } = await harness.payload.find({
        collection: 'pages',
        overrideAccess: true,
        pagination: false,
        where: {
          and: [{ tenant: { equals: harness.tenantA.id } }, { _status: { equals: 'published' } }],
        },
        depth: 0,
      })

      const roles = (docs as unknown as StoredPage[]).map((page) => page.role).filter(Boolean)
      expect(roles).toContain('home')
      // Organisations was unpublished by the previous test.
      expect(roles).not.toContain('organisations')
      expect(docs.every((doc) => String((doc as StoredPage).tenant) === String(harness.tenantA.id))).toBe(
        true,
      )
    })
  })
})

describe('tenant lifecycle', () => {
  let harness: TestHarness
  const extraTenantIds: (number | string)[] = []

  const createTenant = async (data: Record<string, unknown> = {}) => {
    const tenant = (await harness.payload.create({
      collection: 'tenants',
      data: { name: 'Tenant C', slug: `tenant-c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...data } as never,
      overrideAccess: true,
    })) as TestTenant
    extraTenantIds.push(tenant.id)

    return tenant
  }

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

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: PEER_COLLECTIONS,
      tenantFields: [{ name: 'isAggregate', type: 'checkbox', defaultValue: false }],
      tenantHooks: {
        afterChange: [seedTenantSystemPages()],
        beforeDelete: [removeTenantPages(), removeTenantMenus()],
      },
    })
  })

  afterAll(async () => {
    for (const id of extraTenantIds) {
      await harness.payload.delete({ collection: 'tenants', id, overrideAccess: true }).catch(() => undefined)
    }
    if (harness) await harness.destroy()
  })

  it('seeds the four system pages when a site is created @S-144', async () => {
    const tenant = await createTenant()
    const pages = await pagesOf(tenant.id)

    expect(sortRoles(pages.map((page) => page.role))).toEqual([
      'about',
      'contact',
      'home',
      'organisations',
    ])
    expect(pages.every((page) => page._status === 'published')).toBe(true)
  })

  it('does not seed the aggregate tenant, which has no site', async () => {
    const tenant = await createTenant({ isAggregate: true, name: 'Directory' } as never)

    expect(await pagesOf(tenant.id)).toHaveLength(0)
  })

  it('removes a deleted site’s pages, system pages included', async () => {
    const tenant = await createTenant()
    expect(await pagesOf(tenant.id)).toHaveLength(SYSTEM_PAGE_SEEDS.length)

    await harness.payload.delete({ collection: 'tenants', id: tenant.id, overrideAccess: true })

    expect(await pagesOf(tenant.id)).toHaveLength(0)
    extraTenantIds.splice(extraTenantIds.indexOf(tenant.id), 1)
  })

  it('removes a deleted site’s menus too, leaving no orphans behind', async () => {
    const tenant = await createTenant()
    await harness.payload.create({
      collection: 'menus',
      data: { location: 'primary', name: 'Primary', tenant: tenant.id } as never,
      overrideAccess: true,
    })

    await harness.payload.delete({ collection: 'tenants', id: tenant.id, overrideAccess: true })
    extraTenantIds.splice(extraTenantIds.indexOf(tenant.id), 1)

    const { totalDocs } = await harness.payload.count({
      collection: 'menus',
      overrideAccess: true,
      where: { tenant: { equals: tenant.id } },
    })
    expect(totalDocs).toBe(0)
  })

  it('does not seed when the plugin runs single-tenant', async () => {
    const tenant = await createTenant()
    await removeTenantPages()({
      id: tenant.id,
      req: { payload: harness.payload } as never,
    })

    const hook = seedTenantSystemPages({ tenantScoped: false })
    await hook({
      doc: tenant as unknown as Record<string, unknown>,
      operation: 'create',
      req: { payload: harness.payload } as never,
    })

    expect(await pagesOf(tenant.id)).toHaveLength(0)
  })
})

type StoredMenu = {
  id: number | string
  items?: { id?: string; label: string; linkType?: string; newTab?: boolean; page?: unknown; url?: string }[]
  location: string
  name: string
  tenant: number | string
}

describe('menus', () => {
  let harness: TestHarness

  const createMenu = async (
    data: Record<string, unknown>,
    tenantID: number | string,
    user: unknown = harness.tenantAdminA,
  ): Promise<StoredMenu> =>
    (await harness.payload.create({
      collection: 'menus',
      data: { tenant: tenantID, ...data } as never,
      user: user as never,
    })) as unknown as StoredMenu

  const readMenu = async (id: number | string): Promise<StoredMenu> =>
    (await harness.payload.findByID({
      collection: 'menus',
      depth: 0,
      id,
      overrideAccess: true,
    })) as unknown as StoredMenu

  beforeAll(async () => {
    harness = await bootTestPayload({ collections: PEER_COLLECTIONS })
    await seedSystemPages(harness.payload, { tenantID: harness.tenantA.id })
    await seedSystemPages(harness.payload, { tenantID: harness.tenantB.id })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('keeps the items in the submitted order and returns them that way @S-145', async () => {
    const menu = await createMenu(
      {
        items: [
          { label: 'Jobs', linkType: 'custom', url: '/jobs' },
          { label: 'About', linkType: 'custom', url: '/about' },
          { label: 'Contact', linkType: 'custom', url: '/contact' },
        ],
        location: 'primary',
        name: 'Primary',
      },
      harness.tenantA.id,
    )

    const stored = await readMenu(menu.id)
    expect(stored.items?.map((item) => item.label)).toEqual(['Jobs', 'About', 'Contact'])

    const reordered = await harness.payload.update({
      collection: 'menus',
      data: {
        items: [
          { label: 'About', linkType: 'custom', url: '/about' },
          { label: 'Jobs', linkType: 'custom', url: '/jobs' },
          { label: 'Contact', linkType: 'custom', url: '/contact' },
        ],
      } as never,
      id: menu.id,
      user: harness.tenantAdminA as never,
    })

    expect(
      (reordered as unknown as StoredMenu).items?.map((item) => item.label),
    ).toEqual(['About', 'Jobs', 'Contact'])
  })

  it('allows one menu per location per site', async () => {
    await expect(
      createMenu({ location: 'primary', name: 'Another primary' }, harness.tenantA.id),
    ).rejects.toThrow()
  })

  it('allows the same location on another site', async () => {
    const menu = await createMenu(
      { location: 'primary', name: 'Primary' },
      harness.tenantB.id,
      harness.superAdmin,
    )
    expect(menu.location).toBe('primary')
  })

  it('refuses a page item that points at another site’s page', async () => {
    const otherPages = (
      await harness.payload.find({
        collection: 'pages',
        depth: 0,
        overrideAccess: true,
        pagination: false,
        where: { tenant: { equals: harness.tenantB.id } },
      })
    ).docs as unknown as StoredPage[]

    const error = await createMenu(
      {
        items: [{ label: 'Their about', linkType: 'page', page: otherPages[0]!.id }],
        location: 'footer',
        name: 'Footer',
      },
      harness.tenantA.id,
    ).catch((caught: unknown) => caught)

    expect(fieldMessages(error)).toMatch(/belongs to another site/)
  })

  it('accepts a page item that points at its own site’s page', async () => {
    const ownPages = (
      await harness.payload.find({
        collection: 'pages',
        depth: 0,
        overrideAccess: true,
        pagination: false,
        where: { tenant: { equals: harness.tenantA.id } },
      })
    ).docs as unknown as StoredPage[]

    const menu = await createMenu(
      {
        items: [{ label: 'About', linkType: 'page', page: ownPages[0]!.id }],
        location: 'top',
        name: 'Top',
      },
      harness.tenantA.id,
    )

    expect(menu.items).toHaveLength(1)
  })

  it('rejects a custom item with no URL, and a link that is not a safe href', async () => {
    const missingUrl = await createMenu(
      { items: [{ label: 'Nowhere', linkType: 'custom' }], location: 'footer', name: 'Footer' },
      harness.tenantA.id,
    ).catch((caught: unknown) => caught)
    expect(fieldMessages(missingUrl)).toMatch(/A custom item needs a URL/)

    const unsafe = await createMenu(
      {
        items: [{ label: 'Bad', linkType: 'custom', url: 'javascript:alert(1)' }],
        location: 'footer',
        name: 'Footer',
      },
      harness.tenantA.id,
    ).catch((caught: unknown) => caught)
    expect(fieldMessages(unsafe)).toMatch(/http, https, mailto or tel/)
  })

  it('does not let an employer or seeker write menus', async () => {
    const employer = await harness.payload.create({
      collection: 'users',
      data: {
        email: `menu-employer-${Date.now()}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants: [{ role: 'employer', tenant: harness.tenantA.id }],
      } as never,
      overrideAccess: true,
    })

    await expect(
      createMenu({ location: 'footer', name: 'Footer' }, harness.tenantA.id, employer),
    ).rejects.toThrow()
  })

  it('allows a move to another site when its items point at that site’s pages', async () => {
    const theirPages = (
      await harness.payload.find({
        collection: 'pages',
        depth: 0,
        overrideAccess: true,
        pagination: false,
        where: { tenant: { equals: harness.tenantB.id } },
      })
    ).docs as unknown as StoredPage[]

    const menu = await createMenu(
      {
        items: [{ label: 'Jobs', linkType: 'custom', url: '/jobs' }],
        location: 'footer',
        name: 'Footer',
      },
      harness.tenantA.id,
    )

    const moved = await harness.payload.update({
      collection: 'menus',
      data: {
        items: [{ label: 'Their about', linkType: 'page', page: theirPages[0]!.id }],
        tenant: harness.tenantB.id,
      } as never,
      id: menu.id,
      user: harness.superAdmin as never,
    })

    expect(String((await readMenu(moved.id)).tenant)).toBe(String(harness.tenantB.id))
  })

  it('keeps menus inside their own site', async () => {
    const { docs } = await harness.payload.find({
      collection: 'menus',
      depth: 0,
      limit: 100,
      user: harness.tenantAdminB as never,
    })

    expect(docs.length).toBeGreaterThan(0)
    expect(
      docs.every((doc) => String((doc as StoredMenu).tenant) === String(harness.tenantB.id)),
    ).toBe(true)
  })
})
