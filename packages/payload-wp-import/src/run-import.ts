import { MysqlReader } from './mysql-reader'
import type {
  ImportContext,
  ImportCounts,
  ImportFailure,
  ImportPayload,
  ImporterResult,
  Importer,
  ImportSummary,
} from './types'

export type RunImportOptions = {
  dryRun?: boolean
  importers: Importer[]
  payload: ImportPayload
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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Run importers in dependency order. Documents are matched by `legacyId` + tenant, so a
 * re-run updates instead of duplicating. Row errors are collected, not thrown. With
 * `dryRun` nothing is written, and counts show what a real run would do.
 */
export const runImport = async (options: RunImportOptions): Promise<ImportSummary> => {
  const { payload, tenant, tenantField = 'tenant' } = options
  const dryRun = options.dryRun ?? false
  const ordered = sortImporters(options.importers)
  const ctx: ImportContext = { dryRun, payload, tenant }
  const summary: ImportSummary = {
    dryRun,
    errors: [],
    importers: {},
    order: ordered.map((importer) => importer.name),
  }

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
        for await (const row of importer.read(reader)) {
          await importRow(importer, row, ctx, tenantField, result, summary.errors)
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

const importRow = async (
  importer: Importer,
  row: unknown,
  ctx: ImportContext,
  tenantField: string,
  counts: ImportCounts,
  errors: ImportFailure[],
): Promise<void> => {
  let legacyId: number | undefined
  try {
    const mapped = await importer.map(row, ctx)
    if (!mapped) {
      counts.skipped++
      return
    }
    legacyId = mapped.legacyId
    if (!Number.isInteger(legacyId)) throw new Error(`legacyId must be an integer, got ${legacyId}`)

    const { collection } = importer
    const existing = await ctx.payload.find({
      collection,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      where: {
        and: [{ legacyId: { equals: legacyId } }, { [tenantField]: { equals: ctx.tenant } }],
      },
    })
    const found = existing.docs[0]
    // Runner-owned fields win over whatever the mapper returned.
    const data = { ...mapped.data, legacyId, [tenantField]: ctx.tenant }

    if (found) {
      if (!ctx.dryRun) {
        await ctx.payload.update({ collection, data, id: found.id, overrideAccess: true })
      }
      counts.updated++
    } else {
      if (!ctx.dryRun) await ctx.payload.create({ collection, data, overrideAccess: true })
      counts.created++
    }
  } catch (error) {
    counts.failed++
    errors.push({ importer: importer.name, legacyId, message: messageOf(error) })
  }
}
