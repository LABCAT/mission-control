/**
 * The server Lighthouse CI audits (PJ-44): the built Worker under `astro preview`, with the
 * fixture CMS beside it so `/` and `/jobs/{slug}` render real CMS content instead of the static
 * shell and a 404. `lhci` starts this and stops it with the run.
 *
 * `astro preview` reads `.dev.vars` from the build output, so the two fixture values are written
 * there (git-ignored, no secret: the fixture CMS accepts any key).
 */
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const cmsPort = 4399
const cms = spawn(process.execPath, ['scripts/lighthouse-cms.mjs', String(cmsPort)], { stdio: 'inherit' })

writeFileSync('dist/server/.dev.vars', `CMS_URL=http://127.0.0.1:${cmsPort}\nSITE_KEY=lighthouse-fixture\n`)

// `astro preview` detaches a daemon and exits, so this process stays up to own the fixture and
// stops the daemon when `lhci` ends the run.
const preview = spawn('pnpm', ['exec', 'astro', 'preview', '--port', '4321', '--host', '127.0.0.1'], {
  stdio: 'inherit',
})
preview.on('error', () => process.exit(1))

const stop = () => {
  cms.kill()
  spawnSync('pnpm', ['exec', 'astro', 'preview', 'stop'], { stdio: 'ignore' })
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
