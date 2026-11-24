import { MysqlReader } from './mysql-reader'
import type {
  ImportContext,
  ImportDeletion,
  ImportFailure,
  ImportPayload,
  ImporterResult,
  Importer,
  ImportSummary,
} from './types'

export type RunImportOptions = {
  dryRun?: boolean
  importers: Importer[]
  /** One line per deletion, before and after it happens. Default: silent. */
  log?: (line: string) => void
  payload: ImportPayload
  /**
   * Delete documents of opted-in importers (`Importer.prune`) that were imported into this
   * tenant but are no longer in the source. In a dry run they are only listed.
   */
  prune?: boolean
  /** Apply `MappedDoc.refreshWhileSet` on re-runs. */
  refreshCredentials?: boolean
  /** Defaults to a reader configured from `WP_IMPORT_MYSQL_URL`. */
  reader?: MysqlReader
  tenant: number | string
  /** Name of the tenant relationship field on the collections. Default `tenant`. */
  tenantField?: string
}

/** Order importers so every one runs after its dependencies. Throws on unknown names or cycles. */
export const sortImporters = (importers: Importer[]): Importer[] => {
  const byName = new Map<string, Importer>()
  for (const importer of importers) {
    if (byName.has(importer.name)) throw new Error(`Duplicate importer "${importer.name}"`)
    byName.set(importer.name, importer)
  }

  const sorted: Importer[] = []
  const state = new Map<string, 'done' | 'visiting'>()

  const visit = (importer: Importer, path: string[]) => {
    const current = state.get(importer.name)
    if (current === 'done') return
    if (current === 'visiting') {
      const cycle = [...path.slice(path.indexOf(importer.name)), importer.name]
      throw new Error(`Importer dependency cycle: ${cycle.join(' -> ')}`)
    }
    state.set(importer.name, 'visiting')
    for (const dependency of importer.dependsOn) {
      const next = byName.get(dependency)
      if (!next) throw new Error(`Importer "${importer.name}" depends on unknown "${dependency}"`)
      visit(next, [...path, importer.name])
    }
    state.set(importer.name, 'done')
    sorted.push(importer)
  }

  for (const importer of importers) visit(importer, [])
  return sorted
}

// Database and validation errors can quote the offending value, such as a duplicate email, and
// the summary is printed. Nothing personal may reach it.
const EMAIL = /[^\s@'"<>(),;]+@[^\s@'"<>(),;]+/g
const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replaceAll(EMAIL, '[email]')

/**
 * Run importers in dependency order. Documents are matched by `legacyId` + tenant, so a
 * re-run updates instead of duplicating. Row errors are collected, not thrown. With
 * `dryRun` nothing is written, and counts show what a real run would do.
 */
export const runImport = async (options: RunImportOptions): Promise<ImportSummary> => {
  const { payload, tenant, tenantField = 'tenant' } = options
  const dryRun = options.dryRun ?? false
  const ordered = sortImporters(options.importers)
  const ctx: ImportContext = { dryRun, payload, refreshCredentials: options.refreshCredentials ?? false, tenant }
  const log = options.log ?? (() => {})
  const summary: ImportSummary = {
    deletions: [],
    dryRun,
    errors: [],
    importers: {},
    order: ordered.map((importer) => importer.name),
  }

  // Nothing to run means nothing to read: don't demand a MySQL connection.
  if (ordered.length === 0) return summary

  const ownReader = options.reader ? undefined : new MysqlReader()
  const reader = (options.reader ?? ownReader)!

  try {
    for (const importer of ordered) {
      const blocker = importer.dependsOn.find((name) => summary.importers[name]?.aborted)
      const result: ImporterResult = { created: 0, failed: 0, skipped: 0, updated: 0 }
      summary.importers[importer.name] = result

      if (blocker) {
        result.aborted = `dependency "${blocker}" did not complete`
        summary.errors.push({ importer: importer.name, message: result.aborted })
        continue
      }

      try {
        const seen = new Set<number>()
        for await (const row of importer.read(reader)) {
          await importRow(importer, row, ctx, tenantField, result, summary.errors, seen)
        }
        if (importer.report) result.report = importer.report()
        if (options.prune && importer.prune) {
          await pruneImporter({ ctx, importer, log, result, seen, summary, tenantField })
        }
      } catch (error) {
        result.aborted = `read failed: ${messageOf(error)}`
        summary.errors.push({ importer: importer.name, message: result.aborted })
      }
    }
  } finally {
    await ownReader?.close()
  }

  return summary
}

const pruneRefusal = (importer: Importer, result: ImporterResult, seen: Set<number>): string | undefined => {
  if (importer.findExisting) return 'the importer adopts existing documents, so it cannot tell which it created'
  if (importer.matchBy) return 'the importer has no legacyId'
  if (importer.tenantScope && importer.tenantScope.path !== 'tenant') return 'the importer does not scope by a plain tenant field'
  if (result.failed > 0) return `${result.failed} row(s) failed, so the source list is incomplete`
  if (result.skippedUnidentified) return `${result.skippedUnidentified} skipped row(s) gave no legacyId, so the source list is incomplete`
  if (seen.size === 0) return 'the source returned no rows, which would delete everything'
  return undefined
}

/**
 * Delete (or, in a dry run, list) documents of `importer` that were imported into the run's
 * tenant but whose legacy row is gone. Scope: the importer's collection, the run's tenant, and
 * documents with a `legacyId`, so nothing created in the CMS is touched. Refused unless the
 * whole source was read cleanly.
 */
const pruneImporter = async (args: {
  ctx: ImportContext
  importer: Importer
  log: (line: string) => void
  result: ImporterResult
  seen: Set<number>
  summary: ImportSummary
  tenantField: string
}): Promise<void> => {
  const { ctx, importer, log, result, seen, summary, tenantField } = args
  const refusal = pruneRefusal(importer, result, seen)
  if (refusal) {
    result.pruneRefused = refusal
    log(`prune ${importer.name}: refused, ${refusal}`)
    return
  }
  if (!ctx.payload.delete) throw new Error('prune needs payload.delete')

  const { collection } = importer
  const tenantPath = importer.tenantScope?.path ?? tenantField
  const found = await ctx.payload.find({
    collection,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: { and: [{ legacyId: { exists: true } }, { [tenantPath]: { equals: ctx.tenant } }] },
  })
  for (const doc of found.docs) {
    const legacyId = doc.legacyId
    if (!Number.isInteger(legacyId) || seen.has(legacyId)) continue
    // Belt and braces: the query is already scoped, but a delete must never cross tenants.
    const owner = doc[tenantPath]
    if (String(owner?.id ?? owner) !== String(ctx.tenant)) continue

    const deletion: ImportDeletion = { applied: false, collection, id: doc.id, importer: importer.name, legacyId }
    summary.deletions.push(deletion)
    if (ctx.dryRun) {
      log(`would delete ${collection} legacyId ${legacyId} (id ${doc.id})`)
      continue
    }
    try {
      await ctx.payload.delete({ collection, id: doc.id, overrideAccess: true })
      deletion.applied = true
      log(`deleted ${collection} legacyId ${legacyId} (id ${doc.id})`)
    } catch (error) {
      summary.errors.push({ importer: importer.name, legacyId, message: `delete failed: ${messageOf(error)}` })
    }
  }
}

/** Field names under layout-only containers (tabs without a name, rows, collapsibles). */
const localizedNames = (fields: any[]): string[] =>
  fields.flatMap((field) => {
    if (field.localized && field.name) return [field.name as string]
    if (field.type === 'tabs') {
      return (field.tabs ?? []).flatMap((tab: any) => (tab.name ? [] : localizedNames(tab.fields ?? [])))
    }
    if (!field.name && Array.isArray(field.fields)) return localizedNames(field.fields)
    return []
  })

/**
 * `payload.db.create` skips Payload's locale handling: with localization on, a localized field
 * must be `{ [locale]: value }`, or the adapter drops a plain value (a null title) and reads the
 * keys of a rich-text object as locale codes. Wrap each such field in the default locale.
 */
export const wrapLocalizedFields = (
  payload: ImportPayload,
  collection: string,
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const localization = payload.config?.localization
  if (!localization) return data
  const fields = payload.config?.collections?.find((c) => c.slug === collection)?.fields ?? []
  const out = { ...data }
  for (const name of localizedNames(fields)) {
    if (out[name] !== undefined && out[name] !== null) out[name] = { [localization.defaultLocale]: out[name] }
  }
  return out
}

/** The `refreshWhileSet` fields that still hold a value on the document and now differ. */
const refreshedFields = (found: Record<string, any>, wanted: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(wanted ?? {}).filter(
      ([field, value]) => value !== undefined && value !== null && value !== '' && found[field] && found[field] !== value,
    ),
  )

const importRow = async (
  importer: Importer,
  row: unknown,
  ctx: ImportContext,
  tenantField: string,
  counts: ImporterResult,
  errors: ImportFailure[],
  seen: Set<number>,
): Promise<void> => {
  let legacyId: number | undefined
  try {
    const mapped = await importer.map(row, ctx)
    if (!mapped || 'skip' in mapped) {
      counts.skipped++
      if (mapped) {
        const reasons = (counts.skipReasons ??= {})
        reasons[mapped.skip] = (reasons[mapped.skip] ?? 0) + 1
        if (mapped.legacyId === undefined) counts.skippedUnidentified = (counts.skippedUnidentified ?? 0) + 1
        else if (mapped.keep) seen.add(mapped.legacyId)
      } else counts.skippedUnidentified = (counts.skippedUnidentified ?? 0) + 1
      return
    }
    legacyId = mapped.legacyId
    if (!Number.isInteger(legacyId)) throw new Error(`legacyId must be an integer, got ${legacyId}`)
    seen.add(legacyId)

    const { collection } = importer
    const scope = importer.tenantScope ?? { path: tenantField, set: true }
    const matchField = importer.matchBy?.field ?? 'legacyId'
    const matchValue = importer.matchBy ? mapped.data[matchField] : legacyId
    if (importer.matchBy && (matchValue === undefined || matchValue === null || matchValue === '')) {
      throw new Error(`${matchField} is required to match existing documents`)
    }
    const existing = await ctx.payload.find({
      collection,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      where: {
        and: [{ [matchField]: { equals: matchValue } }, { [scope.path]: { equals: ctx.tenant } }],
      },
    })
    const found =
      existing.docs[0] ?? (importer.findExisting ? await importer.findExisting({ ctx, data: mapped.data, legacyId }) : undefined)
    // Runner-owned fields win over whatever the mapper returned.
    const data = {
      ...mapped.data,
      ...(importer.matchBy ? {} : { legacyId }),
      ...(scope.set ? { [tenantField]: ctx.tenant } : {}),
    }

    if (found && importer.matchBy) {
      counts.skipped++
      const reasons = (counts.skipReasons ??= {})
      reasons['already-imported'] = (reasons['already-imported'] ?? 0) + 1
    } else if (found) {
      const refresh = ctx.refreshCredentials ? refreshedFields(found, mapped.refreshWhileSet) : {}
      if (Object.keys(refresh).length) counts.refreshed = (counts.refreshed ?? 0) + 1
      if (!ctx.dryRun) {
        await ctx.payload.update({
          collection,
          ...(mapped.updateContext ? { context: mapped.updateContext } : {}),
          data: { ...data, ...refresh },
          id: found.id,
          overrideAccess: true,
        })
      }
      counts.updated++
    } else {
      if (!ctx.dryRun) {
        const created = { ...data, ...mapped.createOnly }
        if (mapped.rawCreate) {
          if (!ctx.payload.db) throw new Error('rawCreate needs payload.db')
          await ctx.payload.db.create({ collection, data: wrapLocalizedFields(ctx.payload, collection, created) })
        } else {
          await ctx.payload.create({
            collection,
            ...(mapped.createContext ? { context: mapped.createContext } : {}),
            data: created,
            overrideAccess: true,
          })
        }
      }
      counts.created++
    }
  } catch (error) {
    counts.failed++
    errors.push({ importer: importer.name, legacyId, message: messageOf(error) })
  }
}
