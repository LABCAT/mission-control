#!/usr/bin/env node
/**
 * The legacy paths the crawl found, as one list for the redirect table (PJ-42).
 *
 * `docs/Checkpoints/2026-11-08-VanuaTwok-Public-Crawl.md` is the crawl of the live WordPress site:
 * one line per URL, with the URL between `—` separators. This reads those lines, keeps the path
 * (and query, when the line has one), and writes `apps/vwok/src/legacy-crawl.json`.
 *
 * Regenerate after a new crawl:
 *   node scripts/legacy-paths.mjs
 *
 * The CV URLs the checkpoint redacted are skipped by design: a seeker's CV path is personal data
 * (PJ-89), and the rule that answers `/resumes/*` covers them without listing one.
 */
import { readFile, writeFile } from 'node:fs/promises'

export const CRAWL_DOC = 'docs/Checkpoints/2026-11-08-VanuaTwok-Public-Crawl.md'
export const CRAWL_JSON = 'apps/vwok/src/legacy-crawl.json'
export const ORIGIN = 'https://vanuatuwok.vu'

const REDACTED = /redacted|<|>/i

/**
 * Every legacy path in the crawl document, deduplicated and sorted. Only URLs on the site's own
 * origin count; a link to another site is not this site's legacy URL.
 */
export const legacyPaths = (markdown) => {
  const found = new Set()

  for (const line of markdown.split('\n')) {
    // The URL runs to the next space; only a trailing `.,;` or the em-dash separator is punctuation.
    for (const match of line.matchAll(/https:\/\/vanuatuwok\.vu\S*/g)) {
      const path = match[0].slice(ORIGIN.length).replace(/[.,;]+$/, '')
      if (!path || REDACTED.test(path)) continue
      found.add(path.startsWith('/') ? path : `/${path}`)
    }
  }

  return [...found].sort()
}

const main = async () => {
  const markdown = await readFile(new URL(`../${CRAWL_DOC}`, import.meta.url), 'utf8')
  const paths = legacyPaths(markdown)
  await writeFile(
    new URL(`../${CRAWL_JSON}`, import.meta.url),
    `${JSON.stringify({ crawledAt: '2026-11-08', origin: ORIGIN, paths }, null, 2)}\n`,
  )
  console.log(`${paths.length} legacy paths -> ${CRAWL_JSON}`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
