import type { MysqlReader } from './mysql-reader'
import { legacyText } from './legacy-text'
import { uploadsPathOf } from './uploads-path'

/**
 * The legacy site chrome: the site name, the tagline, the language and the header banner that
 * WordPress kept in `wp_options` (the banner through JobRoller's `jr_options`). Both the
 * site-settings importer (PJ-67) and the media plan (PJ-63) read it, so the paths the importer
 * records and the files the media import copies cannot drift apart.
 */

/**
 * The one legacy row these settings come from. `wp_options` has no id for "the site", so a fixed
 * value stands in; it only has to be the same on every run.
 */
export const SITE_SETTINGS_LEGACY_ID = 1

/** `wp_options` rows the site chrome is built from. */
export const SITE_CHROME_OPTIONS = [
  'WPLANG',
  'blogdescription',
  'blogname',
  'jr_enable_header_banner',
  'jr_header_banner',
  'jr_listing_banner',
  'jr_logo_url',
] as const

/** A banner image and the link around it, as the legacy option stored them. */
export type LegacyBanner = {
  alt?: string
  /** Path inside the uploads directory, for the media import. */
  desktopPath?: string
  href?: string
  mobilePath?: string
}

export type LegacySiteChrome = {
  banner: LegacyBanner
  lang?: string
  logoPath?: string
  siteName?: string
  tagline?: string
}

const attribute = (html: string, name: string): string | undefined => {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(html)

  return match?.[1] ?? match?.[2] ?? undefined
}

/**
 * Turn a JobRoller banner option into the pieces of a Banner block. The option is an `<a>` around
 * an `<img>`: the link is kept, each image becomes an uploads path, and the alt text comes from
 * the tag when the site set one. JobRoller's own switch is honoured: a banner saved but switched
 * off was not shown, so it is not imported.
 */
export const parseLegacyBanner = ({
  desktop,
  enabled,
  mobile,
}: {
  desktop?: null | string
  enabled?: null | string
  mobile?: null | string
}): LegacyBanner => {
  if (!enabled || enabled === '0') return {}
  if (!desktop && !mobile) return {}

  const html = desktop || mobile || ''
  const alt = attribute(html, 'alt')
  const href = attribute(html, 'href')
  const desktopPath = desktop ? (uploadsPathOf(attribute(desktop, 'src') ?? '') ?? undefined) : undefined
  const mobilePath = mobile ? (uploadsPathOf(attribute(mobile, 'src') ?? '') ?? undefined) : undefined

  return {
    ...(alt ? { alt: legacyText(alt) } : {}),
    ...(desktopPath ? { desktopPath } : {}),
    ...(href && /^(?:https?:\/\/|\/(?!\/))/i.test(href) ? { href } : {}),
    ...(mobilePath ? { mobilePath } : {}),
  }
}

/** A BCP 47 tag from WordPress's `WPLANG` option (`en_VU` → `en-VU`), or undefined. */
export const legacyLang = (value: null | string | undefined): string | undefined => {
  const tag = value?.trim().replaceAll('_', '-')
  return tag && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/i.test(tag) ? tag.toLowerCase() : undefined
}

/**
 * Read the chrome options as one object, last row winning as `get_option` does. A site without a
 * `wp_options` table (a fixture, an incomplete dump) gives an empty set instead of failing.
 */
export const readLegacySiteChrome = async (
  reader: MysqlReader,
  keys: readonly string[] = SITE_CHROME_OPTIONS,
): Promise<LegacySiteChrome> => {
  const options = new Map<string, string>()
  try {
    for await (const row of reader.rows<Record<string, unknown>>('options', { key: 'option_id' })) {
      const name = String(row.option_name ?? '')
      if (keys.includes(name)) options.set(name, String(row.option_value ?? ''))
    }
  } catch {
    // no wp_options table: nothing to import
  }

  const banner = parseLegacyBanner({
    desktop: options.get('jr_header_banner'),
    enabled: options.get('jr_enable_header_banner'),
    mobile: options.get('jr_listing_banner'),
  })
  const logoPath = uploadsPathOf(options.get('jr_logo_url') ?? '') ?? undefined
  const siteName = legacyText(options.get('blogname'))
  const tagline = legacyText(options.get('blogdescription'))

  return {
    banner,
    ...(legacyLang(options.get('WPLANG')) ? { lang: legacyLang(options.get('WPLANG')) } : {}),
    ...(logoPath ? { logoPath } : {}),
    ...(siteName ? { siteName } : {}),
    ...(tagline ? { tagline } : {}),
  }
}
