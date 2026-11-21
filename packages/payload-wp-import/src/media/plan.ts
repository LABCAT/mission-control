import { buildImportPlan, type UserImportOptions } from '../importers/users'
import type { MysqlReader } from '../mysql-reader'
import type { MediaKind, MediaRef } from './types'

/**
 * Which legacy files the imported records point at (PJ-63). Nothing here touches a file: it
 * reads the WordPress database and returns references, so a dry run and the real run agree.
 *
 * A file is imported only when an imported record uses it: an organisation's logo and cover, a
 * job's description PDF, a page's image. Generated thumbnails (`-300x200.jpg`) are never
 * referenced, because `_wp_attached_file` names the original, and a URL that points at one is
 * mapped back to its original. `uploaded_cvs` and the other folders in `excludePaths` are
 * refused whatever points at them.
 */

export type MediaPlanOptions = {
  /** Uploads sub-folders that are never imported. Personal data and staging leftovers. */
  excludePaths?: string[]
  /**
   * User meta key that holds an organisation's cover image (an attachment id or an uploads URL).
   * The legacy site has no such key (query 17), so by default there are no covers.
   */
  coverMetaKey?: string
  /** User meta key that holds an organisation's logo. Default `company-logo`. */
  logoMetaKey?: string
  /** Page meta key for the image, tried in order. Default the featured image, then Yoast's. */
  pageImageMetaKeys?: string[]
  /** Passed on to the PJ-62 plan, so organisations are grouped exactly as they were imported. */
  users?: UserImportOptions
}

export const DEFAULT_EXCLUDED_PATHS = ['uploaded_cvs', 'wp-staging', 'at-logs']
const DOCUMENT_EXTENSIONS = ['doc', 'docx', 'pdf']

export type MediaPlan = {
  refs: MediaRef[]
  /** References dropped while planning, by reason. */
  skipped: Record<string, number>
}

type Attachment = { id: number; mime: string; parent: number; path?: string; title: string }

/** `2022/03/a-300x200.jpg` → `2022/03/a.jpg`. Only the WordPress generated size suffix. */
export const originalOfThumbnail = (relative: string): string =>
  relative.replace(/-\d{2,5}x\d{2,5}(\.[A-Za-z0-9]+)$/, '$1')

/**
 * A path inside uploads from what a meta value holds: a URL (`https://x/app/uploads/2020/a.png`)
 * or a relative path. Returns `null` for anything that is not under an `uploads` folder, so a
 * file hosted elsewhere is not guessed at.
 */
export const uploadsPathOf = (value: string): null | string => {
  const text = value.trim()
  if (!text) return null
  const marker = /\/uploads\/(.+)$/i.exec(text.split(/[?#]/)[0]!)
  const relative = marker ? marker[1]! : /^[a-z][a-z0-9+.-]*:/i.test(text) ? null : text
  if (!relative) return null
  const parts = relative.replaceAll('\\', '/').split('/').filter(Boolean)
  if (parts.length === 0 || parts.some((part) => part === '..' || part === '.')) return null
  try {
    return parts.map((part) => decodeURIComponent(part)).join('/')
  } catch {
    return null
  }
}

export const isExcluded = (relative: string, excluded: readonly string[]): boolean =>
  excluded.some((folder) => relative === folder || relative.startsWith(`${folder.replace(/\/$/, '')}/`))

const extensionOf = (relative: string): string => /\.([A-Za-z0-9]+)$/.exec(relative)?.[1]?.toLowerCase() ?? ''
export const isDocumentPath = (relative: string): boolean => DOCUMENT_EXTENSIONS.includes(extensionOf(relative))

export const buildMediaPlan = async (reader: MysqlReader, options: MediaPlanOptions = {}): Promise<MediaPlan> => {
  const excluded = options.excludePaths ?? DEFAULT_EXCLUDED_PATHS
  const logoKey = options.logoMetaKey ?? 'company-logo'
  const pageKeys = options.pageImageMetaKeys ?? ['_thumbnail_id', '_yoast_wpseo_opengraph-image-id']
  const skipped: Record<string, number> = {}
  const skip = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1)
  const refs: MediaRef[] = []

  // Attachments: id → file path, parent and type. About ten thousand rows.
  const attachments = new Map<number, Attachment>()
  for await (const row of reader.rows<Record<string, unknown>>('posts', {
    params: ['attachment'],
    where: 'post_type = ?',
  })) {
    attachments.set(Number(row.ID), {
      id: Number(row.ID),
      mime: String(row.post_mime_type ?? ''),
      parent: Number(row.post_parent ?? 0),
      title: String(row.post_title ?? ''),
    })
  }
  const attachmentByPath = new Map<string, Attachment>()
  for await (const row of reader.rows<Record<string, unknown>>('postmeta', {
    key: 'meta_id',
    params: ['_wp_attached_file'],
    where: 'meta_key = ?',
  })) {
    const attachment = attachments.get(Number(row.post_id))
    const relative = uploadsPathOf(String(row.meta_value ?? ''))
    if (!attachment || !relative) continue
    attachment.path = relative
    attachmentByPath.set(relative, attachment)
  }

  const fromAttachmentId = (id: number): Attachment | undefined => {
    const found = attachments.get(id)
    return found?.path ? found : undefined
  }

  /** A meta value as a file: an attachment id, or an uploads URL/path (a thumbnail URL → its original). */
  const resolveValue = (raw: string): { attachment?: Attachment; path: string } | null => {
    const text = raw.trim()
    if (!text) return null
    if (/^\d+$/.test(text)) {
      const attachment = fromAttachmentId(Number(text))
      return attachment ? { attachment, path: attachment.path! } : null
    }
    const relative = uploadsPathOf(text)
    if (!relative) return null
    const original = originalOfThumbnail(relative)
    const attachment = attachmentByPath.get(relative) ?? attachmentByPath.get(original)
    return { attachment, path: attachment?.path ?? original }
  }

  const add = (
    kind: MediaKind,
    owner: MediaRef['owner'],
    resolved: ReturnType<typeof resolveValue>,
    unresolvedReason: string,
  ) => {
    if (!resolved) return skip(unresolvedReason)
    if (isExcluded(resolved.path, excluded)) return skip('excluded-path')
    refs.push({
      attachmentId: resolved.attachment?.id,
      kind,
      owner,
      path: resolved.path,
      title: resolved.attachment?.title || undefined,
    })
  }

  // Organisation logo and cover. Grouped as PJ-62 grouped them: the first member (the owner)
  // with a value decides, and the organisation's legacy id is the owner's user id.
  const userKeys = [logoKey, ...(options.coverMetaKey ? [options.coverMetaKey] : [])]
  const userMeta = new Map<number, Record<string, string>>()
  for await (const row of reader.rows<Record<string, unknown>>('usermeta', {
    key: 'umeta_id',
    params: userKeys,
    where: `meta_key IN (${userKeys.map(() => '?').join(', ')})`,
  })) {
    const id = Number(row.user_id)
    userMeta.set(id, { ...userMeta.get(id), [String(row.meta_key)]: String(row.meta_value ?? '') })
  }
  const userPlan = await buildImportPlan(reader, options.users)
  for (const group of userPlan.groups) {
    const owner = { collection: 'organisations' as const, legacyId: group.members[0]!.user.ID }
    for (const [kind, key] of [['logo', logoKey], ['cover', options.coverMetaKey]] as const) {
      if (!key) continue
      const value = group.members.map((member) => userMeta.get(member.user.ID)?.[key]).find((v) => v?.trim())
      if (value) add(kind, owner, resolveValue(value), `${kind}-unresolved`)
    }
  }

  // Job description PDFs: documents attached to a job. Newest wins; older ones are not carried.
  const jobIds = new Set<number>()
  const pageIds = new Set<number>()
  for await (const row of reader.rows<Record<string, unknown>>('posts', {
    params: ['job_listing', 'page'],
    where: 'post_type IN (?, ?)',
  })) {
    ;(row.post_type === 'page' ? pageIds : jobIds).add(Number(row.ID))
  }
  const pdfByJob = new Map<number, Attachment>()
  for (const attachment of attachments.values()) {
    if (!jobIds.has(attachment.parent) || !attachment.path || !isDocumentPath(attachment.path)) continue
    // Before choosing: a newer file in a refused folder must not hide the real description.
    if (isExcluded(attachment.path, excluded)) {
      skip('excluded-path')
      continue
    }
    const current = pdfByJob.get(attachment.parent)
    if (current) skip('extra-document')
    if (!current || attachment.id > current.id) pdfByJob.set(attachment.parent, attachment)
  }
  for (const [jobId, attachment] of pdfByJob) {
    add('job-pdf', { collection: 'jobs', legacyId: jobId }, { attachment, path: attachment.path! }, 'pdf-unresolved')
  }

  // Page images: the featured image, else the Yoast share image.
  const pageMeta = new Map<number, Record<string, string>>()
  for await (const row of reader.rows<Record<string, unknown>>('postmeta', {
    key: 'meta_id',
    params: pageKeys,
    where: `meta_key IN (${pageKeys.map(() => '?').join(', ')})`,
  })) {
    const id = Number(row.post_id)
    if (!pageIds.has(id)) continue
    pageMeta.set(id, { ...pageMeta.get(id), [String(row.meta_key)]: String(row.meta_value ?? '') })
  }
  for (const [pageId, meta] of pageMeta) {
    const key = pageKeys.find((candidate) => meta[candidate]?.trim() && resolveValue(meta[candidate]!))
    if (key) add('page-image', { collection: 'pages', legacyId: pageId }, resolveValue(meta[key]!), 'page-image-unresolved')
    else skip('page-image-unresolved')
  }

  return { refs, skipped }
}
