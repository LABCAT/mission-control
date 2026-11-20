#!/usr/bin/env node
/**
 * Features catalogue report.
 *
 * Reads docs/features/catalogue.yaml and the JSON reporter output from Vitest, matches test
 * titles tagged `@S-NNN` to stories, and prints a markdown summary (or a CSV export for YCV).
 *
 * Exits non-zero when an MVP story marked `built` has no matching test, so a feature can't be
 * declared built without evidence.
 *
 * Usage:
 *   node scripts/features/report.mjs
 *   node scripts/features/report.mjs --results test-results.json
 *   node scripts/features/report.mjs --csv features.csv
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parse as parseYaml } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const DEFAULT_CATALOGUE = resolve(REPO_ROOT, 'docs/features/catalogue.yaml')

export const ROLES = ['seeker', 'employer', 'org owner', 'site manager', 'super admin']
export const STATUSES = ['planned', 'built']
export const AUTOMATED_RESULTS = ['pass', 'fail', 'untested']
export const CSV_COLUMNS = [
  'ID',
  'area',
  'role',
  'story',
  'steps',
  'expected',
  'automated result',
  'manual result',
  'notes',
]

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0

const fail = (message) => {
  throw new Error(message)
}

/**
 * Parse and validate the catalogue.
 * @param {string} text YAML source
 * @returns {{ meta: Record<string, unknown>, stories: Array<Record<string, unknown>> }}
 */
export const parseCatalogue = (text) => {
  const document = parseYaml(text)
  if (!document || typeof document !== 'object') fail('catalogue: expected a YAML object')

  const stories = document.stories
  if (!Array.isArray(stories) || stories.length === 0) {
    fail('catalogue: `stories` must be a non-empty list')
  }

  const seen = new Set()
  const normalized = stories.map((story, index) => {
    const where = `stories[${index}]`
    if (!story || typeof story !== 'object') fail(`${where}: expected an object`)

    if (!isNonEmptyString(story.id) || !/^S-\d{3,}$/.test(story.id)) {
      fail(`${where}: id must look like S-001`)
    }
    if (seen.has(story.id)) fail(`${where}: duplicate id ${story.id}`)
    seen.add(story.id)

    if (!isNonEmptyString(story.area)) fail(`${where} (${story.id}): area is required`)
    if (!ROLES.includes(story.role)) {
      fail(`${where} (${story.id}): role must be one of ${ROLES.join(', ')}`)
    }
    if (!isNonEmptyString(story.story)) fail(`${where} (${story.id}): story is required`)
    if (!Array.isArray(story.steps) || !story.steps.every(isNonEmptyString)) {
      fail(`${where} (${story.id}): steps must be a list of non-empty strings`)
    }
    if (!isNonEmptyString(story.expected)) fail(`${where} (${story.id}): expected is required`)
    if (!Array.isArray(story.settings) || !story.settings.every(isNonEmptyString)) {
      fail(`${where} (${story.id}): settings must be a list of strings`)
    }
    if (typeof story.mvp !== 'boolean') fail(`${where} (${story.id}): mvp must be true or false`)
    if (!STATUSES.includes(story.status)) {
      fail(`${where} (${story.id}): status must be one of ${STATUSES.join(', ')}`)
    }
    if (!Array.isArray(story.tests) || !story.tests.every(isNonEmptyString)) {
      fail(`${where} (${story.id}): tests must be a list of strings`)
    }
    if (story.manual !== undefined && typeof story.manual !== 'string') {
      fail(`${where} (${story.id}): manual must be a string when present`)
    }
    if (story.notes !== undefined && typeof story.notes !== 'string') {
      fail(`${where} (${story.id}): notes must be a string when present`)
    }

    return {
      ...story,
      settings: story.settings,
      tests: story.tests,
      manual: story.manual ?? '',
      notes: story.notes ?? '',
    }
  })

  return { meta: document.meta ?? {}, stories: normalized }
}

/**
 * Parse Vitest's JSON reporter output. Accepts the reporter's default shape and a few older
 * variants, and returns one flat list of test titles and statuses.
 * @param {string} text
 * @returns {Array<{ title: string, status: string }>}
 */
export const parseResults = (text) => {
  const document = JSON.parse(text)
  const tests = []

  const push = (test) => {
    if (!test || typeof test !== 'object') return
    const title =
      typeof test.fullName === 'string'
        ? test.fullName
        : [...(Array.isArray(test.ancestorTitles) ? test.ancestorTitles : []), test.title ?? '']
            .filter(Boolean)
            .join(' ')
    if (!isNonEmptyString(title)) return
    tests.push({ title, status: typeof test.status === 'string' ? test.status : 'unknown' })
  }

  if (Array.isArray(document.testResults)) {
    for (const file of document.testResults) {
      if (Array.isArray(file?.assertionResults)) file.assertionResults.forEach(push)
      if (Array.isArray(file?.tests)) file.tests.forEach(push)
    }
  }
  if (Array.isArray(document.tests)) document.tests.forEach(push)
  if (Array.isArray(document.testResults) && document.testResults.length === 0) return []

  return tests
}

/**
 * Find story tags in a test title.
 * @param {string} title
 * @returns {string[]}
 */
export const tagsIn = (title) => {
  const matches = String(title).match(/@S-\d{3,}/g) ?? []
  return [...new Set(matches.map((tag) => tag.toUpperCase()))]
}

/**
 * Turn the tests for one story into one of pass, fail or untested.
 * @param {string[]} statuses
 * @returns {'pass' | 'fail' | 'untested'}
 */
export const automatedResult = (statuses) => {
  if (statuses.length === 0) return 'untested'
  if (statuses.some((status) => status === 'failed')) return 'fail'
  if (statuses.some((status) => status === 'passed')) return 'pass'
  return 'untested'
}

/**
 * Match test titles to stories and enrich each story with its automated result.
 * @param {Array<Record<string, unknown>>} stories
 * @param {Array<{ title: string, status: string }>} tests
 */
export const buildReport = (stories, tests) => {
  const byId = new Map(stories.map((story) => [story.id, { ...story, statuses: [], matched: [] }]))
  const unknownTags = new Set()

  for (const test of tests) {
    for (const tag of tagsIn(test.title)) {
      const story = byId.get(tag.slice(1))
      if (!story) {
        unknownTags.add(tag)
        continue
      }
      story.statuses.push(test.status)
      story.matched.push(test.title)
    }
  }

  const enriched = [...byId.values()].map((story) => ({
    ...story,
    automated: automatedResult(story.statuses),
  }))

  return {
    stories: enriched,
    unknownTags: [...unknownTags].toSorted(),
    failures: enriched.filter(
      (story) => story.mvp && story.status === 'built' && story.automated === 'untested',
    ),
  }
}

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

/**
 * Render the markdown summary.
 * @param {{ stories: Array<Record<string, any>>, unknownTags: string[], failures: Array<Record<string, any>> }} report
 * @param {{ resultsFound?: boolean }} [options]
 * @returns {string}
 */
export const renderMarkdown = (report, options = {}) => {
  const { resultsFound = true } = options
  const stories = report.stories
  const count = (predicate) => stories.filter(predicate).length
  const lines = []

  lines.push('# Features catalogue report')
  lines.push('')
  if (!resultsFound) {
    lines.push('> No Vitest results file was found, so every story is reported as untested.')
    lines.push('')
  }
  lines.push(
    `**${stories.length} stories** · ${count((story) => story.mvp)} MVP · ` +
      `${count((story) => story.status === 'built')} built · ` +
      `${count((story) => story.automated === 'pass')} pass · ` +
      `${count((story) => story.automated === 'fail')} fail · ` +
      `${count((story) => story.automated === 'untested')} untested`,
  )
  lines.push('')

  if (report.failures.length > 0) {
    lines.push('## MVP stories marked built with no test')
    lines.push('')
    for (const story of report.failures) {
      lines.push(`- **${story.id}** ${story.story}`)
    }
    lines.push('')
  }

  if (report.unknownTags.length > 0) {
    lines.push('## Test tags with no story')
    lines.push('')
    lines.push(report.unknownTags.map((tag) => `\`${tag}\``).join(', '))
    lines.push('')
  }

  lines.push('## Stories')
  lines.push('')
  lines.push('| ID | Area | Role | MVP | Status | Automated | Story |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const story of stories) {
    lines.push(
      `| ${story.id} | ${cell(story.area)} | ${cell(story.role)} | ` +
        `${story.mvp ? 'yes' : 'no'} | ${story.status} | ${story.automated} | ${cell(story.story)} |`,
    )
  }
  lines.push('')

  return lines.join('\n')
}

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`

/**
 * Render the YCV export. The manual result starts empty and is filled in on staging.
 * @param {Array<Record<string, any>>} stories
 * @returns {string}
 */
export const renderCsv = (stories) => {
  const rows = [CSV_COLUMNS.join(',')]
  for (const story of stories) {
    rows.push(
      [
        story.id,
        story.area,
        story.role,
        story.story,
        story.steps.join('; '),
        story.expected,
        story.automated,
        story.manual,
        story.notes,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return rows.join('\n')
}

const usage = `Usage: node scripts/features/report.mjs [options]

  --catalogue <path>  Catalogue YAML (default docs/features/catalogue.yaml)
  --results <path>    Vitest JSON reporter output (default test-results.json)
  --csv <path>        Also write the CSV export (use - for stdout)
  --help              Show this help`

/**
 * Parse the command line into options.
 * @param {string[]} argv
 */
export const parseArgs = (argv) => {
  const options = {
    catalogue: DEFAULT_CATALOGUE,
    csv: null,
    help: false,
    results: resolve(process.cwd(), 'test-results.json'),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help') {
      options.help = true
    } else if (arg === '--catalogue' || arg === '--results' || arg === '--csv') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail(`${arg} needs a path`)
      index += 1
      if (arg === '--catalogue') options.catalogue = resolve(process.cwd(), value)
      if (arg === '--results') options.results = resolve(process.cwd(), value)
      if (arg === '--csv') options.csv = value
    } else {
      fail(`Unknown option: ${arg}`)
    }
  }

  return options
}

/**
 * Run the report.
 * @param {string[]} [argv]
 * @returns {Promise<number>} exit code
 */
export const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage)
    return 0
  }

  const catalogue = parseCatalogue(await readFile(options.catalogue, 'utf8'))

  let tests = []
  let resultsFound = false
  try {
    tests = parseResults(await readFile(options.results, 'utf8'))
    resultsFound = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const report = buildReport(catalogue.stories, tests)

  if (options.csv === '-') {
    console.log(renderCsv(report.stories))
  } else {
    console.log(renderMarkdown(report, { resultsFound }))
    if (options.csv) {
      await writeFile(resolve(process.cwd(), options.csv), `${renderCsv(report.stories)}\n`, 'utf8')
      console.error(`Wrote ${options.csv}`)
    }
  }

  if (report.failures.length > 0) {
    console.error('')
    console.error('FAIL: these MVP stories are marked built but have no test:')
    for (const story of report.failures) console.error(`  ${story.id}  ${story.story}`)
    return 1
  }

  return 0
}

const isEntryPoint = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false

if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
