import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { createFakePayload } from '../test-utils'
import { createFixtureConnection } from '../test/fixtures'
import { parseMediaArgs } from './cli'
import { copyFile } from './copy'
import { buildMediaPlan, isExcluded, originalOfThumbnail, uploadsPathOf } from './plan'
import { objectName, pathLegacyId, runMediaImport, stableFilename } from './run'
import { directorySource, directoryTarget, r2Target } from './stores'
import { fakeBucket, fakeSource, mediaFiles, mediaTables } from './test-support'

const readerFor = () => new MysqlReader({ connect: async () => createFixtureConnection(mediaTables), pageSize: 3 })
const TENANT = 1

const seed = () =>
  createFakePayload({
    jobs: [101, 102, 103].map((legacyId, i) => ({ id: 10 + i, legacyId, tenant: TENANT })),
    organisations: [2, 6, 8, 9].map((legacyId, i) => ({ id: 20 + i, legacyId, tenant: TENANT })),
    pages: [201, 202, 203].map((legacyId, i) => ({
      id: 30 + i,
      legacyId,
      seo: { noIndex: true, title: 'Kept' },
      tenant: TENANT,
    })),
  })

const run = (overrides: Record<string, unknown> = {}) => {
  const payload = seed()
  const source = fakeSource(mediaFiles)
  const bucket = fakeBucket()
  const go = (extra: Record<string, unknown> = {}) =>
    runMediaImport({
      maxDocumentBytes: 15,
      payload: payload.payload,
      reader: readerFor(),
      source: source.source,
      target: bucket.target,
      tenant: TENANT,
      ...overrides,
      ...extra,
    })
  return { bucket, go, payload, source }
}

describe('paths @S-148', () => {
  it('reads uploads paths from URLs and maps a generated thumbnail to its original', () => {
    expect(uploadsPathOf('https://vanuatuwok.vu/app/uploads/2020/05/a%20b.png?x=1')).toBe('2020/05/a b.png')
    expect(uploadsPathOf('2020/05/a.png')).toBe('2020/05/a.png')
    expect(uploadsPathOf('https://elsewhere.example/logo.png')).toBeNull()
    expect(uploadsPathOf('../../etc/passwd')).toBeNull()
    expect(originalOfThumbnail('company_logos/x-150x150.jpg')).toBe('company_logos/x.jpg')
    expect(originalOfThumbnail('2020/05/photo-final.jpg')).toBe('2020/05/photo-final.jpg')
  })

  it('names bucket objects from the legacy path alone, and never repeats a legacy id for two paths', () => {
    expect(stableFilename('company_logos/12/My logo.png')).toBe('company_logos-12-My_logo.png')
    expect(objectName(1, '2022/03/a.pdf')).toBe(objectName(1, '2022/03/a.pdf'))
    expect(objectName(1, '2022/03/a.pdf')).toMatch(/^t1-[0-9a-f]{12}-2022-03-a\.pdf$/)
    // Paths that flatten alike still get different names, and so do the same paths of two tenants.
    expect(objectName(1, 'a/my logo.png')).not.toBe(objectName(1, 'a/my_logo.png'))
    expect(objectName(1, 'a/b-c.png')).not.toBe(objectName(1, 'a-b/c.png'))
    expect(objectName(1, 'a/b.png')).not.toBe(objectName(2, 'a/b.png'))
    expect(objectName(1, `${'deep/'.repeat(80)}x.png`).length).toBeLessThan(160)
    expect(pathLegacyId('a/b.png')).toBeLessThan(0)
    expect(pathLegacyId('a/b.png')).not.toBe(pathLegacyId('a/c.png'))
  })

  it('excludes whole folders only', () => {
    expect(isExcluded('uploaded_cvs/a.pdf', ['uploaded_cvs'])).toBe(true)
    expect(isExcluded('uploaded_cvs_old/a.pdf', ['uploaded_cvs'])).toBe(false)
  })
})

describe('plan @S-148', () => {
  it('finds only what imported records use, never CVs, extra documents or thumbnails', async () => {
    const plan = await buildMediaPlan(readerFor())
    const summary = plan.refs.map((r) => `${r.owner.collection}#${r.owner.legacyId} ${r.kind} ${r.path}`).sort()
    expect(summary).toEqual([
      'jobs#101 job-pdf 2022/03/front-desk.pdf',
      'jobs#102 job-pdf 2023/01/skipper.pdf',
      'jobs#103 job-pdf 2025/06/huge.pdf',
      'organisations#2 logo 2020/05/logo-resort.png',
      'organisations#6 logo company_logos/charters.jpg',
      'pages#201 page-image 2024/02/about-hero.jpg',
      'pages#202 page-image 2021/01/share.png',
    ])
    // The CV logo, the CV-folder PDF (newer than the real one), the older job PDF, the dead page image.
    expect(plan.skipped).toEqual({
      'extra-document': 1,
      'excluded-path': 2,
      'page-image-unresolved': 1,
    })
  })

  it('has no cover unless the legacy meta key is configured', async () => {
    const plan = await buildMediaPlan(readerFor(), { coverMetaKey: 'delete-logo' })
    expect(plan.refs.filter((r) => r.kind === 'cover')).toEqual([]) // the value `1` is no file
    expect(plan.skipped['cover-unresolved']).toBe(1)
  })
})

describe('copyFile @S-148', () => {
  const setup = () => ({ bucket: fakeBucket(), src: fakeSource({ 'a/x.png': 'hello world' }) })
  const options = (s: ReturnType<typeof setup>, extra = {}) => ({
    contentType: 'image/png',
    key: 'a-x.png',
    path: 'a/x.png',
    source: s.src.source,
    target: s.bucket.target,
    ...extra,
  })

  it('copies once, then recognises the object as already in place', async () => {
    const s = setup()
    expect((await copyFile(options(s))).outcome).toBe('copied')
    expect(s.bucket.objects.get('a-x.png')?.contentType).toBe('image/png')
    const again = await copyFile(options(s))
    expect(again.outcome).toBe('already-copied')
    expect(s.bucket.state.puts).toEqual(['a-x.png'])
  })

  it('writes nothing in a dry run, and leaves no object behind a failed write', async () => {
    const s = setup()
    expect((await copyFile(options(s, { dryRun: true }))).outcome).toBe('would-copy')
    expect(s.bucket.objects.size).toBe(0)

    s.bucket.state.failNext = true
    await expect(copyFile(options(s))).rejects.toThrow('connection reset')
    expect(s.bucket.objects.size).toBe(0)
    // The resumed run completes it.
    expect((await copyFile(options(s))).outcome).toBe('copied')
  })

  it('replaces an object of the wrong size and, with verify, one with the wrong checksum', async () => {
    const s = setup()
    await s.bucket.target.put('a-x.png', (async function* () { yield new TextEncoder().encode('short') })(), {
      contentType: 'image/png',
      sha256: (await import('node:crypto')).createHash('sha256').update('short').digest('hex'),
      size: 5,
    })
    expect((await copyFile(options(s))).outcome).toBe('copied') // 5 bytes ≠ 11

    // Same size, different content: only --verify can tell.
    s.src.files['a/x.png'] = 'HELLO WORLD'
    expect((await copyFile(options(s))).outcome).toBe('already-copied')
    expect((await copyFile(options(s, { verify: true }))).outcome).toBe('copied')
    expect(new TextDecoder().decode(s.bucket.objects.get('a-x.png')!.data)).toBe('HELLO WORLD')
  })

  it('reports a missing source file', async () => {
    const s = setup()
    await expect(copyFile(options(s, { path: 'nope.png' }))).rejects.toThrow('Source file not found')
  })
})

describe('runMediaImport @S-148', () => {
  it('copies referenced files into the bucket under stable names and links every relation', async () => {
    const t = run()
    const report = await t.go()

    const name = (path: string) => objectName(TENANT, path)
    expect([...t.bucket.objects.keys()].sort()).toEqual(
      [
        '2020/05/logo-resort.png',
        '2021/01/share.png',
        '2022/03/front-desk.pdf',
        '2023/01/skipper.pdf',
        '2024/02/about-hero.jpg',
        'company_logos/charters.jpg',
      ]
        .map(name)
        .sort(),
    )
    // Never the CV, the thumbnail, the old PDF or the job's own logo.
    expect([...t.bucket.objects.keys()].join()).not.toMatch(/uploaded_cvs|150x150|skipper-old|job-logo/i)
    expect(Object.keys(t.source.reads)).not.toContain('uploaded_cvs/me.png')

    const orgs = t.payload.store.organisations!
    const mediaDoc = (id: unknown) => t.payload.store.media!.find((d) => d.id === id)!
    expect(mediaDoc(orgs.find((o) => o.legacyId === 2)!.logo)).toMatchObject({
      alt: 'Resort logo',
      filename: objectName(TENANT, '2020/05/logo-resort.png'),
      filesize: 10,
      legacyId: 501,
      mimeType: 'image/png',
      tenant: TENANT,
    })
    expect(mediaDoc(orgs.find((o) => o.legacyId === 6)!.logo).filename).toBe(name('company_logos/charters.jpg'))
    expect(orgs.find((o) => o.legacyId === 8)!.logo).toBeUndefined()

    const jobs = t.payload.store.jobs!
    const pdf = t.payload.store.documents!.find((d) => d.id === jobs.find((j) => j.legacyId === 101)!.jobDescriptionPdf)!
    expect(pdf).toMatchObject({ mimeType: 'application/pdf', title: 'Front desk description' })
    expect(jobs.find((j) => j.legacyId === 103)!.jobDescriptionPdf).toBeUndefined()

    const pages = t.payload.store.pages!
    expect(pages.find((p) => p.legacyId === 201)!.seo).toMatchObject({ noIndex: true, title: 'Kept' }) // group kept whole
    expect(mediaDoc(pages.find((p) => p.legacyId === 201)!.seo.image).filename).toBe(name('2024/02/about-hero.jpg'))

    expect(report).toMatchObject({
      bytesCopied: 10 + 12 + 14 + 11 + 8 + 9,
      documents: { created: 6, existing: 0 },
      failures: [],
      files: { alreadyCopied: 0, copied: 6 },
      relations: { kept: 0, set: 6 },
      skipped: { 'excluded-path': 2, 'extra-document': 1, 'over-size-limit': 1, 'page-image-unresolved': 1 },
    })
  })

  it('does a dry run that reports the same counts and writes nothing', async () => {
    const t = run()
    const dry = await t.go({ dryRun: true })
    expect(t.bucket.objects.size).toBe(0)
    expect(t.payload.writes).toEqual([])
    expect(dry.files.copied).toBe(6)
    expect(dry.relations.set).toBe(6)

    const real = await t.go()
    expect({ ...real, dryRun: true }).toEqual(dry)
  })

  it('is idempotent: a second run copies and creates nothing', async () => {
    const t = run()
    await t.go()
    const writes = t.payload.writes.length
    const second = await t.go()
    expect(t.payload.writes.length).toBe(writes)
    expect(second).toMatchObject({
      bytesCopied: 0,
      documents: { created: 0, existing: 6 },
      files: { alreadyCopied: 6, copied: 0 },
      relations: { kept: 0, set: 0 },
    })
    expect(t.bucket.state.puts).toHaveLength(6)
  })

  it('resumes after a crash: files already copied are skipped and the rest are written', async () => {
    const t = run()
    // The fourth write dies: three files are in the bucket and linked, the rest are not.
    let puts = 0
    const flaky = {
      ...t.bucket.target,
      put: async (...args: Parameters<typeof t.bucket.target.put>) => {
        if (++puts === 4) throw new Error('worker restarted')
        return t.bucket.target.put(...args)
      },
    }
    const first = await t.go({ target: flaky })
    expect(first.failures).toHaveLength(1)
    expect(first.failures[0]!.message).toBe('worker restarted')
    expect(t.bucket.objects.size).toBe(5)

    const second = await t.go()
    expect(second.failures).toEqual([])
    expect(second.files).toEqual({ alreadyCopied: 5, copied: 1 })
    expect(second.documents.created).toBe(1)
    expect(t.bucket.objects.size).toBe(6)
    expect(t.payload.store.media!.length + t.payload.store.documents!.length).toBe(6)
  })

  it('copies only for imported owners and picks up the rest on a later run', async () => {
    const t = run()
    t.payload.store.jobs!.splice(0, 3) // the job importer (PJ-64) has not run yet
    const first = await t.go()
    expect(first.skipped['owner-not-imported']).toBe(3)
    expect([...t.bucket.objects.keys()].some((k) => k.endsWith('.pdf'))).toBe(false)

    t.payload.store.jobs!.push({ id: 90, legacyId: 101, tenant: TENANT })
    const later = await t.go()
    expect(later.files.copied).toBe(1)
    expect(t.payload.store.jobs![0]!.jobDescriptionPdf).toBeDefined()
  })

  it('does not touch another tenant\'s records or a relation a person has already set', async () => {
    const t = run()
    t.payload.store.organisations![0]!.logo = 777 // chosen by a site manager
    t.payload.store.organisations![1]!.tenant = 2 // another tenant's organisation
    const report = await t.go()
    expect(t.payload.store.organisations![0]!.logo).toBe(777)
    expect(t.payload.store.organisations![1]!.logo).toBeUndefined()
    expect(report.relations.kept).toBe(1)
    expect(report.skipped['relation-already-set']).toBe(1)
    expect(report.skipped['owner-not-imported']).toBe(1)
  })

  it('reports a missing source file and a failed checksum as failures without stopping', async () => {
    const t = run()
    delete (mediaFiles as Record<string, string>)['2020/05/logo-resort.png']
    try {
      const report = await t.go()
      expect(report.failures).toEqual([
        { message: 'source file not found', owner: 'organisations #2', path: '2020/05/logo-resort.png' },
      ])
      expect(report.files.copied).toBe(5)
    } finally {
      mediaFiles['2020/05/logo-resort.png'] = 'PNG-resort'
    }
  })

  // Page 201 `2024/02/about-hero.jpg` and page 202 `2024/02-about/hero.jpg` flatten alike.
  const clashTables = () => {
    const tables = structuredClone(mediaTables)
    tables.wp_postmeta!.find((r) => r.post_id === 509 && r.meta_key === '_wp_attached_file')!.meta_value = '2024/02-about/hero.jpg'
    return tables
  }

  it('keeps two files that flatten alike apart, even when their owners are imported on different runs', async () => {
    const t = run()
    const reader = () => new MysqlReader({ connect: async () => createFixtureConnection(clashTables()) })
    const page201 = t.payload.store.pages!.splice(0, 1)[0]! // not imported yet on the first run
    const first = await t.go({ reader: reader() })
    expect(first.failures).toEqual([])

    t.payload.store.pages!.unshift(page201)
    const second = await t.go({ reader: reader() })
    expect(second.failures).toEqual([])

    const bytes = (path: string) => new TextDecoder().decode(t.bucket.objects.get(objectName(TENANT, path))!.data)
    expect(bytes('2024/02/about-hero.jpg')).toBe('JPG-hero')
    expect(bytes('2024/02-about/hero.jpg')).toBe('JPG-other')
    const imageOf = (legacyId: number) =>
      t.payload.store.media!.find((d) => d.id === t.payload.store.pages!.find((p) => p.legacyId === legacyId)!.seo.image)!
    expect(imageOf(201).filename).toBe(objectName(TENANT, '2024/02/about-hero.jpg'))
    expect(imageOf(202).filename).toBe(objectName(TENANT, '2024/02-about/hero.jpg'))
    expect(imageOf(201).id).not.toBe(imageOf(202).id)
  })

  it('never writes one tenant\'s file over another\'s in the shared bucket', async () => {
    const bucket = fakeBucket()
    const importFor = async (tenant: number, files: Record<string, string>) => {
      const payload = createFakePayload({
        pages: [{ id: 1, legacyId: 201, seo: {}, tenant }],
      })
      const report = await runMediaImport({
        payload: payload.payload,
        reader: readerFor(),
        source: fakeSource({ ...mediaFiles, ...files }).source,
        target: bucket.target,
        tenant,
      })
      return { payload, report }
    }
    // Same legacy path, different bytes (and the same size, which a shared key would call "already copied").
    const one = await importFor(1, { '2024/02/about-hero.jpg': 'TENANT-ONE-IMG' })
    const two = await importFor(2, { '2024/02/about-hero.jpg': 'TENANT-TWO-IMG' })
    expect(one.report.failures).toEqual([])
    expect(two.report.failures).toEqual([])

    const bytes = (tenant: number) => new TextDecoder().decode(bucket.objects.get(objectName(tenant, '2024/02/about-hero.jpg'))!.data)
    expect(bytes(1)).toBe('TENANT-ONE-IMG')
    expect(bytes(2)).toBe('TENANT-TWO-IMG')
    expect(one.payload.store.media![0]!.filename).toMatch(/^t1-/)
    expect(two.payload.store.media![0]!.filename).toMatch(/^t2-/)
    expect(two.report.files.alreadyCopied).toBe(0)
  })

  it('reports the same documents in a dry run when two records share a file', async () => {
    // Organisations 2 and 3 are one organisation; give two organisations the same logo.
    const tables = structuredClone(mediaTables)
    tables.wp_usermeta!.push({ meta_id: 9001, umeta_id: 9001, user_id: 6, meta_key: 'company-logo', meta_value: '501' })
    const t = run()
    const reader = () => new MysqlReader({ connect: async () => createFixtureConnection(tables) })
    const dry = await t.go({ dryRun: true, reader: reader() })
    const real = await t.go({ reader: reader() })
    expect(real.documents).toEqual(dry.documents)
    expect(real.documents.existing).toBeGreaterThanOrEqual(1) // the second owner of the shared logo
    expect({ ...real, dryRun: true }).toEqual(dry)
  })

  it('uses the slugs it is given', async () => {
    const payload = createFakePayload({
      acme_orgs: [{ id: 1, legacyId: 2, tenant: TENANT }],
    })
    const bucket = fakeBucket()
    const report = await runMediaImport({
      payload: payload.payload,
      reader: readerFor(),
      slugs: { documents: 'files', jobs: 'acme_jobs', media: 'images', organisations: 'acme_orgs', pages: 'acme_pages' },
      source: fakeSource(mediaFiles).source,
      target: bucket.target,
      tenant: TENANT,
    })
    expect(report.relations.set).toBe(1)
    expect(payload.store.images).toHaveLength(1)
    expect(payload.store.media).toBeUndefined()
  })
})

describe('site chrome media @S-263', () => {
  // The legacy header banner and logo live in wp_options, not in a post.
  const chromeTables = {
    ...mediaTables,
    wp_options: [
      { option_id: 1, option_name: 'jr_enable_header_banner', option_value: '1' },
      {
        option_id: 2,
        option_name: 'jr_header_banner',
        option_value:
          '<a href="https://ycv.vu"><img alt="Powered by YCV" src="https://vanuatuwok.vu/app/uploads/2021/11/header.png"></a>',
      },
      {
        option_id: 3,
        option_name: 'jr_listing_banner',
        option_value: '<img src="https://vanuatuwok.vu/app/uploads/2021/11/header-mobile.png">',
      },
      {
        option_id: 4,
        option_name: 'jr_logo_url',
        option_value: 'https://vanuatuwok.vu/app/uploads/2020/05/cropped-logo.png',
      },
    ],
  }
  const chromeFiles = {
    ...mediaFiles,
    '2021/11/header.png': 'PNG-header',
    '2021/11/header-mobile.png': 'PNG-header-mobile',
    '2020/05/cropped-logo.png': 'PNG-logo',
  }

  const runChrome = (payload: ReturnType<typeof createFakePayload>, bucket = fakeBucket()) =>
    runMediaImport({
      payload: payload.payload,
      reader: new MysqlReader({ connect: async () => createFixtureConnection(chromeTables), pageSize: 3 }),
      source: fakeSource(chromeFiles).source,
      target: bucket.target,
      tenant: TENANT,
    })

  it('copies the header banner and logo and links them to the site settings', async () => {
    const payload = createFakePayload({
      'site-settings': [{ id: 1, lang: 'en', legacyId: 1, tenant: TENANT }],
    })
    const report = await runChrome(payload)

    expect(report.files.copied).toBe(3)
    const settings = payload.store['site-settings']![0]!
    const mediaDoc = (id: unknown) => payload.store.media!.find((doc) => doc.id === id)!

    // One Banner block, with both images and the legacy link and alt text.
    expect(settings.headerBanner).toEqual([
      {
        alt: 'Powered by YCV',
        blockType: 'banner',
        desktopImage: expect.any(Number),
        href: 'https://ycv.vu',
        mobileImage: expect.any(Number),
      },
    ])
    expect(mediaDoc((settings.headerBanner as { desktopImage: unknown }[])[0]!.desktopImage).filename).toBe(
      objectName(TENANT, '2021/11/header.png'),
    )
    expect(mediaDoc((settings.headerBanner as { mobileImage: unknown }[])[0]!.mobileImage).filename).toBe(
      objectName(TENANT, '2021/11/header-mobile.png'),
    )
    expect(mediaDoc(settings.logo).filename).toBe(objectName(TENANT, '2020/05/cropped-logo.png'))
  })

  it('leaves a banner image a person has already set alone', async () => {
    const payload = createFakePayload({
      'site-settings': [
        {
          headerBanner: [{ blockType: 'banner', desktopImage: 999 }],
          id: 1,
          lang: 'en',
          legacyId: 1,
          tenant: TENANT,
        },
      ],
    })
    const report = await runChrome(payload)

    expect(report.relations.kept).toBe(1)
    expect((payload.store['site-settings']![0]!.headerBanner as { desktopImage: unknown }[])[0]!.desktopImage).toBe(999)
  })

  it('is idempotent for the chrome files', async () => {
    const payload = createFakePayload({
      'site-settings': [{ id: 1, lang: 'en', legacyId: 1, tenant: TENANT }],
    })
    const bucket = fakeBucket()
    await runChrome(payload, bucket)
    const writes = payload.writes.length
    const second = await runChrome(payload, bucket)

    expect(second.files.copied).toBe(0)
    expect(second.relations.set).toBe(0)
    expect(payload.writes.length).toBe(writes)
  })
})

describe('stores @S-148', () => {
  it('copies through a real directory target and verifies it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wpmedia-'))
    try {
      await mkdir(path.join(root, 'src/2022'), { recursive: true })
      await writeFile(path.join(root, 'src/2022/a.pdf'), 'pdf bytes')
      const source = directorySource(path.join(root, 'src'))
      const target = directoryTarget(path.join(root, 'out'))
      const result = await copyFile({ contentType: 'application/pdf', key: '2022-a.pdf', path: '2022/a.pdf', source, target })
      expect(result.outcome).toBe('copied')
      expect(await readFile(path.join(root, 'out/2022-a.pdf'), 'utf8')).toBe('pdf bytes')
      expect(await readdir(path.join(root, 'out'))).not.toContain('2022-a.pdf.partial')
      expect((await target.head('2022-a.pdf'))?.sha256).toHaveLength(64)
      expect((await copyFile({ contentType: 'application/pdf', key: '2022-a.pdf', path: '2022/a.pdf', source, target })).outcome).toBe('already-copied')

      // A wrong checksum is refused and leaves nothing.
      await expect(
        target.put('bad.pdf', (async function* () { yield new TextEncoder().encode('x') })(), { contentType: 'x', sha256: '0'.repeat(64), size: 1 }),
      ).rejects.toThrow('Checksum mismatch')
      expect(await target.head('bad.pdf')).toBeNull()
      expect(await readdir(path.join(root, 'out'))).not.toContain('bad.pdf.partial')
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('refuses a path that leaves the uploads directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wpmedia-'))
    try {
      await expect(directorySource(root).stat('../outside')).rejects.toThrow('escapes')
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('passes the checksum to the R2 binding and records it', async () => {
    const stored = new Map<string, { size: number; customMetadata?: Record<string, string> }>()
    let options: Record<string, unknown> | undefined
    const target = r2Target({
      delete: async (key) => void stored.delete(key),
      head: async (key) => stored.get(key) ?? null,
      put: async (key, value, opts) => {
        options = opts
        stored.set(key, { customMetadata: opts?.customMetadata, size: (value as Uint8Array).byteLength })
      },
    })
    const data = new TextEncoder().encode('abc')
    await target.put('k', (async function* () { yield data })(), { contentType: 'image/png', sha256: 'ff'.repeat(32), size: 3 })
    expect(options).toMatchObject({ httpMetadata: { contentType: 'image/png' }, sha256: 'ff'.repeat(32) })
    expect(await target.head('k')).toEqual({ sha256: 'ff'.repeat(32), size: 3 })
  })
})

describe('arguments @S-148', () => {
  it('needs a tenant, a source and exactly one target', () => {
    const base = ['--tenant', 'vwok', '--source', '/uploads']
    expect(parseMediaArgs([...base, '--target-dir', '/out', '--dry-run', '--verify'])).toMatchObject({
      dryRun: true,
      targetDir: '/out',
      verify: true,
    })
    expect(() => parseMediaArgs(base)).toThrow('exactly one')
    expect(() => parseMediaArgs([...base, '--target-dir', '/o', '--r2-local'])).toThrow('exactly one')
    expect(() => parseMediaArgs(['--source', '/u', '--r2-local'])).toThrow('--tenant')
    expect(() => parseMediaArgs([...base, '--r2-local', '--bogus'])).toThrow('Unknown')
    expect(() => parseMediaArgs([...base, '--target-dir', ''])).toThrow('needs a directory')
  })
})
