/**
 * Privacy policy and terms links (PJ-89, S-310).
 *
 * The two pages are seeded per site by the CMS (payload-jobs `legal-pages.ts`) at fixed slugs,
 * so the theme can link to them without fetching anything. A site manager who adds the page to
 * the footer menu gets their own label; otherwise the default one is used. Nothing here ships
 * client JavaScript: the footer and the consent line are plain markup.
 */

export const LEGAL_LINK_KINDS = ['privacy', 'terms'] as const

export type LegalLinkKind = (typeof LEGAL_LINK_KINDS)[number]

export type LegalLink = {
  href: string
  kind: LegalLinkKind
  label: string
}

/** Paths the seeded pages are served at. */
export const LEGAL_PAGE_PATHS: Record<LegalLinkKind, string> = {
  privacy: '/privacy',
  terms: '/terms',
}

export const DEFAULT_LEGAL_LABELS: Record<LegalLinkKind, string> = {
  privacy: 'Privacy policy',
  terms: 'Terms of use',
}

/** The part of a CMS menu item this needs: a custom URL or a page relationship. */
export type LegalMenuItem = {
  label?: null | string
  page?: null | number | string | { slug?: null | string }
  url?: null | string
}

const pageSlugOf = (item: LegalMenuItem): null | string => {
  if (item.page === null || item.page === undefined) return null
  if (typeof item.page === 'object') return item.page.slug ?? null

  return null
}

/** `/privacy`, `/privacy/` and a full URL ending in `/privacy` all name the same page. */
const pathKind = (path: string): LegalLinkKind | null => {
  const trimmed = path.trim().replace(/\/+$/, '')

  return LEGAL_LINK_KINDS.find((kind) => trimmed.endsWith(LEGAL_PAGE_PATHS[kind])) ?? null
}

const itemKind = (item: LegalMenuItem): LegalLinkKind | null => {
  if (typeof item.url === 'string' && item.url.trim()) return pathKind(item.url)
  const slug = pageSlugOf(item)
  if (!slug) return null

  return LEGAL_LINK_KINDS.find((kind) => slug === kind) ?? null
}

/** The legal pages a footer menu already links to, so the footer does not repeat them. */
export const legalKindsInMenu = (items: readonly LegalMenuItem[]): LegalLinkKind[] =>
  LEGAL_LINK_KINDS.filter((kind) => items.some((item) => itemKind(item) === kind))

/**
 * The two legal links for a site's footer. A footer menu item that points at the page supplies
 * the label (and its own URL, in case the site moved the page); the rest come from the seed.
 */
export const legalFooterLinks = (
  items: readonly LegalMenuItem[] = [],
  labels: Partial<Record<LegalLinkKind, string>> = {},
): LegalLink[] => {
  const fromMenu = new Map<LegalLinkKind, LegalMenuItem>()
  for (const item of items) {
    const kind = itemKind(item)
    if (kind && !fromMenu.has(kind)) fromMenu.set(kind, item)
  }

  return LEGAL_LINK_KINDS.map((kind) => {
    const item = fromMenu.get(kind)
    const label = item?.label?.trim() || labels[kind] || DEFAULT_LEGAL_LABELS[kind]
    const url =
      typeof item?.url === 'string' && item.url.trim() ? item.url.trim() : LEGAL_PAGE_PATHS[kind]

    return { href: url, kind, label }
  })
}

/**
 * The consent line a form shows above its submit button (S-312). It names the policy page and
 * the terms page, and says what the person agrees to. The site manager can point the wording at
 * its own policy by passing a label; nothing is hardcoded per tenant.
 */
export type ConsentLineKind = 'alert' | 'apply' | 'signup'

export type ConsentLineOptions = {
  /** Label for the privacy link. Defaults to `Privacy policy`. */
  privacyLabel?: string
  /** Label for the terms link. Defaults to `Terms of use`. */
  termsLabel?: string
  /** Paths, when the site moved the pages. */
  privacyPath?: string
  termsPath?: string
}

export type ConsentLine = {
  privacy: LegalLink
  terms: LegalLink
  /** What the form says the person agrees to, without the links. */
  text: string
}

const consentText: Record<ConsentLineKind, string> = {
  alert: 'By subscribing you agree that we may email you matching jobs, and you accept our',
  apply:
    'By sending this application you agree that the employer and site staff may read your details and CV, and you accept our',
  signup: 'By creating an account you agree that we may hold and use your details as described in our',
}

export const consentLine = (
  kind: ConsentLineKind,
  options: ConsentLineOptions = {},
): ConsentLine => ({
  privacy: {
    href: options.privacyPath ?? LEGAL_PAGE_PATHS.privacy,
    kind: 'privacy',
    label: options.privacyLabel ?? DEFAULT_LEGAL_LABELS.privacy,
  },
  terms: {
    href: options.termsPath ?? LEGAL_PAGE_PATHS.terms,
    kind: 'terms',
    label: options.termsLabel ?? DEFAULT_LEGAL_LABELS.terms,
  },
  text: consentText[kind],
})
