import type { Payload, PayloadRequest } from 'payload'

/**
 * Privacy policy and terms of use (PJ-89, S-310). Every site gets both pages as *drafts* with
 * placeholder text: the policy wording is written or approved by the founder (STATUS.md,
 * 19 Nov), so nothing here pretends to be legal copy.
 *
 * They are ordinary pages, not system pages: no `role` and no schema change. A site manager
 * edits the text, sets the address and publishes when the founder has approved it. The theme
 * links to them by slug, which is why the seed fixes those slugs.
 */

export const LEGAL_PAGE_SLUGS = {
  privacy: 'privacy',
  terms: 'terms',
} as const

export type LegalPageKind = keyof typeof LEGAL_PAGE_SLUGS

export type LegalPageSeed = {
  /** Path on the site, and how the theme finds the page. */
  slug: string
  title: string
}

export const LEGAL_PAGE_SEEDS: readonly LegalPageSeed[] = [
  { slug: LEGAL_PAGE_SLUGS.privacy, title: 'Privacy policy' },
  { slug: LEGAL_PAGE_SLUGS.terms, title: 'Terms of use' },
]

/** Starts every placeholder paragraph, so a published-by-mistake page is obvious on the site. */
export const LEGAL_PLACEHOLDER_MARKER = 'PLACEHOLDER —'

/**
 * The placeholder body. It states what the page must cover, from the decisions the policy has
 * to reflect, and never what the policy actually says.
 */
export const legalPlaceholderParagraphs = (): string[] => [
  `${LEGAL_PLACEHOLDER_MARKER} this page is a draft. The founder writes or approves the policy text before it is published.`,
  'It must cover: what personal data the site collects (account details, job applications and CVs, alert subscriptions), why, who can see it, and for how long. Applications and their files are kept for 12 months after the job closes.',
  'It must say how a person asks for their data to be removed: by email to the site’s admin address. Account deletion is not self-service; staff remove the personal data on request.',
  'Delete these paragraphs when the approved text is in place, then publish the page.',
]

type LexicalNode = { [key: string]: unknown; type: string }

const textNode = (text: string): LexicalNode => ({
  detail: 0,
  format: 0,
  mode: 'normal',
  style: '',
  text,
  type: 'text',
  version: 1,
})

const paragraph = (text: string): LexicalNode => ({
  children: [textNode(text)],
  direction: 'ltr',
  format: '',
  indent: 0,
  type: 'paragraph',
  version: 1,
})

/** A Lexical value the `rich-text` block accepts: one paragraph per placeholder line. */
export const legalPlaceholderContent = (): Record<string, unknown> => ({
  root: {
    children: legalPlaceholderParagraphs().map(paragraph),
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
})

/**
 * The page body. The `rich-text` block is the host's (registered in `config.blocks`, PJ-84), so
 * the placeholder only goes in when that slug is registered; otherwise the page is seeded with
 * an empty layout and the title alone.
 */
export const legalPageLayout = (blockSlugs: readonly string[]): Record<string, unknown>[] =>
  blockSlugs.includes('rich-text')
    ? [
        {
          blockType: 'rich-text',
          content: legalPlaceholderContent(),
          heading: 'Draft',
        },
      ]
    : []

type PageLike = { id?: null | number | string; slug?: null | string }

export type SeedLegalPagesArgs = {
  /** Block slugs the host registered; the placeholder body needs `rich-text`. */
  blockSlugs?: readonly string[]
  /** Slug of the pages collection. */
  collectionSlug?: string
  /** The request that created the tenant, so the pages join its transaction. */
  req?: PayloadRequest
  /** Overrides the default two pages, for tests. */
  seeds?: readonly LegalPageSeed[]
  tenantID: number | string
}

/**
 * The tenant hook: give every new site its privacy policy and terms drafts. Only on create, and
 * never for the aggregate tenant, which is a directory with no site of its own.
 */
export const seedTenantLegalPages =
  ({
    blockSlugs = [],
    collectionSlug = 'pages',
    tenantScoped = true,
  }: { blockSlugs?: readonly string[]; collectionSlug?: string; tenantScoped?: boolean } = {}) =>
  async ({
    doc,
    operation,
    req,
  }: {
    doc: Record<string, unknown>
    operation: string
    req: PayloadRequest
  }): Promise<void> => {
    if (!tenantScoped || operation !== 'create') return
    if (doc?.isAggregate === true) return

    await seedLegalPages(req.payload, {
      blockSlugs,
      collectionSlug,
      req,
      tenantID: doc.id as number | string,
    })
  }

/**
 * Create the site's missing legal pages, unpublished. Idempotent: a page whose slug is already
 * used in the tenant is left exactly as the site manager saved it, published or not.
 */
export const seedLegalPages = async (
  payload: Payload,
  {
    blockSlugs = [],
    collectionSlug = 'pages',
    req,
    seeds = LEGAL_PAGE_SEEDS,
    tenantID,
  }: SeedLegalPagesArgs,
): Promise<PageLike[]> => {
  const existing = await payload.find({
    collection: collectionSlug as never,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    ...(req ? { req } : {}),
    where: {
      and: [{ tenant: { equals: tenantID } }, { slug: { in: seeds.map((seed) => seed.slug) } }],
    },
  } as never)

  const have = new Set(
    (existing.docs as unknown as PageLike[])
      .map((doc) => doc.slug)
      .filter((slug): slug is string => Boolean(slug)),
  )

  const created: PageLike[] = []

  for (const seed of seeds) {
    if (have.has(seed.slug)) continue

    created.push(
      (await payload.create({
        collection: collectionSlug as never,
        data: {
          _status: 'draft',
          layout: legalPageLayout(blockSlugs),
          slug: seed.slug,
          tenant: tenantID,
          title: seed.title,
        },
        overrideAccess: true,
        ...(req ? { req } : {}),
      } as never)) as unknown as PageLike,
    )
  }

  return created
}
