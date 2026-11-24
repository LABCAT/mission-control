/**
 * The slug a legacy WordPress path names on the new site.
 *
 * Legacy permalinks are not quite slugs: an organisation page is `/organisation/{nickname}/`, and
 * the nickname keeps its spaces as `-` and its brackets as brackets
 * (`/organisation/bred-bank-(vanuatu)-limited/`). The importer builds the organisation document's
 * slug from the nickname text, so a redirect has to apply the same rule or it lands on a 404.
 * Payload's slug validators accept `[a-z0-9]+(-[a-z0-9]+)*`, which is the shape produced here.
 */
export const legacySlug = (value: string): string => {
  const text = value.trim().replaceAll(/\+/g, ' ')

  return text
    .normalize('NFKD')
    // Macrons and accents are combining marks once decomposed, so this strips both.
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

/**
 * The old site's path segment for a nickname as the new slug. A `-` stood for a space, so it is
 * turned back into one before slugging: `bred-bank-(vanuatu)-limited` becomes
 * `bred-bank-vanuatu-limited`, the slug the importer writes.
 */
export const organisationSlug = (legacyNickname: string): string =>
  legacySlug(legacyNickname.replaceAll('-', ' '))
