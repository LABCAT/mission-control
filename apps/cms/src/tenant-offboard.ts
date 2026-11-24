// mission-control: tenant offboarding CLI (PJ-93). Run with
// `pnpm --filter cms offboard --tenant <slug|id> [--dry-run] [--export <file>] [--keep <slug>]`.
import { writeFile } from 'node:fs/promises'

import {
  deleteOffboardedTenant,
  exportTenantData,
  formatOffboardingReport,
  offboardingStoppedMessage,
  offboardTenant,
  parseOffboardingArgs,
} from '@mission-control/payload-jobs'
import { getPayload } from 'payload'

import config from './payload.config'

// `payload run <script> [args]` keeps the arguments after the script path.
const scriptIndex = process.argv.findIndex((arg) => /tenant-offboard\.ts$/.test(arg))
const argv = process.argv.slice(scriptIndex === -1 ? 2 : scriptIndex + 1)

const payload = await getPayload({ config })
let code = 1

try {
  const args = parseOffboardingArgs(argv)

  // Accept a slug or a numeric id; a slug is what the operator reads in the admin.
  const { docs } = await payload.find({
    collection: 'tenants',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: /^\d+$/.test(args.tenant ?? '')
      ? { id: { equals: Number(args.tenant) } }
      : { slug: { equals: args.tenant } },
  })
  const tenant = docs[0]
  if (!tenant) throw new Error(`No tenant "${args.tenant}".`)

  if (args.exportPath) {
    const exported = await exportTenantData({ payload, tenant: tenant.id })
    await writeFile(args.exportPath, JSON.stringify({ tenant: tenant.id, exported }, null, 2))
    console.log(`Exported ${exported.length} collections to ${args.exportPath}`)
  }

  // A CLI run has no request user, so the operator names themselves; the audit log (S-122) is
  // the record of who offboarded which site, with counts only and no personal data.
  const operator = process.env.OFFBOARD_OPERATOR ?? 'cli'

  const result = await offboardTenant({
    actor: operator,
    dryRun: args.dryRun,
    keep: args.keep,
    payload,
    tenant: tenant.id,
  })
  for (const line of formatOffboardingReport(result)) console.log(line)

  if (result.errors.length > 0) {
    console.error(offboardingStoppedMessage(result))
  } else if (args.deleteTenant) {
    // No purge context: the accounting guards must still refuse if a row slipped through.
    await deleteOffboardedTenant({ actor: operator, payload, tenant: tenant.id })
    console.log(`Tenant ${args.tenant} deleted. Its users keep their accounts.`)
  } else if (!args.dryRun) {
    console.log(`Tenant ${args.tenant} is offboarded. Re-run with --delete-tenant to remove it.`)
  }

  code = result.errors.length > 0 ? 1 : 0
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
} finally {
  await payload.destroy()
}

process.exit(code)
