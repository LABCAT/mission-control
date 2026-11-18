// mission-control: WordPress import CLI (PJ-60). Run with `pnpm wp-import <entity> --tenant <slug>`.
import { registry, runCli } from '@mission-control/payload-wp-import'
import { getPayload } from 'payload'

import config from './payload.config'

// `payload run <script> [args]` keeps the arguments after the script path.
const argv = process.argv.slice(process.argv.findIndex((arg) => /wp-import\.ts$/.test(arg)) + 1)

const payload = await getPayload({ config })
let code = 1
try {
  code = await runCli({ argv, payload: payload as never, registry })
} finally {
  await payload.destroy()
}
process.exit(code)
