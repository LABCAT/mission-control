import type { MysqlReader } from '../mysql-reader'
import { legacyText } from '../legacy-text'
import type { ImportContext, Importer, MappedDoc } from '../types'

/**
 * Import of the legacy WordPress menus (PJ-67).
 *
 * WordPress keeps navigation as `nav_menu` terms, with `nav_menu_item` posts joined to the term
 * and their target in post meta (queries 11 and 26). The CMS keeps one menu per theme location —
 * top, primary and footer (PJ-103) — with ordered items, so each legacy menu becomes one
 * document and each item either a page link or a custom URL.
 *
 * A legacy item that points at a WordPress page the new site serves from a route (Submit Job,
 * Login, Password Reset) is remapped to the new path or dropped, and the report names it. A page
 * item whose page was not imported is dropped the same way, because a menu item with no target
 * would fail the collection's own validation.
 */

/** Mirrors the collection's `validateMenuUrl`: a path, an anchor, or an allowed scheme. */
const SAFE_URL = /^(?:\/(?!\/)|#|\?|https?:\/\/|mailto:|tel:)/i

export type MenuLocation = 'footer' | 'primary' | 'top'

/** The three legacy menus by the `wp_terms.name` the site used, and where each one renders. */
export const LEGACY_MENUS: readonly { location: MenuLocation; name: string }[] = [
  { location: 'primary', name: 'Main menu' },
  { location: 'top', name: 'Top menu' },
  { location: 'footer', name: 'Bottom menu' },
]

/**
 * Legacy menu items that pointed at a WordPress page the new site serves from a route: the
 * `wp_posts.post_name` of that page and what to link to instead. `null` means the item has no
 * equivalent and is dropped. The paths are the theme's routes (`/account/*` is the dashboard,
 * PJ-82; sign-in and reset are PJ-109 and PJ-81).
 */
export const REMAPPED_LEGACY_MENU_ITEMS: ReadonlyMap<
  string,
  { label: string; url: null | string }
> = new Map([
  ['login', { label: 'Login', url: '/account/login' }],
  ['register', { label: 'Register', url: '/account/register' }],
  ['password-reset', { label: 'Password Reset', url: '/account/reset-password' }],
  ['password-recovery', { label: 'Password Reset', url: '/account/reset-password' }],
  ['submit', { label: 'Submit Job', url: '/account/jobs/new' }],
  ['purchase-job-pack', { label: 'Buy a job pack', url: '/account/orders' }],
  ['purchase-resume-subscription', { label: 'Resume subscriptions', url: null }],
  ['dashboard', { label: 'Dashboard', url: '/account' }],
  ['my-profile', { label: 'My Profile', url: '/account' }],
  ['edit-resume', { label: 'My Profile', url: '/account' }],
  ['edit-job', { label: 'My Jobs', url: '/account/jobs' }],
  ['jobs', { label: 'Jobs', url: '/jobs' }],
])

/** A legacy menu item, resolved as far as the database allows. */
export type LegacyMenuItem = {
  /** `wp_posts.ID` of the `nav_menu_item` post, so the report can name a dropped item. */
  itemId: number
  /** The label the item carried; empty for a page item, which shows the page title. */
  label: string
  /** `wp_posts.post_name` of the page it points at, for a page item. */
  objectPostName?: string
  /** `_menu_item_object_id`: the page's `wp_posts.ID`, for a page item. */
  objectId?: number
  order: number
  /** `_menu_item_type`: `post_type` for a page item, `custom` for a URL. */
  type: string
  /** The raw URL, for a custom item. */
  url?: string
}

/** One legacy menu with its items, in display order. */
export type LegacyMenu = {
  items: LegacyMenuItem[]
  location: MenuLocation
  /** The legacy menu's name, kept for the report. */
  name: string
  /** `wp_terms.term_id`, the collection's `legacyId`. */
  termId: number
}

const ids = (values: Iterable<number>): string => [...values].map(() => '?').join(', ')

/**
 * Read the three legacy menus and their items. Items are `nav_menu_item` posts, their menu comes
 * from `wp_term_relationships`, their order from `menu_order`, and their target from
 * `wp_postmeta` (query 26). A menu with no items is still returned, so the site gets its three
 * locations even when the legacy menu was empty.
 */
export const readLegacyMenus = async (
  reader: MysqlReader,
  menus: readonly { location: MenuLocation; name: string }[] = LEGACY_MENUS,
): Promise<LegacyMenu[]> => {
  const found: LegacyMenu[] = []

  for (const menu of menus) {
    const [term] = await reader.query<Record<string, unknown>>(
      `SELECT * FROM \`${reader.table('terms')}\` WHERE name = ?`,
      [menu.name],
    )
    if (!term) continue

    const termId = Number(term.term_id)
    const taxonomies = await reader.query<Record<string, unknown>>(
      `SELECT * FROM \`${reader.table('term_taxonomy')}\` WHERE term_id = ? AND taxonomy = ?`,
      [termId, 'nav_menu'],
    )
    const taxonomyIds = taxonomies.map((row) => Number(row.term_taxonomy_id)).filter(Number.isInteger)

    const itemIds = new Set<number>()
    if (taxonomyIds.length > 0) {
      const relations = await reader.query<Record<string, unknown>>(
        `SELECT * FROM \`${reader.table('term_relationships')}\` WHERE term_taxonomy_id IN (${ids(taxonomyIds)})`,
        taxonomyIds,
      )
      for (const row of relations) itemIds.add(Number(row.object_id))
    }

    const items: LegacyMenuItem[] = []
    if (itemIds.size > 0) {
      const posts = await reader.query<Record<string, unknown>>(
        `SELECT * FROM \`${reader.table('posts')}\` WHERE ID IN (${ids(itemIds)}) AND post_type = ?`,
        [...itemIds, 'nav_menu_item'],
      )
      const meta = await reader.query<Record<string, unknown>>(
        `SELECT * FROM \`${reader.table('postmeta')}\` WHERE post_id IN (${ids(itemIds)})`,
        [...itemIds],
      )
      const metaByItem = new Map<number, Record<string, string>>()
      for (const row of meta) {
        const id = Number(row.post_id)
        metaByItem.set(id, { ...metaByItem.get(id), [String(row.meta_key)]: String(row.meta_value ?? '') })
      }

      const pageIds = new Set<number>()
      for (const post of posts) {
        const itemMeta = metaByItem.get(Number(post.ID)) ?? {}
        if (itemMeta._menu_item_type !== 'custom') pageIds.add(Number(itemMeta._menu_item_object_id ?? 0))
      }
      const pageNames = new Map<number, string>()
      if (pageIds.size > 0) {
        const pages = await reader.query<Record<string, unknown>>(
          `SELECT * FROM \`${reader.table('posts')}\` WHERE ID IN (${ids(pageIds)})`,
          [...pageIds],
        )
        for (const page of pages) pageNames.set(Number(page.ID), String(page.post_name ?? ''))
      }

      for (const post of posts) {
        const itemId = Number(post.ID)
        const itemMeta = metaByItem.get(itemId) ?? {}
        const type = itemMeta._menu_item_type || 'custom'
        const objectId = Number(itemMeta._menu_item_object_id ?? 0)

        items.push({
          itemId,
          label: legacyText(String(post.post_title ?? '')),
          order: Number(post.menu_order ?? 0),
          type,
          ...(type === 'custom'
            ? { url: String(itemMeta._menu_item_url ?? '') }
            : {
                objectId,
                objectPostName: pageNames.get(objectId),
              }),
        })
      }
    }

    found.push({
      items: items.sort((a, b) => a.order - b.order || a.itemId - b.itemId),
      location: menu.location,
      name: menu.name,
      termId,
    })
  }

  return found
}

/** A menu item as the collection stores it. */
export type MappedMenuItem = {
  label: string
  linkType: 'custom' | 'page'
  page?: number | string
  url?: string
}

export type MappedMenu = {
  /** Items left out, with the reason, for the dry-run report. */
  dropped: { label: string; reason: string }[]
  items: MappedMenuItem[]
}

/** The imported page a legacy page became, by `legacyId`. */
export type PageLookup = Map<number, { id: number | string; title: string }>

/**
 * Map one legacy menu to the collection's items.
 *
 * A page item becomes a page link to the imported page. When its page was not imported, the
 * item falls back to the route table (Submit Job → `/account/jobs/new`), and is dropped when
 * even that has no answer. A custom item keeps its URL, and is dropped when the URL is empty or
 * not one the collection accepts.
 */
export const mapLegacyMenu = (menu: LegacyMenu, pages: PageLookup): MappedMenu => {
  const dropped: MappedMenu['dropped'] = []
  const items: MappedMenuItem[] = []

  for (const item of menu.items) {
    const label = item.label || undefined

    if (item.type === 'custom') {
      const url = item.url?.trim()
      if (!url) {
        dropped.push({ label: label ?? `item ${item.itemId}`, reason: 'custom item with no URL' })
        continue
      }
      if (!SAFE_URL.test(url)) {
        dropped.push({ label: label ?? url, reason: 'unsupported URL scheme' })
        continue
      }
      items.push({ label: label ?? url, linkType: 'custom', url })
      continue
    }

    const page = item.objectId === undefined ? undefined : pages.get(item.objectId)
    if (page) {
      items.push({ label: label ?? page.title, linkType: 'page', page: page.id })
      continue
    }

    const remap = item.objectPostName ? REMAPPED_LEGACY_MENU_ITEMS.get(item.objectPostName) : undefined
    if (remap?.url) {
      items.push({ label: label ?? remap.label, linkType: 'custom', url: remap.url })
      continue
    }

    dropped.push({
      label: label ?? item.objectPostName ?? `item ${item.itemId}`,
      reason: remap
        ? 'no equivalent on the new site'
        : `page "${item.objectPostName ?? item.objectId ?? '?'}" not imported`,
    })
  }

  return { dropped, items }
}

export type MenusImportOptions = {
  /** Slug of the menus collection (the plugin resolves it). Default `menus`. */
  menusSlug?: string
  /** Slug of the pages collection, to resolve page items. Default `pages`. */
  pagesSlug?: string
}

/**
 * The menus importer. It depends on `pages` so a page item can link to the page the page
 * importer created; the page ids are looked up by `legacyId`, which the runner has written.
 */
export const menusImporter = (options: MenusImportOptions = {}): Importer<LegacyMenu> => {
  const collection = options.menusSlug ?? 'menus'
  const pagesSlug = options.pagesSlug ?? 'pages'
  const counts: Record<string, number> = {}
  let read = 0

  const pageLookup = async (ctx: ImportContext, menu: LegacyMenu): Promise<PageLookup> => {
    const wanted = menu.items
      .map((item) => item.objectId)
      .filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
    if (wanted.length === 0) return new Map()

    const found = await ctx.payload.find({
      collection: pagesSlug,
      depth: 0,
      limit: wanted.length,
      overrideAccess: true,
      pagination: false,
      where: { and: [{ legacyId: { in: wanted } }, { tenant: { equals: ctx.tenant } }] },
    })

    const lookup: PageLookup = new Map()
    for (const doc of found.docs) {
      const legacyId = Number(doc.legacyId)
      if (Number.isInteger(legacyId)) {
        lookup.set(legacyId, { id: doc.id, title: String(doc.title ?? '') })
      }
    }
    return lookup
  }

  return {
    collection,
    dependsOn: ['pages'],
    map: async (menu, ctx) => {
      const mapped = mapLegacyMenu(menu, await pageLookup(ctx, menu))
      for (const item of mapped.dropped) {
        const reason = `menu item dropped: ${item.reason}`
        counts[reason] = (counts[reason] ?? 0) + 1
      }

      const data: Record<string, unknown> = {
        items: mapped.items,
        location: menu.location,
        name: menu.name,
      }

      return { data, legacyId: menu.termId } satisfies MappedDoc
    },
    name: 'menus',
    read: async function* (reader) {
      const menus = await readLegacyMenus(reader)
      read = menus.length
      yield* menus
    },
    report: () => ({ ...counts, 'legacy menus read': read }),
  }
}
