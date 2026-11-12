import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { hashSiteKey } from '../../packages/payload-jobs/src/site-keys'
import {
  buildSeedSql,
  checkSiteKeyReads,
  draftDoc,
  psqlEnv,
  publishedDoc,
  smokeDocNames,
  TENANT_A,
  TENANT_B,
  TENANT_HUB,
} from './site-key-smoke.mjs'

const keys = [
  { hash: 'a'.repeat(64), label: 'site-key-smoke-a', slug: TENANT_A },
  { hash: 'b'.repeat(64), label: 'site-key-smoke-b', slug: TENANT_B },
  { hash: 'c'.repeat(64), label: 'site-key-smoke-hub', slug: TENANT_HUB },
]

const docs = [
  { name: publishedDoc('a'), slug: TENANT_A },
  { name: publishedDoc('b'), slug: TENANT_B },
]

const responses = (overrides = {}) => ({
  aggregate: { names: [publishedDoc('a'), publishedDoc('b')], status: 200 },
  anonymous: { names: [], status: 403 },
  badKey: { names: [], status: 403 },
  tenantA: { names: [publishedDoc('a')], status: 200 },
  spare: { names: [publishedDoc('b')], status: 200 },
  ...overrides,
})

describe('psqlEnv', () => {
  it('turns a Neon URL into libpq variables without keeping the URL', () => {
    const env = psqlEnv(
      'postgres://neondb_owner:s%40cret@ep-cool.eu.neon.tech:5432/neondb?sslmode=require&channel_binding=require',
    )

    expect(env).toEqual({
      PGDATABASE: 'neondb',
      PGHOST: 'ep-cool.eu.neon.tech',
      PGPASSWORD: 's@cret',
      PGPORT: '5432',
      PGSSLMODE: 'require',
      PGCHANNELBINDING: 'require',
      PGUSER: 'neondb_owner',
    })
  })

  it('defaults the port and omits SSL settings the URL does not set', () => {
    const env = psqlEnv('postgres://orbit:orbit@localhost/orbit')

    expect(env.PGPORT).toBe('5432')
    expect(env).not.toHaveProperty('PGSSLMODE')
    expect(env).not.toHaveProperty('PGCHANNELBINDING')
  })
})

describe('buildSeedSql', () => {
  it('upserts every tenant by slug so a re-run is safe', () => {
    const sql = buildSeedSql({ docs, drafts: false, keys })

    expect(sql).toContain('insert into "tenants" ("name", "slug", "is_aggregate")')
    expect(sql).toContain('on conflict ("slug") do update set')
    for (const slug of [TENANT_A, TENANT_B, TENANT_HUB]) expect(sql).toContain(`'${slug}'`)
    expect(sql).toMatch(/'Site key smoke hub', 'site-key-smoke-hub', true/)
    expect(sql).toMatch(/'Site key smoke A', 'site-key-smoke-a', false/)
  })

  it('clears only the rows this smoke owns before inserting', () => {
    const sql = buildSeedSql({ docs, drafts: false, keys })

    expect(sql).toContain(`delete from "tags" where "name" like 'site-key-smoke%';`)
    expect(sql).toContain(`delete from "site_keys" where "label" like 'site-key-smoke%';`)
  })

  it('stores only digests against the owning tenant', () => {
    const sql = buildSeedSql({ docs, drafts: false, keys })

    expect(sql).toContain('insert into "site_keys" ("label", "tenant_id", "key_hash")')
    expect(sql).toContain('join "tenants" t on t."slug" = v."slug"')
    expect(sql).toContain(`'${'c'.repeat(64)}'`)
  })

  it('omits _status when the collection has no drafts', () => {
    const sql = buildSeedSql({ docs, drafts: false, keys })

    expect(sql).toContain('insert into "tags" ("name", "tenant_id")')
    expect(sql).not.toContain('_status')
  })

  it('writes _status when the collection has drafts', () => {
    const sql = buildSeedSql({
      docs: [...docs, { name: draftDoc('a'), slug: TENANT_A, status: 'draft' }],
      drafts: true,
      keys,
    })

    expect(sql).toContain('insert into "tags" ("name", "tenant_id", "_status")')
    expect(sql).toContain(`'${draftDoc('a')}', '${TENANT_A}', 'draft'`)
    expect(sql).toContain(`'${publishedDoc('a')}', '${TENANT_A}', 'published'`)
  })

  it('escapes quotes in seeded values', () => {
    const sql = buildSeedSql({
      docs: [{ name: "o'brien", slug: TENANT_A, status: 'published' }],
      drafts: true,
      keys,
    })

    expect(sql).toContain(`'o''brien'`)
  })
})

describe('smokeDocNames', () => {
  it('keeps only this smoke’s documents, sorted', () => {
    const names = smokeDocNames({
      docs: [
        { name: publishedDoc('b') },
        { name: 'someone-else' },
        { name: publishedDoc('a') },
        { name: null },
      ],
    })

    expect(names).toEqual([publishedDoc('a'), publishedDoc('b')])
  })

  it('survives an error body', () => {
    expect(smokeDocNames({ errors: [{ message: 'no' }] })).toEqual([])
    expect(smokeDocNames(null)).toEqual([])
  })
})

describe('checkSiteKeyReads', () => {
  it('passes when every key reads exactly its own tenant', () => {
    expect(checkSiteKeyReads({ drafts: false, responses: responses() }).failures).toEqual([])
  })

  it('fails when a tenant key reads another tenant', () => {
    const result = checkSiteKeyReads({
      drafts: false,
      responses: responses({
        tenantA: { names: [publishedDoc('a'), publishedDoc('b')], status: 200 },
      }),
    })

    expect(result.failures.join()).toContain('tenantA: read')
  })

  it('fails when the spare key on tenant B cannot see B, so tenant scoping is unproven', () => {
    const result = checkSiteKeyReads({
      drafts: false,
      responses: responses({ spare: { names: [], status: 200 } }),
    })

    expect(result.failures).toEqual([`spare: read no documents, expected ${publishedDoc('b')}`])
  })

  it('fails when the aggregate key sees drafts or misses a tenant', () => {
    const withDraft = checkSiteKeyReads({
      drafts: true,
      responses: responses({
        aggregate: {
          names: [publishedDoc('a'), publishedDoc('b'), draftDoc('a')],
          status: 200,
        },
      }),
    })
    const missing = checkSiteKeyReads({
      drafts: false,
      responses: responses({ aggregate: { names: [publishedDoc('a')], status: 200 } }),
    })

    expect(withDraft.failures.join()).toContain('aggregate: read')
    expect(missing.failures.join()).toContain('aggregate: read')
  })

  it('fails when the preview refuses a key it should accept', () => {
    const result = checkSiteKeyReads({
      drafts: false,
      responses: responses({ tenantA: { names: [], status: 403 } }),
    })

    expect(result.failures).toEqual([
      `tenantA: refused with HTTP 403, expected ${publishedDoc('a')}`,
    ])
  })

  it.each(['anonymous', 'badKey'] as const)('fails when %s reads a tenant document', (label) => {
    const result = checkSiteKeyReads({
      drafts: false,
      responses: responses({ [label]: { names: [publishedDoc('a')], status: 200 } }),
    })

    expect(result.failures.join()).toContain(`${label}: read`)
  })

  it('accepts a refusal or an empty list for anonymous and bad keys', () => {
    const refused = checkSiteKeyReads({ drafts: false, responses: responses() })
    const empty = checkSiteKeyReads({
      drafts: false,
      responses: responses({
        anonymous: { names: [], status: 200 },
        badKey: { names: [], status: 200 },
      }),
    })

    expect(refused.failures).toEqual([])
    expect(empty.failures).toEqual([])
  })

  it('reports a server error instead of a mismatch', () => {
    const result = checkSiteKeyReads({
      drafts: false,
      responses: responses({ aggregate: { names: [], status: 502 } }),
    })

    expect(result.failures).toEqual(['aggregate: the preview answered HTTP 502'])
  })

  it('notes that no draft was seeded when the collection has drafts disabled', () => {
    const result = checkSiteKeyReads({ drafts: false, responses: responses() })

    expect(result.notes.join()).toContain('drafts disabled')
    expect(checkSiteKeyReads({ drafts: true, responses: responses() }).notes.join()).not.toContain(
      'drafts disabled',
    )
  })
})

describe('seeded keys', () => {
  it('stores the same digest the CMS resolves a key by', async () => {
    const raw = `sk_${'x'.repeat(43)}`

    // Same SHA-256, computed without the CMS helper, exactly as the seed SQL stores it.
    const digest = createHash('sha256').update(raw).digest('hex')

    expect(await hashSiteKey(raw)).toBe(digest)
  })
})
