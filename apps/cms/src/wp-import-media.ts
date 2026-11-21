// mission-control: WordPress media import CLI (PJ-63). Run with
// `pnpm wp-import-media --tenant <slug> --source <uploads-dir> --target-dir <dir> [--dry-run]`.
import {
  MEDIA_USAGE,
  directorySource,
  directoryTarget,
  formatMediaReport,
  parseMediaArgs,
  r2Target,
  resolveTenant,
  runMediaImport,
  type R2BucketLike,
} from '@mission-control/payload-wp-import'
import { getPayload } from 'payload'

import config from './payload.config'

const argv = process.argv.slice(process.argv.findIndex((arg) => /wp-import-media\.ts$/.test(arg)) + 1)

let code = 1
try {
  const args = parseMediaArgs(argv)

  // Never the real bucket: `--r2-local` is wrangler's local emulation (binding MEDIA, state in
  // .wrangler). Copying into production R2 is a founder-run step, not something this script does.
  let dispose: (() => Promise<void>) | undefined
  let target
  if (args.targetDir) {
    target = directoryTarget(args.targetDir)
  } else {
    const { getPlatformProxy } = await import('wrangler')
    const proxy = await getPlatformProxy<{ MEDIA: R2BucketLike }>({ configPath: './wrangler.jsonc' })
    dispose = proxy.dispose
    target = r2Target(proxy.env.MEDIA)
  }

  const payload = await getPayload({ config })
  try {
    const tenant = await resolveTenant(payload as never, args.tenant)
    const { MysqlReader } = await import('@mission-control/payload-wp-import')
    const reader = new MysqlReader()
    try {
      const report = await runMediaImport({
        dryRun: args.dryRun,
        payload: payload as never,
        reader,
        source: directorySource(args.source),
        target,
        tenant,
        verify: args.verify,
      })
      console.log(formatMediaReport(report))
      code = report.failures.length > 0 ? 1 : 0
    } finally {
      await reader.close()
    }
  } finally {
    await payload.destroy()
    await dispose?.()
  }
} catch (error) {
  console.log(`${error instanceof Error ? error.message : String(error)}\n${MEDIA_USAGE}`)
  code = 2
}
process.exit(code)
