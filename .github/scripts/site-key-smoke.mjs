#!/usr/bin/env node
// Runtime evidence that site keys scope reads on a deployed preview (PJ-76).
//
// Seeds a preview's Neon branch with two normal tenants, the aggregate tenant, a published
// and a draft document per tenant, and site keys. Then it asks that preview's REST API what
// each key can read and fails on any mismatch.
//
// `tags` has drafts, so the smoke proves both halves of the site-key rule: a key reads its
// tenant's published documents, and never a draft.
//
// Keys are generated with the CMS's own `generateSiteKey`, so the database only ever
// receives their SHA-256 digest — exactly what `hashSiteKey` computes. The raw keys live in
// this process and are never written to disk or to a log.
//
//   DATABASE_URL=postgres://… PREVIEW_URL=https://… node site-key-smoke.mjs
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { generateSiteKey, SITE_KEY_PREFIX } from '../../packages/payload-jobs/src/site-keys.ts'

/**
 * A collection with the site-key access override; see `apps/cms/src/site-keys.ts`. `tags` is
 * the only allowlisted collection with drafts, which is what makes the published-only half of
 * the rule testable here.
 */
export const COLLECTION = 'tags'

/** Every row this script owns carries this prefix, so a re-run replaces only its own data. */
export const SMOKE_PREFIX = 'site-key-smoke'

export const TENANT_A = `${SMOKE_PREFIX}-a`
export const TENANT_B = `${SMOKE_PREFIX}-b`
export const TENANT_HUB = `${SMOKE_PREFIX}-hub`

const TENANTS = [
  { aggregate: false, name: 'Site key smoke A', slug: TENANT_A },
  { aggregate: false, name: 'Site key smoke B', slug: TENANT_B },
  { aggregate: true, name: 'Site key smoke hub', slug: TENANT_HUB },
]

export const publishedDoc = (tenant) => `${SMOKE_PREFIX}-${tenant}-published`
export const draftDoc = (tenant) => `${SMOKE_PREFIX}-${tenant}-draft`

/**
 * Split a Postgres URL into libpq environment variables. Keeping the connection string out
 * of argv means it cannot leak through a process listing or a psql error message.
 */
export const psqlEnv = (databaseUrl) => {
  const url = new URL(databaseUrl)

  const env = {
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\/+/, '')),
    PGHOST: url.hostname,
    PGPASSWORD: decodeURIComponent(url.password),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
  }

  // Neon hands out ?sslmode=require&channel_binding=require. psql honours both from the env.
  for (const [param, variable] of [
    ['sslmode', 'PGSSLMODE'],
    ['channel_binding', 'PGCHANNELBINDING'],
  ]) {
    const value = url.searchParams.get(param)
    if (value) env[variable] = value
  }

  return env
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`

/**
 * Idempotent seed SQL: tenants are upserted by slug, and the documents and keys this script
 * owns are deleted and recreated, so a re-run never doubles them up.
 *
 * `tags` has drafts, so each document carries a `_status`. Documents are inserted without it
 * and then marked with a literal `update`: an assignment coerces the literal to the status
 * enum, while a `values` list of text would need the collection's generated enum type by
 * name.
 */
export const buildSeedSql = ({ docs, keys }) => {
  const tenantRows = TENANTS.map(
    ({ aggregate, name, slug }) => `  (${quote(name)}, ${quote(slug)}, ${aggregate})`,
  ).join(',\n')

  const docRows = docs
    .map(({ name, slug }) => `  (${quote(name)}, ${quote(slug)})`)
    .join(',\n')

  const statusUpdates = [...Map.groupBy(docs, ({ status }) => status ?? 'published')]
    .map(
      ([status, group]) =>
        `update "${COLLECTION}" set "_status" = ${quote(status)} where "name" in (` +
        `${group.map(({ name }) => quote(name)).join(', ')});`,
    )
    .join('\n')

  const keyRows = keys
    .map(({ hash, label, slug }) => `  (${quote(label)}, ${quote(slug)}, ${quote(hash)})`)
    .join(',\n')

  return `begin;

insert into "tenants" ("name", "slug", "is_aggregate") values
${tenantRows}
on conflict ("slug") do update set
  "name" = excluded."name",
  "is_aggregate" = excluded."is_aggregate";

delete from "${COLLECTION}" where "name" like ${quote(`${SMOKE_PREFIX}%`)};

insert into "${COLLECTION}" ("name", "tenant_id")
select v."name", t."id"
  from (values
${docRows}
  ) as v("name", "slug")
  join "tenants" t on t."slug" = v."slug";

${statusUpdates}

delete from "site_keys" where "label" like ${quote(`${SMOKE_PREFIX}%`)};

insert into "site_keys" ("label", "tenant_id", "key_hash")
select v."label", t."id", v."key_hash"
  from (values
${keyRows}
  ) as v("label", "slug", "key_hash")
  join "tenants" t on t."slug" = v."slug";

commit;
`
}

/** The documents this smoke owns, taken from a REST list response. */
export const smokeDocNames = (body) => {
  const docs = Array.isArray(body?.docs) ? body.docs : []

  return docs
    .map((doc) => doc?.name)
    .filter((name) => typeof name === 'string' && name.startsWith(`${SMOKE_PREFIX}-`))
    .toSorted()
}

const describe = (names) => (names.length === 0 ? 'no documents' : names.join(', '))

const sameNames = (actual, expected) =>
  actual.length === expected.length && expected.toSorted().every((name, i) => actual[i] === name)

/**
 * Compare what each key could read with what it should read.
 *
 * Tenant B has a key of its own. It proves B's published document really exists and is only
 * hidden from A's key by the tenant scope, so the tenant-A assertion cannot pass merely
 * because B's document was never seeded.
 *
 * `tags` carries drafts, so a draft document exists for A and for B. Neither the tenant keys
 * nor the aggregate key may read them: the expected sets below hold published documents only,
 * and `seeded` proves the drafts really are in the database, so a filter regression fails here
 * instead of passing on an empty seed.
 *
 * A missing or unknown key may be refused or simply return nothing, as long as it never
 * returns a tenant document.
 */
export const checkSiteKeyReads = ({ responses, seeded }) => {
  const failures = []
  const notes = []

  const expectedDocs = {
    aggregate: [publishedDoc('a'), publishedDoc('b')],
    tenantA: [publishedDoc('a')],
    spare: [publishedDoc('b')],
  }

  const expectedDraftCount = 2

  if (seeded.drafts !== expectedDraftCount) {
    failures.push(
      `seeded ${seeded.drafts} draft document(s), expected ${expectedDraftCount}: ` +
        'the draft filter is unproven without them',
    )
  }

  for (const [label, names] of Object.entries(expectedDocs)) {
    const { names: actual, status } = responses[label]

    if (status >= 500) {
      failures.push(`${label}: the preview answered HTTP ${status}`)
    } else if (status >= 300) {
      failures.push(`${label}: refused with HTTP ${status}, expected ${describe(names)}`)
    } else if (!sameNames(actual, names)) {
      failures.push(`${label}: read ${describe(actual)}, expected ${describe(names)}`)
    }

    const leaked = [draftDoc('a'), draftDoc('b')].filter((name) => actual.includes(name))
    if (leaked.length > 0) failures.push(`${label}: read draft ${describe(leaked)}`)
  }

  for (const label of ['anonymous', 'badKey']) {
    const { names: actual, status } = responses[label]

    if (status >= 500) failures.push(`${label}: the preview answered HTTP ${status}`)
    else if (actual.length > 0) failures.push(`${label}: read ${describe(actual)}`)
    else notes.push(`${label}: nothing readable (HTTP ${status})`)
  }

  if (seeded.drafts === expectedDraftCount) {
    notes.push(
      `seeded ${seeded.published} published and ${seeded.drafts} draft \`${COLLECTION}\` documents`,
    )
  }

  return { failures, notes }
}

/**
 * The job alert endpoints (PJ-47) on the deployed preview. Nothing here sends an email or stores
 * a row: each request is answered before the alert code writes anything.
 *
 * - `invalidLink`: tenant A's key and a link that was never issued. It has to get through the key,
 *   the tenant lookup (which reads the new alert settings columns, so a missing migration is a 500
 *   here) and the link check (AES-GCM in the Worker), and be refused as an invalid link.
 * - `otherSite`: tenant B's key on tenant A's address is refused as another site's key.
 * - `anonymous`, `badKey`: no key, or one that was never stored, is refused.
 * - `bot`: a filled-in honeypot is answered like a person and does nothing.
 */
export const ALERT_EXPECTATIONS = {
  anonymous: { code: 'invalid_site_key', status: 401 },
  badKey: { code: 'invalid_site_key', status: 401 },
  bot: { status: 202 },
  invalidLink: { code: 'invalid_token', status: 400 },
  otherSite: { code: 'tenant_mismatch', status: 403 },
}

export const checkAlertEndpoints = ({ responses }) => {
  const failures = []
  const notes = []

  for (const [label, expected] of Object.entries(ALERT_EXPECTATIONS)) {
    const { code, status } = responses[label]

    if (status >= 500) {
      failures.push(`${label}: the preview answered HTTP ${status}`)
    } else if (status !== expected.status || (expected.code && code !== expected.code)) {
      failures.push(
        `${label}: answered HTTP ${status}${code ? ` ${code}` : ''}, expected HTTP ${expected.status}` +
          `${expected.code ? ` ${expected.code}` : ''}`,
      )
    } else {
      notes.push(`alerts ${label}: HTTP ${status}${code ? ` ${code}` : ''}`)
    }
  }

  return { failures, notes }
}

const runPsql = (env, sql) => {
  const childEnv = { ...process.env, ...env }
  delete childEnv.DATABASE_URL

  const result = spawnSync(
    'psql',
    [
      '--no-password',
      '--quiet',
      '--no-align',
      '--tuples-only',
      '--set',
      'ON_ERROR_STOP=1',
      '--file',
      '-',
    ],
    { encoding: 'utf8', env: childEnv, input: sql },
  )

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr.trim()}`)

  return result.stdout.trim()
}

const readDocuments = async (previewUrl, key) => {
  const target = new URL(`/api/${COLLECTION}`, previewUrl)
  target.searchParams.set('depth', '0')
  target.searchParams.set('limit', '100')
  target.searchParams.set('where[name][like]', SMOKE_PREFIX)

  const response = await fetch(target, { headers: key ? { 'x-site-key': key } : {} })
  const body = await response.json().catch(() => null)

  return { names: smokeDocNames(body), status: response.status }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A Worker that has just been deployed can answer 500 while it starts, which would look like a
 * mismatch. Retry any 5xx until the deadline, then let the response through so the assertions
 * report it.
 */
export const readWithRetry = async (
  previewUrl,
  key,
  { attempt = readDocuments, deadlineMs = 60_000, stepMs = 3000, wait = sleep } = {},
) => {
  const deadline = Date.now() + deadlineMs

  for (;;) {
    const response = await attempt(previewUrl, key)

    if (response.status < 500 || Date.now() >= deadline) return response

    await wait(stepMs)
  }
}

const probeAlerts = (path, body) => async (previewUrl, key) => {
  const response = await fetch(new URL(`/api/tenants/${TENANT_A}/alerts/${path}`, previewUrl), {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(key ? { 'x-site-key': key } : {}) },
    method: 'POST',
  })
  const parsed = await response.json().catch(() => null)

  return { code: parsed?.error?.code, status: response.status }
}

const seed = (env, keys) => {
  const docs = [
    { name: publishedDoc('a'), slug: TENANT_A, status: 'published' },
    { name: publishedDoc('b'), slug: TENANT_B, status: 'published' },
    { name: draftDoc('a'), slug: TENANT_A, status: 'draft' },
    { name: draftDoc('b'), slug: TENANT_B, status: 'draft' },
  ]

  runPsql(
    env,
    buildSeedSql({
      docs,
      keys: [
        { hash: keys.tenantA.keyHash, label: `${SMOKE_PREFIX}-a`, slug: TENANT_A },
        { hash: keys.spare.keyHash, label: `${SMOKE_PREFIX}-b`, slug: TENANT_B },
        { hash: keys.aggregate.keyHash, label: `${SMOKE_PREFIX}-hub`, slug: TENANT_HUB },
      ],
    }),
  )

  return {
    drafts: docs.filter(({ status }) => status === 'draft').length,
    published: docs.filter(({ status }) => status === 'published').length,
  }
}

const writeSummary = ({ failures, notes, responses, seeded }) => {
  const table = Object.entries(responses)
    .map(([label, { names, status }]) => `| ${label} | ${status} | ${describe(names)} |`)
    .join('\n')

  const summary = `### Site-key smoke

| Request | HTTP | Read |
| --- | --- | --- |
${table}

\`${COLLECTION}\`: ${seeded.published} published and ${seeded.drafts} draft documents seeded

${notes.map((note) => `- ${note}`).join('\n')}
${failures.map((failure) => `- **FAILED**: ${failure}`).join('\n')}
`

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  }

  console.log(summary)
}

const main = async () => {
  const databaseUrl = process.env.DATABASE_URL
  const previewUrl = process.env.PREVIEW_URL?.replace(/\/+$/, '')

  if (!databaseUrl || !previewUrl) {
    throw new Error('DATABASE_URL and PREVIEW_URL must both be set')
  }

  const env = psqlEnv(databaseUrl)
  // `bad` is never stored. It has the same shape as a real key, so only the digest lookup
  // can reject it.
  const keys = {
    aggregate: await generateSiteKey(),
    bad: `${SITE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`,
    spare: await generateSiteKey(),
    tenantA: await generateSiteKey(),
  }

  const seeded = seed(env, keys)

  // This call also serves as the anonymous request, so every read below shares one retry path.
  const anonymous = await readWithRetry(previewUrl)
  const responses = {
    aggregate: await readWithRetry(previewUrl, keys.aggregate.key),
    anonymous,
    badKey: await readWithRetry(previewUrl, keys.bad),
    tenantA: await readWithRetry(previewUrl, keys.tenantA.key),
    spare: await readWithRetry(previewUrl, keys.spare.key),
  }

  const reads = checkSiteKeyReads({ responses, seeded })

  const unsubscribe = probeAlerts('unsubscribe', { token: 'not.issued' })
  const alertResponses = {
    anonymous: await readWithRetry(previewUrl, undefined, { attempt: unsubscribe }),
    badKey: await readWithRetry(previewUrl, keys.bad, { attempt: unsubscribe }),
    bot: await readWithRetry(previewUrl, keys.tenantA.key, {
      attempt: probeAlerts('manage-link', { alert_website: 'filled', email: 'bot@example.com' }),
    }),
    invalidLink: await readWithRetry(previewUrl, keys.tenantA.key, { attempt: unsubscribe }),
    otherSite: await readWithRetry(previewUrl, keys.spare.key, { attempt: unsubscribe }),
  }
  const alerts = checkAlertEndpoints({ responses: alertResponses })

  const failures = [...reads.failures, ...alerts.failures]
  const notes = [...reads.notes, ...alerts.notes]

  writeSummary({ failures, notes, responses, seeded })

  if (failures.length > 0) {
    for (const failure of failures) console.log(`::error::site-key smoke: ${failure}`)
    throw new Error(`site-key smoke failed with ${failures.length} mismatch(es)`)
  }

  console.log(`Site keys scope reads correctly on ${previewUrl}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.log(`::error::${error.message}`)
    process.exit(1)
  })
}
