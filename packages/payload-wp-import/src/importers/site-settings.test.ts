import { describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { runImport } from '../run-import'
import { createFakePayload } from '../test-utils'
import { createFixtureConnection, pageTables } from '../test/fixtures'
import {
  SITE_SETTINGS_LEGACY_ID,
  legacyLang,
  parseLegacyBanner,
  readLegacySiteChrome,
} from '../site-chrome'
import { mapLegacySiteSettings, siteSettingsImporter, siteSettingsMedia } from './site-settings'

const TENANT = 1

const readerFor = (tables = pageTables) =>
  new MysqlReader({ connect: async () => createFixtureConnection(tables), pageSize: 4 })

const chrome = () => readLegacySiteChrome(readerFor())

describe('legacy site chrome @S-263', () => {
  it('reads the name, tagline and language from wp_options', async () => {
    expect(await chrome()).toMatchObject({
      lang: 'en-vu',
      siteName: 'Vanuatu Wok',
      tagline: 'Jobs in Vanuatu',
    })
  })

  it('reads the header banner with its link, alt text and both images', async () => {
    const { banner } = await chrome()

    expect(banner).toEqual({
      alt: 'Powered by YCV',
      desktopPath: '2021/11/header.png',
      href: 'https://ycv.vu',
      mobilePath: '2021/11/header-320x50.png',
    })
  })

  it('reads the logo path', async () => {
    expect((await chrome()).logoPath).toBe('2020/05/cropped-logo.png')
  })

  it('takes a banner switched off in JobRoller as no banner', () => {
    expect(
      parseLegacyBanner({
        desktop: '<img src="https://x/app/uploads/a.png">',
        enabled: '0',
      }),
    ).toEqual({})
  })

  it('drops a banner link that is not a safe href', () => {
    const banner = parseLegacyBanner({
      desktop: '<a href="javascript:alert(1)"><img src="https://x/app/uploads/a.png"></a>',
      enabled: '1',
    })

    expect(banner.href).toBeUndefined()
    expect(banner.desktopPath).toBe('a.png')
  })

  it('accepts a BCP 47 language tag and refuses anything else', () => {
    expect(legacyLang('en_VU')).toBe('en-vu')
    expect(legacyLang('fr')).toBe('fr')
    expect(legacyLang('')).toBeUndefined()
    expect(legacyLang('English (Vanuatu)')).toBeUndefined()
  })

  it('returns nothing for a site with no options table', async () => {
    const chrome = await readLegacySiteChrome(readerFor({ wp_posts: [] }))

    expect(chrome).toEqual({ banner: {} })
  })
})

describe('site settings mapping @S-263', () => {
  it('maps the chrome to one settings document with a fixed legacyId', async () => {
    const mapped = mapLegacySiteSettings(await chrome())

    expect(mapped.legacyId).toBe(SITE_SETTINGS_LEGACY_ID)
    expect(mapped.data).toEqual({
      lang: 'en-vu',
      siteName: 'Vanuatu Wok',
      tagline: 'Jobs in Vanuatu',
    })
  })

  it('leaves the language out when the legacy site had none, so the default applies', () => {
    const mapped = mapLegacySiteSettings({ banner: {} })

    expect(mapped.data).toEqual({})
  })

  it('names the files the media import will copy', async () => {
    expect(siteSettingsMedia(await chrome())).toEqual({
      bannerDesktopPath: '2021/11/header.png',
      bannerMobilePath: '2021/11/header-320x50.png',
      logoPath: '2020/05/cropped-logo.png',
    })
  })
})

describe('site settings import run @S-263', () => {
  const run = async (
    payload = createFakePayload({
      // The tenant seed created the settings document (PJ-103).
      'site-settings': [{ id: 1, lang: 'en', tenant: TENANT }],
    }),
    dryRun = false,
  ) => {
    const summary = await runImport({
      dryRun,
      importers: [siteSettingsImporter()],
      payload: payload.payload,
      reader: readerFor(),
      tenant: TENANT,
    })
    return { ...payload, summary }
  }

  it('fills the seeded settings document instead of creating a second one', async () => {
    const { store, summary } = await run()

    expect(summary.importers['site-settings']).toMatchObject({ created: 0, updated: 1, failed: 0 })
    expect(store['site-settings']).toHaveLength(1)
    expect(store['site-settings']![0]).toMatchObject({
      id: 1,
      lang: 'en-vu',
      legacyId: SITE_SETTINGS_LEGACY_ID,
      siteName: 'Vanuatu Wok',
      tagline: 'Jobs in Vanuatu',
      tenant: TENANT,
    })
  })

  it('creates the document when a site has no settings yet', async () => {
    const { store, summary } = await run(createFakePayload())

    expect(summary.importers['site-settings']).toMatchObject({ created: 1, failed: 0 })
    expect(store['site-settings']).toHaveLength(1)
    expect(store['site-settings']![0]!.legacyId).toBe(SITE_SETTINGS_LEGACY_ID)
  })

  it('creates nothing on a second run', async () => {
    const payload = createFakePayload({ 'site-settings': [{ id: 1, lang: 'en', tenant: TENANT }] })
    await run(payload)
    const second = await run(payload)

    expect(second.summary.importers['site-settings']).toMatchObject({ created: 0, updated: 1 })
    expect(payload.store['site-settings']).toHaveLength(1)
  })

  it('writes nothing in a dry run', async () => {
    const payload = createFakePayload({ 'site-settings': [{ id: 1, lang: 'en', tenant: TENANT }] })
    const { summary } = await run(payload, true)

    expect(summary.importers['site-settings']!.updated).toBe(1)
    expect(payload.writes).toHaveLength(0)
  })

  it('reports the banner and logo it left for the media import', async () => {
    const { summary } = await run()
    const report = summary.importers['site-settings']!.report ?? {}

    expect(report).toMatchObject({
      'banner images left for the media import': 1,
      'legacy settings read': 1,
      'logo left for the media import': 1,
    })
  })

  it('reports a site with no legacy banner or language', async () => {
    const payload = createFakePayload({ 'site-settings': [{ id: 1, lang: 'en', tenant: TENANT }] })
    const summary = await runImport({
      importers: [siteSettingsImporter()],
      payload: payload.payload,
      reader: readerFor({ wp_posts: [] }),
      tenant: TENANT,
    })

    expect(summary.importers['site-settings']!.report).toMatchObject({
      'no legacy header banner': 1,
      'no legacy language (default en)': 1,
    })
  })
})
