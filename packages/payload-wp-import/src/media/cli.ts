export const MEDIA_USAGE =
  'Usage: pnpm wp-import-media --tenant <slug> --source <uploads-dir> (--target-dir <dir> | --r2-local) [--dry-run] [--verify]'

export type MediaCliArgs = {
  dryRun: boolean
  /** Copy into the local R2 emulation of `wrangler dev` (binding `MEDIA`), never the real bucket. */
  r2Local: boolean
  source: string
  targetDir?: string
  tenant: string
  verify: boolean
}

/** Parse the `wp-import-media` arguments. Throws with a usage hint on bad input. */
export const parseMediaArgs = (argv: string[]): MediaCliArgs => {
  const args: Partial<MediaCliArgs> = { dryRun: false, r2Local: false, verify: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s) : [arg, undefined]
    const value = () => {
      const next = inline ?? argv[++i]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
      return next
    }
    if (flag === '--tenant') args.tenant = value()
    else if (flag === '--source') args.source = value()
    else if (flag === '--target-dir') args.targetDir = value()
    else if (flag === '--r2-local') args.r2Local = true
    else if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--verify') args.verify = true
    else throw new Error(`Unknown argument ${arg}`)
  }
  if (!args.tenant) throw new Error('--tenant <slug> is required')
  if (!args.source) throw new Error('--source <uploads-dir> is required')
  if (Boolean(args.targetDir) === args.r2Local) throw new Error('Give exactly one of --target-dir and --r2-local')
  return args as MediaCliArgs
}
