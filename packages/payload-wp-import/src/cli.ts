import { MysqlReader } from './mysql-reader'
import { runImport } from './run-import'
import type { ImportPayload, Importer, ImportSummary } from './types'

export const USAGE =
  'Usage: pnpm wp-import <entity|all> --tenant <slug> [--dry-run] [--limit N]\n' +
  '       pnpm wp-import sync --tenant <slug> [--apply] [--prune]   (dry run unless --apply)'

export type CliArgs = {
  /** `sync` only: write for real. */
  apply: boolean
  dryRun: boolean
  entity: string
  limit?: number
  /** `sync` only: also delete imported documents that left the source. */
  prune: boolean
  tenant: string
}

/** Parse `<entity> --tenant <slug> [--dry-run] [--limit N]`. Throws with a usage hint on bad input. */
export const parseArgs = (argv: string[]): CliArgs => {
  let tenant: string | undefined
  let limit: number | undefined
  let dryRun = false
  let apply = false
  let prune = false
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s) : [arg, undefined]
    const value = () => {
      const next = inline ?? argv[++i]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
      return next
    }

    if (flag === '--tenant') tenant = value()
    else if (flag === '--limit') {
      const raw = value()
      limit = Number(raw)
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got "${raw}"`)
    } else if (flag === '--dry-run') dryRun = true
    else if (flag === '--apply') apply = true
    else if (flag === '--prune') prune = true
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${flag}`)
    else positional.push(arg)
  }

  if (positional.length !== 1) throw new Error('Give exactly one entity (or "all")')
  if (!tenant) throw new Error('--tenant <slug> is required')
  const entity = positional[0]!
  if (entity !== 'sync' && (apply || prune)) throw new Error('--apply and --prune are only for sync')
  if (entity === 'sync') {
    if (apply && dryRun) throw new Error('--apply and --dry-run contradict each other')
    if (limit) throw new Error('--limit cannot be used with sync: a partial read must never drive deletions')
    dryRun = !apply
  }
  return { apply, dryRun, entity, limit, prune, tenant }
}

/** Check the registry as a whole: names match keys and every dependency is registered. */
export const validateRegistry = (registry: Record<string, Importer>): void => {
  for (const [key, importer] of Object.entries(registry)) {
    if (importer.name !== key) {
      throw new Error(`Registry key "${key}" does not match importer name "${importer.name}"`)
    }
    for (const dependency of importer.dependsOn) {
      if (!registry[dependency]) {
        throw new Error(`Importer "${key}" depends on "${dependency}", which is not registered`)
      }
    }
  }
}

/** The importers to run: all of them, or the named one plus everything it depends on. */
export const selectImporters = (registry: Record<string, Importer>, entity: string): Importer[] => {
  validateRegistry(registry)
  const known = Object.keys(registry)
  if (known.length === 0) throw new Error('No importers are registered yet, so there is nothing to run')
  if (entity === 'all' || entity === 'sync') return Object.values(registry)

  if (!registry[entity]) {
    throw new Error(`Unknown entity "${entity}". Available: ${known.join(', ')}, all, sync`)
  }

  const selected = new Map<string, Importer>()
  const add = (importer: Importer) => {
    if (selected.has(importer.name)) return
    selected.set(importer.name, importer)
    for (const name of importer.dependsOn) add(registry[name]!)
  }
  add(registry[entity])
  return [...selected.values()]
}

const withLimit = (importer: Importer, limit?: number): Importer => {
  if (!limit) return importer
  return {
    ...importer,
    read: async function* (reader) {
      let count = 0
      for await (const row of importer.read(reader)) {
        yield row
        // Stop here, before asking the reader for another row.
        if (++count >= limit) return
      }
    },
  }
}

export const resolveTenant = async (
  payload: ImportPayload,
  slug: string,
  tenantsSlug = 'tenants',
): Promise<number | string> => {
  const found = await payload.find({
    collection: tenantsSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { slug: { equals: slug } },
  })
  const tenant = found.docs[0]
  if (!tenant) throw new Error(`Unknown tenant "${slug}"`)
  return tenant.id
}

export const formatSummary = (summary: ImportSummary): string => {
  const lines = [summary.dryRun ? 'Dry run: nothing was written.' : 'Import finished.']
  for (const name of summary.order) {
    const r = summary.importers[name]
    if (!r) continue
    lines.push(
      `  ${name}: created ${r.created}, updated ${r.updated}, skipped ${r.skipped}, failed ${r.failed}` +
        (r.aborted ? ` (aborted: ${r.aborted})` : ''),
    )
    for (const [label, counts] of [['skipped', r.skipReasons], ['report', r.report]] as const) {
      for (const [key, count] of Object.entries(counts ?? {})) lines.push(`    ${label} ${key}: ${count}`)
    }
  }
  for (const [name, result] of Object.entries(summary.importers)) {
    if (result.refreshed) lines.push(`  ${name}: refreshed credentials for ${result.refreshed}`)
    if (result.pruneRefused) lines.push(`  ${name}: deletions refused, ${result.pruneRefused}`)
  }
  if (summary.deletions.length) {
    lines.push(`${summary.dryRun ? 'Would delete' : 'Deleted'} (${summary.deletions.length}):`)
    for (const d of summary.deletions.slice(0, 50)) {
      lines.push(`  ${d.collection} legacyId ${d.legacyId} (id ${d.id})${d.applied || summary.dryRun ? '' : ' - FAILED'}`)
    }
    if (summary.deletions.length > 50) lines.push(`  …and ${summary.deletions.length - 50} more`)
  }
  if (summary.errors.length) {
    lines.push(`Errors (${summary.errors.length}):`)
    for (const error of summary.errors.slice(0, 20)) {
      lines.push(`  ${error.importer}${error.legacyId === undefined ? '' : ` #${error.legacyId}`}: ${error.message}`)
    }
    if (summary.errors.length > 20) lines.push(`  …and ${summary.errors.length - 20} more`)
  }
  return lines.join('\n')
}

export type RunCliOptions = {
  argv: string[]
  log?: (line: string) => void
  payload: ImportPayload
  reader?: MysqlReader
  registry: Record<string, Importer>
  tenantsSlug?: string
}

/** Run the CLI. Returns the process exit code: 0 ok, 1 row/importer failures, 2 bad usage. */
export const runCli = async (options: RunCliOptions): Promise<number> => {
  const log = options.log ?? console.log
  try {
    const args = parseArgs(options.argv)
    const importers = selectImporters(options.registry, args.entity).map((importer) =>
      withLimit(importer, args.limit),
    )
    const tenant = await resolveTenant(options.payload, args.tenant, options.tenantsSlug)
    const sync = args.entity === 'sync'
    const summary = await runImport({
      dryRun: args.dryRun,
      importers,
      log: sync ? log : undefined,
      payload: options.payload,
      prune: sync && args.prune,
      refreshCredentials: sync,
      reader: options.reader,
      tenant,
    })
    log(formatSummary(summary))
    const failed = summary.errors.length > 0
    return failed ? 1 : 0
  } catch (error) {
    log(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    return 2
  }
}
