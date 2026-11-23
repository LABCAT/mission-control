import type { MysqlReader } from '../mysql-reader'
import { readLegacySiteChrome, SITE_SETTINGS_LEGACY_ID, type LegacySiteChrome } from '../site-chrome'
import type { ImportContext, Importer, MappedDoc } from '../types'

/**
 * Import of the legacy site settings (PJ-67).
 *
 * The site chrome lives in `wp_options` and in JobRoller's options, not in a post, so this
 * importer has one row: the site itself. Its `legacyId` is fixed (see `SITE_SETTINGS_LEGACY_ID`),
 * so a re-run updates the same document instead of adding a second set of settings.
 *
 * Every site is seeded with a settings document when the tenant is created, so the importer fills
 * that one in rather than creating another: `findExisting` adopts it by tenant, and the runner
 * writes `legacyId` onto it for the next run.
 *
 * The banner and logo are files, so the media import (PJ-63) owns them: it copies the images into
 * the bucket and writes the `headerBanner` block (with the legacy link) and the logo. A file
 * cannot be created from a path without fetching it, and the banner block requires its image.
 */

/** The uploads paths the media import needs, so it can link the banner and logo. */
export type SiteSettingsMedia = {
  bannerDesktopPath?: string
  bannerMobilePath?: string
  logoPath?: string
}

export const siteSettingsMedia = (chrome: LegacySiteChrome): SiteSettingsMedia => ({
  ...(chrome.banner.desktopPath ? { bannerDesktopPath: chrome.banner.desktopPath } : {}),
  ...(chrome.banner.mobilePath ? { bannerMobilePath: chrome.banner.mobilePath } : {}),
  ...(chrome.logoPath ? { logoPath: chrome.logoPath } : {}),
})

/**
 * The settings document. A field the legacy site had no value for is left out, so the collection's
 * own default applies (the language defaults to `en`).
 */
export const mapLegacySiteSettings = (chrome: LegacySiteChrome): MappedDoc => ({
  data: {
    ...(chrome.lang ? { lang: chrome.lang } : {}),
    ...(chrome.siteName ? { siteName: chrome.siteName } : {}),
    ...(chrome.tagline ? { tagline: chrome.tagline } : {}),
  },
  legacyId: SITE_SETTINGS_LEGACY_ID,
})

export type SiteSettingsImportOptions = {
  /** Slug of the site-settings collection (the plugin resolves it). Default `site-settings`. */
  siteSettingsSlug?: string
}

export const siteSettingsImporter = (
  options: SiteSettingsImportOptions = {},
): Importer<LegacySiteChrome> => {
  const collection = options.siteSettingsSlug ?? 'site-settings'
  const counts: Record<string, number> = {}
  let read = 0

  return {
    collection,
    dependsOn: [],
    findExisting: async ({ ctx }: { ctx: ImportContext }) => {
      const existing = await ctx.payload.find({
        collection,
        depth: 0,
        limit: 1,
        overrideAccess: true,
        pagination: false,
        where: { tenant: { equals: ctx.tenant } },
      })

      return existing.docs[0]
    },
    map: (chrome) => {
      read = 1
      const media = siteSettingsMedia(chrome)
      if (media.bannerDesktopPath || media.bannerMobilePath) {
        counts['banner images left for the media import'] = 1
      }
      if (media.logoPath) counts['logo left for the media import'] = 1
      if (!chrome.banner.desktopPath && !chrome.banner.mobilePath) {
        counts['no legacy header banner'] = 1
      }
      if (!chrome.lang) counts['no legacy language (default en)'] = 1

      return mapLegacySiteSettings(chrome)
    },
    name: 'site-settings',
    read: async function* (reader: MysqlReader) {
      yield await readLegacySiteChrome(reader)
    },
    report: () => ({ ...counts, 'legacy settings read': read }),
  }
}
