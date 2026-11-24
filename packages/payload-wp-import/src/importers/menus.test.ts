import { describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { runImport } from '../run-import'
import { createFakePayload } from '../test-utils'
import { createFixtureConnection, pageTables } from '../test/fixtures'
import {
  LEGACY_MENUS,
  REMAPPED_LEGACY_MENU_ITEMS,
  mapLegacyMenu,
  menusImporter,
  readLegacyMenus,
} from './menus'
import { pagesImporter } from './pages'

const TENANT = 1

const readerFor = () =>
  new MysqlReader({ connect: async () => createFixtureConnection(pageTables), pageSize: 4 })

const menuNamed = async (name: string) => {
  const menus = await readLegacyMenus(readerFor())
  const found = menus.find((menu) => menu.name === name)
  if (!found) throw new Error(`no fixture menu ${name}`)
  return found
}

const seededPages = () =>
  createFakePayload({
    pages: [
      { id: 1, role: 'home', slug: null, tenant: TENANT, title: 'Home' },
      { id: 2, role: 'about', slug: 'about', tenant: TENANT, title: 'About us' },
      { id: 3, role: 'contact', slug: 'contact', tenant: TENANT, title: 'Contact' },
      { id: 4, role: 'organisations', slug: 'organisations', tenant: TENANT, title: 'Organisations' },
    ],
  })

const run = async (payload = seededPages(), dryRun = false) => {
  const summary = await runImport({
    dryRun,
    importers: [pagesImporter(), menusImporter()],
    payload: payload.payload,
    reader: readerFor(),
    tenant: TENANT,
  })
  return { ...payload, summary }
}

describe('legacy menu reading @S-262', () => {
  it('reads the three theme menus with their items in display order', async () => {
    const menus = await readLegacyMenus(readerFor())

    expect(menus.map((menu) => [menu.name, menu.location])).toEqual([
      ['Main menu', 'primary'],
      ['Top menu', 'top'],
      ['Bottom menu', 'footer'],
    ])
    expect(LEGACY_MENUS.map((menu) => menu.location)).toEqual(['primary', 'top', 'footer'])

    const main = menus[0]!
    expect(main.termId).toBe(71)
    expect(main.items.map((item) => item.order)).toEqual([1, 2, 3, 4, 5])
    expect(main.items[0]).toMatchObject({ type: 'custom', url: '/jobs' })
    expect(main.items[1]).toMatchObject({ objectPostName: 'volunteer-jobs', type: 'post_type' })
  })

  it('skips a menu the site does not have', async () => {
    const menus = await readLegacyMenus(readerFor(), [{ location: 'top', name: 'Missing menu' }])

    expect(menus).toEqual([])
  })
})

describe('menu item mapping @S-262', () => {
  it('links a page item to the imported page', async () => {
    const menu = await menuNamed('Main menu')
    const pages = new Map([
      [61, { id: 101, title: 'Volunteering' }],
      [38, { id: 102, title: 'For Employers' }],
      [23445, { id: 103, title: 'Organisations' }],
      [3983, { id: 104, title: 'About us' }],
    ])
    const mapped = mapLegacyMenu(menu, pages)

    expect(mapped.dropped).toEqual([])
    expect(mapped.items).toEqual([
      { label: 'Jobs', linkType: 'custom', url: '/jobs' },
      { label: 'Volunteering', linkType: 'page', page: 101 },
      { label: 'For Employers', linkType: 'page', page: 102 },
      { label: 'Organisations', linkType: 'page', page: 103 },
      { label: 'About us', linkType: 'page', page: 104 },
    ])
  })

  it('remaps a WordPress-only page to its new route', async () => {
    const menu = await menuNamed('Bottom menu')
    const mapped = mapLegacyMenu(menu, new Map())

    // Password Reset and Submit Job are pages the new site serves from /account.
    expect(mapped.items).toEqual([
      { label: 'Powered by Youth Challenge Vanuatu', linkType: 'custom', url: 'https://www.ycv.vu' },
      { label: 'Password Reset', linkType: 'custom', url: '/account/reset-password' },
      { label: 'Submit Job', linkType: 'custom', url: '/account/jobs/new' },
    ])
    expect(mapped.dropped).toEqual([])
  })

  it('drops an item whose page was not imported and has no route', async () => {
    const mapped = mapLegacyMenu(
      {
        items: [
          {
            itemId: 900,
            label: 'Resumes restricted',
            objectId: 791,
            objectPostName: 'no-resumes',
            order: 1,
            type: 'post_type',
          },
        ],
        location: 'top',
        name: 'Top menu',
        termId: 99,
      },
      new Map(),
    )

    expect(mapped.items).toEqual([])
    expect(mapped.dropped).toEqual([
      { label: 'Resumes restricted', reason: 'page "no-resumes" not imported' },
    ])
  })

  it('drops an unsafe or empty custom URL', () => {
    const mapped = mapLegacyMenu(
      {
        items: [
          { itemId: 1, label: 'Bad', order: 1, type: 'custom', url: 'javascript:alert(1)' },
          { itemId: 2, label: 'Empty', order: 2, type: 'custom', url: '  ' },
          { itemId: 3, label: 'Proto-relative', order: 3, type: 'custom', url: '//evil.test' },
          { itemId: 4, label: 'Mail', order: 4, type: 'custom', url: 'mailto:jobs@example.com' },
        ],
        location: 'footer',
        name: 'Bottom menu',
        termId: 98,
      },
      new Map(),
    )

    expect(mapped.items).toEqual([{ label: 'Mail', linkType: 'custom', url: 'mailto:jobs@example.com' }])
    expect(mapped.dropped.map((item) => item.reason)).toEqual([
      'unsupported URL scheme',
      'custom item with no URL',
      'unsupported URL scheme',
    ])
  })

  it('keeps a route table entry that has no equivalent as a drop', () => {
    expect(REMAPPED_LEGACY_MENU_ITEMS.get('purchase-resume-subscription')).toEqual({
      label: 'Resume subscriptions',
      url: null,
    })
  })
})

describe('menus import run @S-262', () => {
  it('creates the three menus, one per location, and links the imported pages', async () => {
    const { store, summary } = await run()

    expect(summary.importers.menus).toMatchObject({ created: 3, failed: 0 })
    expect(store.menus!.map((menu) => menu.location).toSorted()).toEqual(['footer', 'primary', 'top'])

    const main = store.menus!.find((menu) => menu.location === 'primary')!
    expect(main.legacyId).toBe(71)
    expect(main.name).toBe('Main menu')

    const volunteering = store.pages!.find((page) => page.legacyId === 61)!
    expect(main.items).toEqual([
      { label: 'Jobs', linkType: 'custom', url: '/jobs' },
      { label: 'Volunteering', linkType: 'page', page: volunteering.id },
      expect.objectContaining({ linkType: 'page' }),
      expect.objectContaining({ linkType: 'page' }),
      expect.objectContaining({ linkType: 'page' }),
    ])
  })

  it('creates nothing on a second run', async () => {
    const payload = seededPages()
    await run(payload)
    const creates = payload.writes.filter((write) => write.op === 'create' && write.collection === 'menus')
    const second = await run(payload)

    expect(second.summary.importers.menus).toMatchObject({ created: 0, updated: 3 })
    expect(
      payload.writes.filter((write) => write.op === 'create' && write.collection === 'menus'),
    ).toHaveLength(creates.length)
    expect(payload.store.menus!.filter((menu) => menu.legacyId === 71)).toHaveLength(1)
  })

  it('writes nothing in a dry run', async () => {
    const payload = seededPages()
    const { summary } = await run(payload, true)

    expect(summary.importers.menus!.created).toBe(3)
    expect(payload.writes.filter((write) => write.collection === 'menus')).toHaveLength(0)
  })

  it('reports the items it dropped and the pages it remapped', async () => {
    const { summary } = await run()
    const report = summary.importers.menus!.report ?? {}

    expect(report['legacy menus read']).toBe(3)
    // Nothing was dropped: the bottom menu's WP-only pages all have a new route.
    expect(report['menu item dropped: no equivalent on the new site']).toBeUndefined()
  })
})
