import type { TenantOffboardingResult } from './tenant-offboarding'

/**
 * The operator's offboarding command (PJ-93): `pnpm --filter cms offboard --tenant <slug> [flags]`.
 * Parsing and formatting live here so they are testable without a database; the host script
 * (`apps/cms/src/tenant-offboard.ts`) does the I/O: find the tenant, write the export, call
 * `offboardTenant`, and delete the tenant row when asked.
 */

export type TenantOffboardingArgs = {
  /** Delete the tenant row too, once its data is gone. Off by default. */
  deleteTenant: boolean
  /** Count only: report what a real run would remove. */
  dryRun: boolean
  /** Write the tenant's documents here as JSON, before anything is deleted. */
  exportPath: null | string
  /** More collections to keep, e.g. `xero-invoices`. Repeatable. */
  keep: string[]
  /** The tenant's slug (or numeric id). */
  tenant: null | string
}

export const OFFBOARDING_USAGE = [
  'Usage: offboard --tenant <slug|id> [--dry-run] [--export <file>] [--keep <collection>] [--delete-tenant]',
  '',
  '  --tenant <slug|id>   The tenant to offboard (required).',
  '  --dry-run            Report what would be removed; delete nothing.',
  '  --export <file>      Write the tenant’s documents to a JSON file first.',
  '  --keep <collection>  Keep a collection the operator names (repeatable).',
  '  --delete-tenant      Delete the tenant row after its data is gone.',
  '',
  'Orders and the credit ledger are always kept: they are the accounting history, so a tenant',
  'that has them cannot be offboarded. User accounts are never deleted; only their memberships',
  'of this tenant go, when the tenant row is deleted.',
].join('\n')

const VALUE_FLAGS = new Set(['--export', '--keep', '--tenant'])
const BOOLEAN_FLAGS = new Set(['--delete-tenant', '--dry-run'])

/** Parse the CLI arguments, or throw an `Error` carrying `OFFBOARDING_USAGE`. */
export const parseOffboardingArgs = (argv: readonly string[]): TenantOffboardingArgs => {
  const parsed: TenantOffboardingArgs = {
    deleteTenant: false,
    dryRun: false,
    exportPath: null,
    keep: [],
    tenant: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') throw new Error(OFFBOARDING_USAGE)
    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--dry-run') parsed.dryRun = true
      else parsed.deleteTenant = true
      continue
    }
    if (!VALUE_FLAGS.has(arg)) throw new Error(`Unknown argument "${arg}".\n\n${OFFBOARDING_USAGE}`)

    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} needs a value.\n\n${OFFBOARDING_USAGE}`)
    }
    index += 1

    if (arg === '--tenant') parsed.tenant = value
    else if (arg === '--export') parsed.exportPath = value
    else parsed.keep.push(value)
  }

  if (!parsed.tenant) throw new Error(`--tenant is required.\n\n${OFFBOARDING_USAGE}`)
  if (parsed.deleteTenant && parsed.dryRun) {
    throw new Error('--delete-tenant and --dry-run contradict each other. Pick one.')
  }

  return parsed
}

const listed = (entries: { docs: number; slug: string }[]): string =>
  entries.map(({ docs, slug }) => `${docs} ${slug}`).join(', ')

/** A short, line-per-fact summary an operator can read before deciding to delete the tenant. */
export const formatOffboardingReport = (result: TenantOffboardingResult): string[] => {
  const lines = [`Tenant ${result.tenant}:`]

  lines.push(
    result.removed.length > 0
      ? `  removed (or would remove): ${listed(result.removed)}`
      : '  removed (or would remove): nothing',
  )
  if (result.anonymisedUsers.length > 0) {
    lines.push(
      `  users anonymised (or would be), members of this site only: ${result.anonymisedUsers.length}`,
    )
  }
  lines.push(result.kept.length > 0 ? `  kept: ${listed(result.kept)}` : '  kept: nothing')

  for (const error of result.errors) lines.push(`  refused: ${error.slug}: ${error.message}`)

  return lines
}

/**
 * What to tell the operator when a run reported errors: only claim nothing was deleted when
 * nothing was, since offboarding carries on past a refused collection.
 */
export const offboardingStoppedMessage = (result: TenantOffboardingResult): string =>
  result.removed.length > 0
    ? `Offboarding stopped part-way. Already removed: ${listed(result.removed)}. The collections marked "refused" above were left as they were.`
    : 'Offboarding stopped. Nothing was deleted.'
