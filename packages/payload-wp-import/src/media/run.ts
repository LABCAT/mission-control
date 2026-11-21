import { createHash } from 'node:crypto'

import type { MysqlReader } from '../mysql-reader'
import type { ImportPayload } from '../types'
import { copyFile, SourceMissingError, type CopyResult } from './copy'
import { buildMediaPlan, type MediaPlanOptions } from './plan'
import type { MediaKind, MediaRef, MediaSource, MediaTarget } from './types'

/** Slugs of the collections the import writes to. Always pass the plugin's resolved slugs. */
export type MediaSlugs = {
  documents: string
  jobs: string
  media: string
  organisations: string
  pages: string
}

export const DEFAULT_MEDIA_SLUGS: MediaSlugs = {
  documents: 'documents',
  jobs: 'jobs',
  media: 'media',
  organisations: 'organisations',
  pages: 'pages',
}

/** The cap the `documents` collection enforces on uploads (10 MB). */
export const DEFAULT_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}
const DOCUMENT_TYPES: Record<string, string> = {
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
}

const extensionOf = (relative: string): string => /\.([A-Za-z0-9]+)$/.exec(relative)?.[1]?.toLowerCase() ?? ''

/** The legacy path flattened to one readable segment, capped so the full name stays a legal file name. */
export const stableFilename = (relative: string): string =>
  relative
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll(/[^A-Za-z0-9._-]+/g, '_'))
    .join('-')
    .slice(-120)

/**
 * The name of a file in the bucket and in its media or documents document:
 * `t<tenant>-<hash of the legacy path>-<flattened path>`. The storage adapter serves files by one
 * path segment, so the folders are flattened, which alone is not injective (`my logo.png` and
 * `my_logo.png`, or `a/b-c` and `a-b/c`, flatten alike). The hash of the exact legacy path makes
 * the name unique per file, the tenant makes it unique per tenant in the shared bucket, and both
 * are derived from the inputs alone, so a re-run, or a second record using the same file, lands on
 * the same object, and no two files can ever be written to one object.
 */
export const objectName = (tenant: number | string, relative: string): string => {
  const hash = createHash('sha256').update(relative).digest('hex').slice(0, 12)
  return `t${String(tenant).replaceAll(/[^A-Za-z0-9]+/g, '_')}-${hash}-${stableFilename(relative)}`
}

/**
 * A stable negative id for a file that is not a WordPress attachment (a logo that is only a path),
 * so it can still be found by `legacyId`. Negative, so it never meets an attachment id.
 */
export const pathLegacyId = (relative: string): number => {
  let hash = 0x811c9dc5
  for (const char of relative) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0
  return -(hash || 1)
}

const FIELD_OF: Record<MediaKind, string> = {
  cover: 'cover',
  'job-pdf': 'jobDescriptionPdf',
  logo: 'logo',
  'page-image': 'seo.image',
}

export type MediaImportOptions = {
  /** Largest document to import in bytes; bigger ones are skipped. `0` = no limit. Default 10 MB. */
  maxDocumentBytes?: number
  plan?: MediaPlanOptions
  slugs?: Partial<MediaSlugs>
  /** Re-hash the source before trusting an object that is already in the bucket. */
  verify?: boolean
}

export type MediaFailure = { message: string; owner: string; path: string }

export type MediaReport = {
  /** Bytes in the files copied (a dry run: the bytes a real run would copy). */
  bytesCopied: number
  /** Bytes already in the bucket from an earlier run. */
  bytesPresent: number
  /** media/documents documents created, or that already existed. */
  documents: { created: number; existing: number }
  dryRun: boolean
  failures: MediaFailure[]
  /** Files written (a dry run: that would be written), and files found already in place. */
  files: { alreadyCopied: number; copied: number }
  /** File references found for imported records, before any are skipped. */
  planned: number
  /** Relations set on owners, and ones left alone because the owner already has a value. */
  relations: { kept: number; set: number }
  /** Why references were skipped, by reason. */
  skipped: Record<string, number>
}

type Doc = { id: number | string } & Record<string, any>

const valueAt = (doc: Doc, path: string): unknown => path.split('.').reduce<any>((value, key) => value?.[key], doc)
const idOf = (value: unknown): string | undefined =>
  value == null ? undefined : String(typeof value === 'object' ? (value as { id?: unknown }).id : value)

export type RunMediaImportOptions = MediaImportOptions & {
  dryRun?: boolean
  payload: ImportPayload
  reader: MysqlReader
  source: MediaSource
  target: MediaTarget
  tenant: number | string
  /** Tenant field name on the collections. Default `tenant`. */
  tenantField?: string
}

/**
 * Copy the legacy files that imported records use into the bucket and link them (PJ-63).
 *
 * Per reference: find the imported owner (none → skipped, and the file is not copied), copy the
 * file once however many records use it, create the media/documents document for it if missing
 * and set the owner's relation if it is empty. A relation that already holds another file is
 * left alone, as are all later edits by site managers. Re-running after the job and page
 * importers (PJ-64, PJ-67) picks up the records that did not exist before.
 */
export const runMediaImport = async (options: RunMediaImportOptions): Promise<MediaReport> => {
  const { payload, source, target, tenant } = options
  const dryRun = options.dryRun ?? false
  const tenantField = options.tenantField ?? 'tenant'
  const slugs = { ...DEFAULT_MEDIA_SLUGS, ...options.slugs }
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
  const report: MediaReport = {
    bytesCopied: 0,
    bytesPresent: 0,
    documents: { created: 0, existing: 0 },
    dryRun,
    failures: [],
    files: { alreadyCopied: 0, copied: 0 },
    planned: 0,
    relations: { kept: 0, set: 0 },
    skipped: {},
  }
  const skip = (reason: string) => (report.skipped[reason] = (report.skipped[reason] ?? 0) + 1)

  const plan = await buildMediaPlan(options.reader, options.plan)
  report.planned = plan.refs.length
  for (const [reason, count] of Object.entries(plan.skipped)) report.skipped[reason] = count

  const ownerSlugs = { jobs: slugs.jobs, organisations: slugs.organisations, pages: slugs.pages }
  const find = async (collection: string, legacyId: number): Promise<Doc | undefined> =>
    (
      await payload.find({
        collection,
        depth: 0,
        limit: 1,
        overrideAccess: true,
        pagination: false,
        where: { and: [{ legacyId: { equals: legacyId } }, { [tenantField]: { equals: tenant } }] },
      })
    ).docs[0] as Doc | undefined

  // One copy per file, however many records use it; a failure is remembered, not retried.
  const copies = new Map<string, CopyResult | Error>()
  const copyOnce = async (ref: MediaRef, contentType: string): Promise<CopyResult | Error> => {
    const known = copies.get(ref.path)
    if (known) return known
    let result: CopyResult | Error
    try {
      result = await copyFile({
        contentType,
        dryRun,
        key: objectName(tenant, ref.path),
        path: ref.path,
        source,
        target,
        verify: options.verify,
      })
      if (result.outcome === 'already-copied') {
        report.files.alreadyCopied++
        report.bytesPresent += result.bytes
      } else {
        report.files.copied++
        report.bytesCopied += result.bytes
      }
    } catch (error) {
      result = error instanceof Error ? error : new Error(String(error))
    }
    copies.set(ref.path, result)
    return result
  }

  const legacyIds = new Map<number, string>()
  // A dry run creates nothing, so it remembers which documents a real run would have created.
  const planned = new Set<string>()
  for (const ref of plan.refs) {
    const label = `${ref.owner.collection} #${ref.owner.legacyId}`
    const fail = (message: string) => report.failures.push({ message, owner: label, path: ref.path })

    try {
      const isDocument = ref.kind === 'job-pdf'
      const extension = extensionOf(ref.path)
      const contentType = (isDocument ? DOCUMENT_TYPES : IMAGE_TYPES)[extension]
      if (!contentType) {
        skip(isDocument ? 'not-a-document' : 'not-an-image')
        continue
      }

      const owner = await find(ownerSlugs[ref.owner.collection], ref.owner.legacyId)
      if (!owner) {
        skip('owner-not-imported')
        continue
      }

      // The size cap is checked before the copy, so an oversized file is never written.
      if (isDocument && maxDocumentBytes > 0) {
        const info = await source.stat(ref.path)
        if (info && info.size > maxDocumentBytes) {
          skip('over-size-limit')
          continue
        }
      }

      const copied = await copyOnce(ref, contentType)
      if (copied instanceof Error) {
        fail(copied instanceof SourceMissingError ? 'source file not found' : copied.message)
        continue
      }

      // The media / documents document that points at the object in the bucket.
      const collection = isDocument ? slugs.documents : slugs.media
      const legacyId = ref.attachmentId ?? pathLegacyId(ref.path)
      const claimed = legacyIds.get(legacyId)
      if (claimed && claimed !== ref.path) throw new Error(`Legacy id clash between ${claimed} and ${ref.path}`)
      legacyIds.set(legacyId, ref.path)
      const filename = objectName(tenant, ref.path)
      let file = await find(collection, legacyId)
      const plannedKey = `${collection}:${legacyId}`
      if (file || planned.has(plannedKey)) {
        report.documents.existing++
      } else {
        report.documents.created++
        if (dryRun) planned.add(plannedKey)
        if (!dryRun) {
          if (!payload.db) throw new Error('The media import needs payload.db')
          // Created through the adapter: the bytes are in the bucket already, and `create` with a
          // file would upload them a second time.
          const title = ref.title || filename
          file = (await payload.db.create({
            collection,
            data: {
              filename,
              filesize: copied.bytes,
              legacyId,
              mimeType: contentType,
              [tenantField]: tenant,
              ...(isDocument ? { title } : { alt: title }),
            },
          })) as Doc
        }
      }

      // The owner's relation. Set only when empty: a different file there was chosen by a person.
      const field = FIELD_OF[ref.kind]
      const current = idOf(valueAt(owner, field))
      if (current !== undefined && current !== String(file?.id)) {
        report.relations.kept++
        skip('relation-already-set')
        continue
      }
      if (current !== undefined) continue // already linked to this file by an earlier run

      report.relations.set++
      if (!dryRun && file) {
        const data =
          field === 'seo.image'
            ? { seo: { ...owner.seo, image: file.id } } // a group is replaced whole
            : { [field]: file.id }
        await payload.update({ collection: ownerSlugs[ref.owner.collection], data, id: owner.id, overrideAccess: true })
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  return report
}

/** A printable summary. Names owners by collection and legacy id only; no file contents. */
export const formatMediaReport = (report: MediaReport): string => {
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
  const verb = report.dryRun ? 'would copy' : 'copied'
  const lines = [
    report.dryRun ? 'Dry run: nothing was written.' : 'Media import finished.',
    `  references found: ${report.planned}`,
    `  files ${verb}: ${report.files.copied} (${mb(report.bytesCopied)})`,
    `  files already in place: ${report.files.alreadyCopied} (${mb(report.bytesPresent)})`,
    `  documents ${report.dryRun ? 'to create' : 'created'}: ${report.documents.created}, existing: ${report.documents.existing}`,
    `  relations ${report.dryRun ? 'to set' : 'set'}: ${report.relations.set}, left as they were: ${report.relations.kept}`,
  ]
  for (const [reason, count] of Object.entries(report.skipped).sort()) lines.push(`  skipped ${reason}: ${count}`)
  if (report.failures.length > 0) {
    lines.push(`Failures (${report.failures.length}):`)
    for (const failure of report.failures.slice(0, 20)) {
      lines.push(`  ${failure.owner} ${failure.path}: ${failure.message}`)
    }
    if (report.failures.length > 20) lines.push(`  …and ${report.failures.length - 20} more`)
  }
  return lines.join('\n')
}
