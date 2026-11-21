import { APIError, type Payload, type PayloadRequest } from 'payload'

/**
 * System pages (PJ-103). Every site gets four pages the site structure depends on: Home
 * (served at `/`), About, Contact and Organisations. A page is a system page when its `role`
 * is set. Editors write its content, but cannot delete it, change its role, or change what it
 * means for the site's URLs; they unpublish it instead.
 */

export const PAGE_ROLES = ['home', 'about', 'contact', 'organisations'] as const

export type PageRole = (typeof PAGE_ROLES)[number]

/**
 * Set by the tenant-delete cleanup. Deleting a site must remove its pages, system pages
 * included, so that one delete has to bypass the guard that protects them.
 */
export const SYSTEM_PAGE_CLEANUP_CONTEXT = 'missionControlSystemPageCleanup'

/**
 * Roles with a reserved URL branch. `home` is `/` itself, and `/organisations/{slug}` belongs
 * to organisation profiles, so neither page may have children.
 */
export const PAGES_WITHOUT_CHILDREN: readonly PageRole[] = ['home', 'organisations']

const roleLabels: Record<PageRole, string> = {
  about: 'About',
  contact: 'Contact',
  home: 'Home',
  organisations: 'Organisations',
}

export const pageRoleOptions = PAGE_ROLES.map((value) => ({
  label: roleLabels[value],
  value,
}))

export type SystemPageSeed = {
  role: PageRole
  /** Path on the tenant's site. `null` for home, which is served at `/`. */
  slug: null | string
  title: string
}

/**
 * The pages every site starts with. Their layout starts empty but valid: the blocks (hero,
 * latest jobs, organisation directory) come from the site manager or the WordPress import
 * (PJ-67), not from the seed.
 */
export const SYSTEM_PAGE_SEEDS: readonly SystemPageSeed[] = [
  { role: 'home', slug: null, title: 'Home' },
  { role: 'about', slug: 'about', title: 'About us' },
  { role: 'contact', slug: 'contact', title: 'Contact' },
  { role: 'organisations', slug: 'organisations', title: 'Organisations' },
]

type PageLike = {
  id?: null | number | string
  role?: null | PageRole
  tenant?: unknown
}

export const isSystemPage = (page: PageLike | null | undefined): boolean => Boolean(page?.role)

export type SeedSystemPagesArgs = {
  /** Slug of the pages collection. */
  collectionSlug?: string
  /**
   * The request that created the tenant. Its transaction holds the tenant row, which the
   * new pages foreign-key, so the seed must join it rather than open a connection of its own.
   */
  req?: PayloadRequest
  /** Overrides the default four pages, for tests and for a tenant type without a directory. */
  seeds?: readonly SystemPageSeed[]
  tenantID: number | string
}

/**
 * Create the tenant's missing system pages and leave existing ones alone.
 *
 * Idempotent on purpose: the tenant hook runs on every tenant create (a retried seed, a test
 * boot, a re-run import), and PJ-67 also writes these pages. The lookup is by `role`, not by
 * slug, because a site manager may rename the about page's slug after seeding.
 */
export const seedSystemPages = async (
  payload: Payload,
  { collectionSlug = 'pages', req, seeds = SYSTEM_PAGE_SEEDS, tenantID }: SeedSystemPagesArgs,
): Promise<PageLike[]> => {
  const existing = await payload.find({
    collection: collectionSlug as never,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    ...(req ? { req } : {}),
    where: {
      and: [{ tenant: { equals: tenantID } }, { role: { in: seeds.map((seed) => seed.role) } }],
    },
  } as never)

  const have = new Set(
    (existing.docs as unknown as PageLike[])
      .map((doc) => doc.role)
      .filter((role): role is PageRole => Boolean(role)),
  )

  const created: PageLike[] = []

  for (const seed of seeds) {
    if (have.has(seed.role)) continue

    created.push(
      (await payload.create({
        collection: collectionSlug as never,
        data: {
          _status: 'published',
          layout: [],
          role: seed.role,
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

/**
 * Delete a tenant's pages before the tenant row goes, as the site-keys and alert-subscription
 * hooks do. The tenant relationship is nullable, so Postgres would otherwise only detach the
 * pages (ON DELETE SET NULL) and leave orphans behind. The cleanup flag lets this one delete
 * remove system pages, which the `beforeDelete` guard refuses everywhere else.
 */
export const removeTenantPages =
  ({ collectionSlug = 'pages' }: { collectionSlug?: string } = {}) =>
  async ({ id, req }: { id: number | string; req: PayloadRequest }): Promise<void> => {
    const context = (req.context ??= {})
    const previous = context[SYSTEM_PAGE_CLEANUP_CONTEXT]
    context[SYSTEM_PAGE_CLEANUP_CONTEXT] = true

    try {
      await req.payload.delete({
        collection: collectionSlug as never,
        overrideAccess: true,
        req,
        where: { tenant: { equals: id } },
      })
    } finally {
      if (previous === undefined) delete context[SYSTEM_PAGE_CLEANUP_CONTEXT]
      else context[SYSTEM_PAGE_CLEANUP_CONTEXT] = previous
    }
  }

/**
 * The tenant hook: give every new site its four system pages. Only on create, and never for
 * the aggregate tenant, which is a directory with no site of its own. Existing tenants keep
 * whatever they have, so re-running a seed or an import is safe.
 */
export const seedTenantSystemPages =
  ({ collectionSlug = 'pages', tenantScoped = true }: { collectionSlug?: string; tenantScoped?: boolean } = {}) =>
  async ({ doc, operation, req }: { doc: Record<string, unknown>; operation: string; req: PayloadRequest }): Promise<void> => {
    if (!tenantScoped || operation !== 'create') return
    if (doc?.isAggregate === true) return

    await seedSystemPages(req.payload, {
      collectionSlug,
      req,
      tenantID: doc.id as number | string,
    })
  }

/** A rule error the caller can act on, rather than a bare 403 or a silently dropped value. */
export const systemPageError = (message: string, path = 'role'): APIError =>
  new APIError(message, 400, { errors: [{ message, path }] })
