import type { MysqlReader } from '../mysql-reader'
import { htmlToLexical } from '../html-to-lexical'
import { legacySlug, legacyText } from '../legacy-text'
import type { ImportContext, Importer, MappedDoc, SkippedRow } from '../types'

/**
 * Import of the legacy WordPress pages (PJ-67).
 *
 * Only the pages the site actually published are imported. The rest of `post_type = page` is
 * JobRoller and WordPress machinery — the dashboard, the submit form, the confirmation page,
 * the RSS templates — which the new site serves from routes, not from CMS content (query 9,
 * STATUS.md 19 Nov).
 *
 * The four system pages (home, about, contact, organisations) already exist on every site: the
 * tenant seed creates them (PJ-103). The importer adopts them by role and fills their content,
 * instead of creating a second home page.
 *
 * A page body that holds a form or another shortcode has no block to map it to yet — the contact
 * form is PJ-102 — so the shortcode is dropped and named in the report. The home page is the one
 * page built from blocks rather than rich text: the hero, the feature boxes, the latest-jobs
 * listing and the remaining copy come from the legacy page's own sections (STATUS.md, 19 Nov).
 */

export type PageRole = 'about' | 'contact' | 'home' | 'organisations'

/** A legacy page to import, addressed by its WordPress `post_name`. */
export type LegacyPageTarget = {
  /** What the page is, for the report, e.g. `For Employers`. */
  label: string
  /** The system page role it fills, when it is one of the four. */
  role?: PageRole
  /** `wp_posts.post_name`, the WordPress slug. */
  slug: string
}

/**
 * The pages STATUS.md lists for the import. Land Law Reforms and Organisation Competition come
 * along so the founder can unpublish them or point the redirect map at a 410 (PJ-42), and the
 * 2017 terms and conditions are imported for the founder's review. The legacy "Contact us"
 * (`contact`) is not here: the Contact system page is imported from `contact-2`, the page the
 * site actually linked from its menu.
 */
export const IMPORTABLE_PAGES: readonly LegacyPageTarget[] = [
  { label: 'Home', role: 'home', slug: 'home' },
  { label: 'About us', role: 'about', slug: 'about-us' },
  { label: 'Contact', role: 'contact', slug: 'contact-2' },
  { label: 'Organisations', role: 'organisations', slug: 'organisations' },
  { label: 'For Employers', slug: 'employers' },
  { label: 'Volunteering', slug: 'volunteer-jobs' },
  { label: 'Land Law Reforms', slug: 'land-law-reforms' },
  { label: 'Organisation Competition', slug: 'organisation-competition' },
  { label: 'Terms & Conditions', slug: 'terms-conditions' },
]

/** `wp_posts.post_name` → the page it maps to. The menu importer uses it too. */
export const IMPORTABLE_PAGE_BY_SLUG: ReadonlyMap<string, LegacyPageTarget> = new Map(
  IMPORTABLE_PAGES.map((target) => [target.slug, target]),
)

/**
 * Pages that look like content but are JobRoller or WordPress machinery. They are routes on the
 * new site, not documents, so they are not imported and the report lists them (PJ-68). The
 * legacy `contact` page is here because its successor is the `contact-2` system page.
 */
export const DROPPED_LEGACY_PAGES: readonly string[] = [
  'application-form',
  'blog',
  'confirm',
  'contact',
  'dashboard',
  'edit-job',
  'edit-resume',
  'home-2',
  'job-date-archive',
  'job-email-text',
  'jobs',
  'login',
  'my-profile',
  'no-resumes',
  'password-recovery',
  'password-reset',
  'purchase-job-pack',
  'purchase-resume-subscription',
  'register',
  'resend-confirmation',
  'rss-feed',
  'sample-page',
  'sign-up',
  'submit',
]

/** Shortcodes and embedded forms that have no block yet. The text around them is still imported. */
const FORM_SHORTCODE =
  /\[(?:\/?form|\/?contact-form|jr_[\w-]+|\/?gravityforms?|\/?wpforms|\/?ninja_form|\/?cf7)[^\]]*\]/gi
const EMBEDDED_FORM = /<form\b[^>]*>[\s\S]*?<\/form>/gi

export type PageContent = {
  /** The shortcodes and forms that were removed, so the report can name them. */
  forms: string[]
  /** The content with them taken out, as HTML. */
  html: string
}

/**
 * Take the unsupported shortcodes and embedded forms out of a legacy page body. A form has no
 * block in the CMS yet (the contact form is PJ-102), so importing its markup would either be
 * dropped by the rich-text allowlist or leak labels and inputs into the page as text.
 */
export const stripLegacyForms = (html: null | string | undefined): PageContent => {
  const forms: string[] = []

  const withoutForms = String(html ?? '').replaceAll(EMBEDDED_FORM, () => {
    forms.push('form')
    return ''
  })
  const withoutShortcodes = withoutForms.replaceAll(FORM_SHORTCODE, (match) => {
    forms.push(match.replaceAll(/\s+/g, ' ').trim().slice(0, 60))
    return ''
  })

  return { forms, html: withoutShortcodes }
}

/** A page body as blocks: one rich-text block, or none when the page has no text. */
export const pageLayout = (html: null | string | undefined): Record<string, unknown>[] => {
  const lexical = htmlToLexical(stripLegacyForms(html).html)

  return lexical ? [{ blockType: 'rich-text', content: lexical }] : []
}

/**
 * The legacy home page's own copy (STATUS.md, 19 Nov; the live page, 8 Nov crawl). The home page
 * is the one page whose structure is known by name, so its headline, tagline, buttons and three
 * feature boxes are written here rather than guessed at from the HTML. The legacy page carried
 * the same words in theme templates, not in `post_content`, so they cannot be read from the row.
 */
export const LEGACY_HOME = {
  eyebrow: undefined as string | undefined,
  heading: 'FIND A JOB IN VANUATU',
  body: 'Search jobs in Vanuatu, or post a vacancy and reach the right people.',
  featureBoxes: [
    {
      body: 'Browse every vacancy on the site, or search by keyword, category and location.',
      title: 'Search jobs',
    },
    {
      body: 'Post a job and reach job seekers across Vanuatu.',
      title: 'Employers',
    },
    {
      body: 'Register your CV so employers can find you.',
      title: 'Job seekers',
    },
  ],
  browseLink: { href: '/jobs', label: 'Browse all jobs' },
} as const

/** The job search form and latest-jobs list are job-specific blocks (PJ-84, PJ-39). */
export const JOB_SEARCH_BLOCK = 'job-search'
export const LATEST_JOBS_BLOCK = 'latest-jobs'

/**
 * The home page layout: hero (headline, tagline, search form, "Browse all jobs"), three feature
 * boxes, the latest jobs with the RSS link, then the page's remaining copy as rich text. A block
 * the host has not registered is left out, so a site without the job blocks still imports.
 */
export const homeLayout = ({
  available = [],
  html,
}: {
  /** Block slugs the host registered. Defaults to the generic ones only. */
  available?: readonly string[]
  html?: null | string
}): Record<string, unknown>[] => {
  const can = (slug: string) => available.includes(slug)
  const layout: Record<string, unknown>[] = []

  layout.push({
    blockType: 'hero',
    body: LEGACY_HOME.body,
    heading: LEGACY_HOME.heading,
    links: [{ href: LEGACY_HOME.browseLink.href, label: LEGACY_HOME.browseLink.label, variant: 'primary' }],
  })
  if (can(JOB_SEARCH_BLOCK)) layout.push({ blockType: JOB_SEARCH_BLOCK })
  layout.push({
    blockType: 'feature-boxes',
    items: LEGACY_HOME.featureBoxes.map((item) => ({ body: item.body, title: item.title })),
  })
  if (can(LATEST_JOBS_BLOCK)) layout.push({ blockType: LATEST_JOBS_BLOCK, rssLink: true })

  const lexical = htmlToLexical(stripLegacyForms(html).html)
  if (lexical) layout.push({ blockType: 'rich-text', content: lexical })

  return layout
}

/** One `wp_posts` row of a page, with the target it fills. */
export type LegacyPage = {
  content: string
  /** `wp_posts.ID`, the collection's `legacyId`. */
  id: number
  /** The page this one sits under, `0` for a top-level page. */
  parent: number
  postName: string
  postStatus: string
  target: LegacyPageTarget
  title: string
}

/**
 * The legacy pages to import, in `ID` order so a run is repeatable. A page the site published is
 * imported published and a draft stays a draft; a trashed page is not imported at all.
 */
export const readLegacyPages = async (
  reader: MysqlReader,
  targets: readonly LegacyPageTarget[] = IMPORTABLE_PAGES,
): Promise<LegacyPage[]> => {
  const bySlug = new Map(targets.map((target) => [target.slug, target]))
  const pages: LegacyPage[] = []

  for await (const row of reader.rows<Record<string, unknown>>('posts', {
    params: ['page'],
    where: 'post_type = ?',
  })) {
    const target = bySlug.get(String(row.post_name ?? ''))
    if (!target || row.post_status === 'trash') continue

    pages.push({
      content: String(row.post_content ?? ''),
      id: Number(row.ID),
      parent: Number(row.post_parent ?? 0),
      postName: String(row.post_name ?? ''),
      postStatus: String(row.post_status ?? ''),
      target,
      title: legacyText(String(row.post_title ?? '')),
    })
  }

  return pages
}

export type MappedPage = {
  doc: MappedDoc
  /** Shortcodes and forms in the body that were not imported (PJ-102). */
  forms: string[]
}

export type MapPageOptions = {
  /** Block slugs the host registered, for the home page layout. */
  blockSlugs?: readonly string[]
}

/**
 * Map one legacy page. A system page keeps the address its role gives it (the seeded `/`,
 * `/about`, `/contact`, `/organisations`), so the legacy slug is not written back over it; a
 * normal page keeps the legacy slug, and the redirect map (PJ-70) covers any difference.
 */
export const mapLegacyPage = (
  page: LegacyPage,
  { blockSlugs = [] }: MapPageOptions = {},
): MappedPage | SkippedRow => {
  const { forms } = stripLegacyForms(page.content)
  const isHome = page.target.role === 'home'

  const data: Record<string, unknown> = {
    _status: page.postStatus === 'publish' ? 'published' : 'draft',
    layout: isHome
      ? homeLayout({ available: blockSlugs, html: page.content })
      : pageLayout(page.content),
    title: page.title || page.target.label,
  }

  if (page.target.role) data.role = page.target.role
  else {
    const slug = legacySlug(page.postName, page.title)
    if (!slug) return { skip: 'no-usable-slug' }
    data.slug = slug
  }

  return { doc: { data, legacyId: page.id }, forms }
}

export type PagesImportOptions = {
  /** Block slugs the host registered, for the home page layout. */
  blockSlugs?: readonly string[]
  /** Slug of the pages collection (the plugin resolves it). Default `pages`. */
  pagesSlug?: string
  /** The pages to import. Defaults to `IMPORTABLE_PAGES`. */
  targets?: readonly LegacyPageTarget[]
}

export const pagesImporter = (options: PagesImportOptions = {}): Importer<LegacyPage> => {
  const blockSlugs = options.blockSlugs ?? []
  const targets = options.targets ?? IMPORTABLE_PAGES
  const collection = options.pagesSlug ?? 'pages'
  const counts: Record<string, number> = {}
  let read = 0

  return {
    collection,
    dependsOn: [],
    /**
     * Adopt the system page the tenant seed created (PJ-103) instead of creating a second home
     * page. The lookup is by role, because a site manager may have renamed the page's slug.
     */
    findExisting: async ({ ctx, data }: { ctx: ImportContext; data: Record<string, unknown> }) => {
      if (typeof data.role !== 'string') return undefined

      const existing = await ctx.payload.find({
        collection,
        depth: 0,
        limit: 1,
        overrideAccess: true,
        pagination: false,
        where: { and: [{ role: { equals: data.role } }, { tenant: { equals: ctx.tenant } }] },
      })

      return existing.docs[0]
    },
    map: (page) => {
      const mapped = mapLegacyPage(page, { blockSlugs })
      if ('skip' in mapped) return mapped

      for (const form of mapped.forms) {
        const reason = `form block not imported: ${form}`
        counts[reason] = (counts[reason] ?? 0) + 1
      }
      if (page.target.role === 'home') {
        counts['home page built from blocks'] = 1
        for (const slug of [JOB_SEARCH_BLOCK, LATEST_JOBS_BLOCK]) {
          if (!blockSlugs.includes(slug)) {
            const reason = `${slug} block not registered: left out of the home page`
            counts[reason] = (counts[reason] ?? 0) + 1
          }
        }
      }
      if (page.parent !== 0) {
        const reason = 'nested in the legacy tree (imported top-level)'
        counts[reason] = (counts[reason] ?? 0) + 1
      }

      return mapped.doc
    },
    name: 'pages',
    read: async function* (reader) {
      const pages = await readLegacyPages(reader, targets)
      read = pages.length
      yield* pages
    },
    report: () => ({
      ...counts,
      'dropped legacy pages (routes, not content)': DROPPED_LEGACY_PAGES.length,
      'legacy pages read': read,
    }),
  }
}
