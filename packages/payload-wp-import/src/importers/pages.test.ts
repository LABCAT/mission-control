import { describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { runImport } from '../run-import'
import { createFakePayload } from '../test-utils'
import { createFixtureConnection, pageTables } from '../test/fixtures'
import {
  DROPPED_LEGACY_PAGES,
  IMPORTABLE_PAGES,
  JOB_SEARCH_BLOCK,
  LATEST_JOBS_BLOCK,
  LEGACY_HOME,
  homeLayout,
  mapLegacyPage,
  pagesImporter,
  pageLayout,
  readLegacyPages,
  stripLegacyForms,
} from './pages'

const TENANT = 1

const readerFor = () =>
  new MysqlReader({ connect: async () => createFixtureConnection(pageTables), pageSize: 4 })

const pages = async () => readLegacyPages(readerFor())

const pageBySlug = async (slug: string) => {
  const found = (await pages()).find((page) => page.postName === slug)
  if (!found) throw new Error(`no fixture page ${slug}`)
  return found
}

const run = async (
  payload = createFakePayload({
    // The tenant seed (PJ-103) created the four system pages already.
    pages: [
      { id: 1, role: 'home', slug: null, tenant: TENANT, title: 'Home' },
      { id: 2, role: 'about', slug: 'about', tenant: TENANT, title: 'About us' },
      { id: 3, role: 'contact', slug: 'contact', tenant: TENANT, title: 'Contact' },
      { id: 4, role: 'organisations', slug: 'organisations', tenant: TENANT, title: 'Organisations' },
    ],
  }),
  dryRun = false,
  blockSlugs: string[] = [],
) => {
  const summary = await runImport({
    dryRun,
    importers: [pagesImporter({ blockSlugs })],
    payload: payload.payload,
    reader: readerFor(),
    tenant: TENANT,
  })
  return { ...payload, summary }
}

describe('legacy page targets @S-260', () => {
  it('imports the pages the site published and drops the WordPress machinery', () => {
    expect(IMPORTABLE_PAGES.map((page) => page.slug)).toEqual([
      'home',
      'about-us',
      'contact-2',
      'organisations',
      'employers',
      'volunteer-jobs',
      'land-law-reforms',
      'organisation-competition',
      'terms-conditions',
    ])
    // The legacy "Contact us" page is superseded by the contact-2 system page.
    expect(DROPPED_LEGACY_PAGES).toContain('contact')
    expect(DROPPED_LEGACY_PAGES).toContain('submit')
    expect(DROPPED_LEGACY_PAGES).not.toContain('contact-2')
  })

  it('reads only the targeted pages, in ID order', async () => {
    const read = await pages()

    // Keyset order by ID, which is what makes a run repeatable.
    expect(read.map((page) => page.postName)).toEqual([
      'terms-conditions',
      'employers',
      'volunteer-jobs',
      'home',
      'about-us',
      'organisations',
      'organisation-competition',
      'contact-2',
      'land-law-reforms',
    ])
    expect(read.map((page) => page.id)).toEqual([10, 38, 61, 1366, 3983, 23445, 29143, 29301, 33579])
    expect(read.every((page) => page.postStatus === 'publish')).toBe(true)
  })
})

describe('page body mapping @S-260', () => {
  it('turns legacy HTML into one rich-text block', async () => {
    const mapped = mapLegacyPage(await pageBySlug('employers'))
    if (!('doc' in mapped)) throw new Error('expected a document')

    expect(mapped.doc.data.layout).toEqual([
      expect.objectContaining({ blockType: 'rich-text' }),
    ])
    expect(mapped.doc.legacyId).toBe(38)
    expect(mapped.doc.data.title).toBe('For Employers')
    expect(mapped.doc.data.slug).toBe('employers')
    expect(mapped.doc.data._status).toBe('published')
  })

  it('drops a contact form shortcode and reports it (PJ-102)', async () => {
    const page = await pageBySlug('contact-2')
    const mapped = mapLegacyPage(page)
    if (!('doc' in mapped)) throw new Error('expected a document')

    expect(mapped.forms).toEqual(['[contact-form]', '[/contact-form]'])
    expect(JSON.stringify(mapped.doc.data.layout)).not.toContain('contact-form')
    // The text around the form is kept.
    expect(JSON.stringify(mapped.doc.data.layout)).toContain('Get in touch.')
  })

  it('strips embedded <form> markup too', () => {
    const { forms, html } = stripLegacyForms('<p>Hi</p><form action="/x"><input name="a"></form><p>Bye</p>')

    expect(forms).toEqual(['form'])
    expect(html).toBe('<p>Hi</p><p>Bye</p>')
  })

  it('imports an empty page with no layout blocks', () => {
    expect(pageLayout('')).toEqual([])
    expect(pageLayout(null)).toEqual([])
  })

  it('keeps a draft a draft and decodes the title entities', async () => {
    const mapped = mapLegacyPage({
      ...(await pageBySlug('terms-conditions')),
      postStatus: 'draft',
    })
    if (!('doc' in mapped)) throw new Error('expected a document')

    expect(mapped.doc.data._status).toBe('draft')
    expect(mapped.doc.data.title).toBe('Terms & Conditions')
  })
})

describe('home page blocks @S-261', () => {
  it('reproduces the legacy home from blocks, not rich text', () => {
    const layout = homeLayout({ available: [JOB_SEARCH_BLOCK, LATEST_JOBS_BLOCK] })

    expect(layout.map((block) => block.blockType)).toEqual([
      'hero',
      'job-search',
      'feature-boxes',
      'latest-jobs',
    ])
    expect(layout[0]).toMatchObject({
      body: LEGACY_HOME.body,
      heading: 'FIND A JOB IN VANUATU',
      links: [{ href: '/jobs', label: 'Browse all jobs' }],
    })
    expect((layout[2]!.items as unknown[]).length).toBe(3)
  })

  it('leaves out the job blocks when the host has not registered them', () => {
    const layout = homeLayout({ available: [] })

    expect(layout.map((block) => block.blockType)).toEqual(['hero', 'feature-boxes'])
  })

  it('appends the legacy copy as a rich-text block after the blocks', () => {
    const layout = homeLayout({ available: [], html: '<p>Welcome to Vanuatu Wok.</p>' })

    expect(layout.at(-1)).toMatchObject({ blockType: 'rich-text' })
    expect(JSON.stringify(layout.at(-1))).toContain('Welcome to Vanuatu Wok.')
  })

  it('maps the legacy home page onto the seeded home page, not a second one', async () => {
    const page = await pageBySlug('home')
    const mapped = mapLegacyPage(page, { blockSlugs: [JOB_SEARCH_BLOCK, LATEST_JOBS_BLOCK] })
    if (!('doc' in mapped)) throw new Error('expected a document')

    expect(mapped.doc.data.role).toBe('home')
    // A system page keeps the address its role gives it.
    expect(mapped.doc.data.slug).toBeUndefined()
    expect((mapped.doc.data.layout as { blockType: string }[])[0]!.blockType).toBe('hero')
  })
})

describe('pages import run @S-260', () => {
  it('adopts the seeded system pages instead of creating duplicates', async () => {
    const { store, summary } = await run()

    expect(summary.importers.pages).toMatchObject({ created: 5, updated: 4, failed: 0 })
    expect(store.pages!.filter((page) => page.role === 'home')).toHaveLength(1)
    expect(store.pages!.filter((page) => page.role === 'about')).toHaveLength(1)
    expect(store.pages!.filter((page) => page.role === 'contact')).toHaveLength(1)
    expect(store.pages!.filter((page) => page.role === 'organisations')).toHaveLength(1)

    const home = store.pages!.find((page) => page.role === 'home')!
    expect(home.legacyId).toBe(1366)
    expect((home.layout as { blockType: string }[])[0]!.blockType).toBe('hero')
  })

  it('keeps the seeded slug of a system page rather than the legacy one', async () => {
    const { store } = await run()

    const about = store.pages!.find((page) => page.role === 'about')!
    expect(about.slug).toBe('about')
    expect(about.legacyId).toBe(3983)

    const contact = store.pages!.find((page) => page.role === 'contact')!
    expect(contact.slug).toBe('contact')
    expect(contact.legacyId).toBe(29301)
  })

  it('creates the normal pages with their legacy slug', async () => {
    const { store } = await run()

    for (const slug of ['employers', 'volunteer-jobs', 'land-law-reforms', 'organisation-competition', 'terms-conditions']) {
      const page = store.pages!.find((candidate) => candidate.slug === slug)
      expect(page, slug).toMatchObject({ tenant: TENANT, _status: 'published' })
      expect(page!.role).toBeUndefined()
    }
  })

  it('creates nothing on a second run', async () => {
    const payload = createFakePayload({
      pages: [{ id: 1, role: 'home', slug: null, tenant: TENANT, title: 'Home' }],
    })
    await run(payload)
    const afterFirst = payload.writes.filter((write) => write.op === 'create').length
    const second = await run(payload)

    expect(second.summary.importers.pages).toMatchObject({ created: 0, failed: 0 })
    expect(payload.writes.filter((write) => write.op === 'create')).toHaveLength(afterFirst)
    expect(payload.store.pages!.filter((page) => page.legacyId === 1366)).toHaveLength(1)
  })

  it('writes nothing in a dry run', async () => {
    const payload = createFakePayload({
      pages: [{ id: 1, role: 'home', slug: null, tenant: TENANT, title: 'Home' }],
    })
    const { summary } = await run(payload, true)

    expect(summary.importers.pages!.created).toBeGreaterThan(0)
    expect(payload.writes).toHaveLength(0)
  })

  it('reports the forms it could not import and the dropped pages', async () => {
    const { summary } = await run()
    const report = summary.importers.pages!.report ?? {}

    expect(report['form block not imported: [contact-form]']).toBe(1)
    expect(report['form block not imported: [/contact-form]']).toBe(1)
    expect(report['dropped legacy pages (routes, not content)']).toBe(DROPPED_LEGACY_PAGES.length)
    expect(report['legacy pages read']).toBe(9)
  })

  it('reports the job blocks it had to leave out of the home page', async () => {
    const { summary } = await run(undefined, false, [])

    expect(summary.importers.pages!.report).toMatchObject({
      'home page built from blocks': 1,
      'job-search block not registered: left out of the home page': 1,
      'latest-jobs block not registered: left out of the home page': 1,
    })
  })
})
