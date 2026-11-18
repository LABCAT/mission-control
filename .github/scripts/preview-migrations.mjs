#!/usr/bin/env node
// Decides whether a kept preview database has to be reset before migrating (PJ-90).
//
// A preview's Neon branch is kept across pushes. If a PR re-creates one of its migrations
// (new timestamp, same schema change), the preview DB still has the OLD name applied, and
// `payload migrate` then fails on a column or table that already exists.
//
//   preview-migrations.mjs decide <applied.txt> <branch-migrations-dir> [<main-names.txt>]
//       applied.txt        names from the preview DB's payload_migrations table, one per line
//       branch dir         apps/cms/src/migrations of the code being previewed
//       main-names.txt     migration names on origin/main (what prod has), one per line
//   Prints `keep`, or `reset` followed by the unknown names on stderr. Exit 2 on bad input.
//
// An applied name is unknown if neither the PR branch nor main has it. Names from main are
// fine: a preview cut from prod has them, and a PR that is behind main must not reset on every push.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Payload records a `dev` row when schema push was used. It is not a migration.
const IGNORED = new Set(['dev'])

export function migrationNamesIn(files) {
  return files
    .filter((f) => /\.ts$/.test(f) && f !== 'index.ts')
    .map((f) => f.replace(/\.ts$/, ''))
}

export function unknownApplied({ applied, branch, main = [] }) {
  const known = new Set([...branch, ...main])
  return applied.filter((n) => !IGNORED.has(n) && !known.has(n))
}

const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean)

function main(argv) {
  const [cmd, appliedFile, dir, mainFile] = argv
  if (cmd !== 'decide' || !appliedFile || !dir) throw new Error('usage: decide <applied.txt> <migrations-dir> [main-names.txt]')
  const branch = migrationNamesIn(readdirSync(dir))
  // An empty branch list means the wrong directory; resetting on that basis would be wrong.
  if (branch.length === 0) throw new Error(`No migrations found in ${dir}`)
  const unknown = unknownApplied({
    applied: lines(readFileSync(appliedFile, 'utf8')),
    branch,
    main: mainFile ? lines(readFileSync(mainFile, 'utf8')) : [],
  })
  if (unknown.length) {
    console.error(`Applied in the preview DB but not in this branch or main:\n${unknown.map((n) => `  - ${n}`).join('\n')}`)
    console.log('reset')
  } else {
    console.log('keep')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`preview-migrations: ${e.message}`)
    process.exit(2)
  }
}
