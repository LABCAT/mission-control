#!/usr/bin/env node
// Decides which Neon branches the Preview workflow may touch. It only reads JSON and
// prints names; it never calls Neon itself. The workflow does the deleting.
//
//   preview-neon.mjs stale <neon-branches.json> <open-prs.json>
//       Prints, one per line, the `preview/*` Neon branches with no open PR.
//   preview-neon.mjs live <git-branch> <open-prs.json>
//       Exits 0 if an open same-repo PR still uses that branch's preview name, 1 if not.
//   preview-neon.mjs valid <neon-branch>
//       Exits 0 only if the name is a well-formed `preview/<name>`; use it before any delete.
//   preview-neon.mjs capacity <neon-branches.json> <limit> <target-branch>
//       Exits 1 with a message listing `preview/*` branches if creating <target-branch>
//       would hit the project's branch limit.
//
// neon-branches.json: output of `neonctl branches list --output json`.
// open-prs.json:      output of `gh pr list --state open --json headRefName,isCrossRepository`.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A preview branch is `preview/` plus a DNS label of at most 40 characters, the shape
// preview-name.sh produces. Anything else, `main` included, is never ours to delete.
const PREVIEW_BRANCH = /^preview\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

// Mirrors .github/scripts/preview-name.sh (kind `branch`). A test keeps them in step.
export function previewName(gitBranch) {
  return gitBranch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

export function isPreviewBranch(name) {
  return typeof name === 'string' && PREVIEW_BRANCH.test(name)
}

// RC previews (preview/rc-*) are replaced by preview.yml and deleted by release.yml.
export function isRcPreview(name) {
  return isPreviewBranch(name) && name.startsWith('preview/rc-')
}

export function neonBranchNames(branches) {
  if (!Array.isArray(branches)) throw new Error('Neon branch list is not an array')
  return branches.map((b) => {
    if (!b || typeof b.name !== 'string') throw new Error('Neon branch without a name')
    return b
  })
}

// Neon branches the sweep may delete: strictly `preview/*`, not an RC preview, not
// flagged primary/default/protected, and not the preview of a branch with an open PR.
export function staleBranches(branches, openPrs) {
  const list = neonBranchNames(branches)
  // A truncated or wrong listing must never turn into mass deletion.
  if (!list.some((b) => b.name === 'main')) {
    throw new Error('Neon branch list has no `main`; refusing to treat it as complete')
  }
  if (!Array.isArray(openPrs)) throw new Error('Open PR list is not an array')
  const live = new Set(
    openPrs.filter((p) => p && p.isCrossRepository === false && typeof p.headRefName === 'string').map((p) => previewName(p.headRefName)),
  )
  return list
    .filter((b) => isPreviewBranch(b.name) && !isRcPreview(b.name))
    .filter((b) => !b.primary && !b.default && !b.protected)
    .filter((b) => !live.has(b.name.slice('preview/'.length)))
    .map((b) => b.name)
}

// True if an open same-repo PR maps to the same preview name as `gitBranch`, so the
// preview is still in use (e.g. feature/foo and feature-foo both give "feature-foo").
export function previewStillUsed(gitBranch, openPrs) {
  if (!Array.isArray(openPrs)) throw new Error('Open PR list is not an array')
  const name = previewName(gitBranch)
  return openPrs.some((p) => p && p.isCrossRepository === false && typeof p.headRefName === 'string' && previewName(p.headRefName) === name)
}

// Returns an error message when `target` is new and the project is at its limit.
export function capacityProblem(branches, limit, target) {
  const list = neonBranchNames(branches)
  if (list.some((b) => b.name === target) || list.length < limit) return null
  const previews = list.filter((b) => isPreviewBranch(b.name)).map((b) => `  - ${b.name}`)
  return [
    `Neon is at its branch limit (${list.length}/${limit}), so ${target} cannot be created.`,
    `Existing preview/* branches (${previews.length}):`,
    ...previews,
    'Run the Preview workflow manually (workflow_dispatch, dry_run=false) to delete previews of closed PRs, or delete branches in the Neon console.',
  ].join('\n')
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function main(argv) {
  const [cmd, ...args] = argv
  if (cmd === 'stale' && args.length === 2) {
    const out = staleBranches(readJson(args[0]), readJson(args[1]))
    if (out.length) console.log(out.join('\n'))
  } else if (cmd === 'live' && args.length === 2) {
    process.exit(previewStillUsed(args[0], readJson(args[1])) ? 0 : 1)
  } else if (cmd === 'valid' && args.length === 1) {
    if (!isPreviewBranch(args[0])) {
      console.error(`Refusing: "${args[0]}" is not a preview/<name> branch`)
      process.exit(1)
    }
  } else if (cmd === 'capacity' && args.length === 3) {
    const limit = Number(args[1])
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Bad limit: ${args[1]}`)
    const problem = capacityProblem(readJson(args[0]), limit, args[2])
    if (problem) {
      console.error(problem)
      process.exit(1)
    }
  } else {
    console.error('usage: preview-neon.mjs stale <branches.json> <prs.json> | live <branch> <prs.json> | valid <branch> | capacity <branches.json> <limit> <target>')
    process.exit(2)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`preview-neon: ${e.message}`)
    process.exit(2)
  }
}
