import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
  checkTarget,
  collectUrls,
  extractTitle,
  hasFailure,
  isFailure,
  parseRedirectMap,
  summarize,
  toCsv,
  toPath,
  type Check,
  type Fetched,
  type RedirectMap,
} from './lib.ts'

const USER_AGENT = 'url-parity-check'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const USAGE = `Usage: node --experimental-strip-types tools/url-parity/src/cli.ts \\
  --sitemap <legacy sitemap url> --target <new site base url> \\
  [--map redirects.json] [--out report.csv] [--concurrency 4] [--delay 250] [--strict] [--allow-unverifiable]`

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

async function getOnce(url: string): Promise<Fetched> {
  const res = await request(url, 'GET', 'manual')
  const body = res.status === 200 ? await res.text() : ''
  if (res.status !== 200) await res.body?.cancel()
  return { status: res.status, location: res.headers.get('location') ?? '', body }
}

async function checkPath(
  path: string,
  legacyUrl: string,
  target: string,
  map: RedirectMap,
  delay: number,
): Promise<Check> {
  const expected = map.get(path)
  let check: Check
  try {
    check = await checkTarget(path, target, expected, {
      get: async (url) => {
        const r = await getOnce(url)
        if (delay > 0) await sleep(delay)
        return r
      },
      legacyTitle: async () => {
        try {
          const r = await getOnce(legacyUrl)
          return r.status === 200 ? extractTitle(r.body) : null
        } catch {
          return null
        }
      },
    })
  } catch {
    check = { path, status: 0, location: '', expected: expected ?? '', result: 'other', finalStatus: '' }
  }
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
      'allow-unverifiable': { type: 'boolean', default: false },
    },
  })
  if (!values.sitemap || !values.target) {
    console.error(USAGE)
    return 2
  }
  const concurrency = Math.max(1, Number(values.concurrency) || 4)
  const delay = Math.max(0, Number(values.delay) || 0)
  const map = values.map ? parseRedirectMap(await readFile(values.map, 'utf8')) : new Map()

  const entries = new Map<string, string>() // path -> first legacy URL
  for (const url of await collectUrls(values.sitemap, fetchText)) {
    if (!entries.has(toPath(url))) entries.set(toPath(url), url)
  }
  const paths = [...entries.keys()]
  console.log(`Checking ${paths.length} legacy paths against ${values.target} (concurrency ${concurrency})`)

  const checks: Check[] = Array.from({ length: paths.length })
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
      while (next < paths.length) {
        const i = next++
        checks[i] = await checkPath(paths[i]!, entries.get(paths[i]!)!, values.target!, map, delay)
      }
    }),
  )

  await writeFile(values.out!, toCsv(checks))
  const counts = summarize(checks)
  console.table(counts)
  for (const c of checks.filter((x) => isFailure(x.result) || x.result === 'redirect-unmapped')) {
    console.log(`${c.result}\t${c.status}\t${c.path}${c.location ? ` -> ${c.location}` : ''}`)
  }
  console.log(`Report: ${values.out}`)
  const failed = hasFailure(checks, { allowUnverifiable: values['allow-unverifiable'], strict: values.strict })
  return failed ? 1 : 0
}

process.exitCode = await main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  return 2
})
