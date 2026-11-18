/**
 * Legacy WordPress text arrives in three shapes that matter for the import: HTML entities in
 * term names (`Construction &amp; roading`), slugs the site generated years ago, and free-text
 * addresses typed by employers. These helpers give the taxonomies and the location matcher one
 * way to normalise all of it.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  laquo: '«',
  lt: '<',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
}

const fromCodePoint = (code: number): string => {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Decode the entities WordPress actually stores in `wp_terms.name`. Numeric entities are
 * covered, so `&#038;` and `&#8211;` come back as `&` and `–`. Anything the table above does
 * not know is left alone rather than dropped.
 */
export const decodeLegacyEntities = (value: string): string =>
  value.replaceAll(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)

      return Number.isFinite(code) ? fromCodePoint(code) : match
    }

    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })

/** A term name or address as display text: entities decoded, tags and runs of space removed. */
export const legacyText = (value: null | string | undefined): string =>
  decodeLegacyEntities(String(value ?? ''))
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()

/**
 * Lowercase ASCII slug. The collection validators accept `[a-z0-9]+(-[a-z0-9]+)*`, so the
 * same shape is produced here; an empty result means the input had nothing usable in it.
 */
export const legacySlugPart = (value: null | string | undefined): string =>
  legacyText(value)
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')

/**
 * The slug to import a WordPress term under: its own slug when that sanitises to something
 * usable, otherwise one derived from its name. `null` means neither had a usable character,
 * and the term is skipped rather than written with an invalid slug.
 */
export const legacySlug = (
  value: null | string | undefined,
  fallbackName?: null | string,
): null | string => legacySlugPart(value) || legacySlugPart(fallbackName) || null
