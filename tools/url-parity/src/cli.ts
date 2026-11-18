import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
  classify,
  collectUrls,
  isFailure,
  parseRedirectMap,
  summarize,
  toCsv,
  uniquePaths,
  type Check,
  type RedirectMap,
} from './lib.ts'

const USER_AGENT = 'url-parity-check'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const USAGE = `Usage: node --experimental-strip-types tools/url-parity/src/cli.ts \\
  --sitemap <legacy sitemap url> --target <new site base url> \\
  [--map redirects.json] [--out report.csv] [--concurrency 4] [--delay 250] [--strict]`

/** GET/HEAD with a UA, retrying on 429/503 (Cloudflare throttling) up to 3 times. */
async function request(url: string, method: 'GET' | 'HEAD', redirect: RequestRedirect): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, redirect, headers: { 'user-agent': USER_AGENT } })
    if ((res.status !== 429 && res.status !== 503) || attempt >= 3) return res
    const wait = Number(res.headers.get('retry-after'))
    await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : 1000 * 2 ** attempt)
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await request(url, 'GET', 'follow')
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.text()
}

async function checkPath(path: string, target: string, map: RedirectMap, delay: number): Promise<Check> {
  const expected = map.get(path)
  let check: Check
  try {
    const res = await request(new URL(path, target).href, 'HEAD', 'manual')
    const location = res.headers.get('location') ?? ''
    check = {
      path,
      status: res.status,
      location,
      expected: expected ?? '',
      result: classify(res.status, location, expected, target),
    }
  } catch {
    check = { path, status: 0, location: '', expected: expected ?? '', result: 'other' }
  }
  if (delay > 0) await sleep(delay)
  return check
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      sitemap: { type: 'string' },
      target: { type: 'string' },
      map: { type: 'string' },
      out: { type: 'string', default: 'url-parity-report.csv' },
      concurrency: { type: 'string', default: '4' },
      delay: { type: 'string', default: '250' },
      strict: { type: 'boolean', default: false },
    },
  })
  if (!values.sitemap || !values.target) {
    console.error(USAGE)
    return 2
  }
  const concurrency = Math.max(1, Number(values.concurrency) || 4)
  const delay = Math.max(0, Number(values.delay) || 0)
  const map = values.map ? parseRedirectMap(await readFile(values.map, 'utf8')) : new Map()

  const paths = uniquePaths(await collectUrls(values.sitemap, fetchText))
  console.log(`Checking ${paths.length} legacy paths against ${values.target} (concurrency ${concurrency})`)

  const checks: Check[] = Array.from({ length: paths.length })
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
      while (next < paths.length) {
        const i = next++
        checks[i] = await checkPath(paths[i]!, values.target!, map, delay)
      }
    }),
  )

  await writeFile(values.out!, toCsv(checks))
  const counts = summarize(checks)
  console.table(counts)
  for (const c of checks.filter((x) => isFailure(x.result))) {
    console.log(`${c.result}\t${c.status}\t${c.path}${c.location ? ` -> ${c.location}` : ''}`)
  }
  console.log(`Report: ${values.out}`)
  const failed = checks.some((x) => isFailure(x.result) || (values.strict && x.result !== 'ok' && x.result !== 'redirect-ok'))
  return failed ? 1 : 0
}

process.exitCode = await main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  return 2
})
