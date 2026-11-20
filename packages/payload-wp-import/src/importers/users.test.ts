import { describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { runImport } from '../run-import'
import { createFakePayload } from '../test-utils'
import { createFixtureConnection, userTables } from '../test/fixtures'
import {
  activeReasons,
  buildImportPlan,
  cleanUrl,
  isFlagSet,
  mapOrganisationSize,
  mapOrganisationType,
  normaliseOrganisationName,
  parseCapabilities,
  parseLastLogin,
  tenantRoleFor,
  usersImporters,
  type LegacyUserFacts,
} from './users'

const NOW = new Date('2026-11-20T00:00:00Z')
const readerFor = (tables = userTables) => {
  const connection = createFixtureConnection(tables)
  return new MysqlReader({ connect: async () => connection, pageSize: 4 })
}
const rules = { activeJobsSince: '2022-01-01', activeLoginYears: 3, now: NOW }
const facts = (overrides: Partial<LegacyUserFacts> = {}): LegacyUserFacts => ({
  hasRecentJobOrOrder: false,
  meta: {},
  roles: ['job_lister'],
  user: { ID: 1 },
  ...overrides,
})

const loginAt = (last_login: string) => activeReasons(facts({ meta: { last_login } }), rules)

describe('the active rule @S-130', () => {
  it('keeps a login exactly three years ago and drops one second earlier', () => {
    const at = loginAt
    expect(at('2023-11-20 00:00:00')).toEqual(['login'])
    expect(at('2023-11-19 23:59:59')).toEqual([])
  })

  it('follows the configured number of years', () => {
    const meta = { last_login: '2025-06-01 00:00:00' }
    expect(activeReasons(facts({ meta }), { ...rules, activeLoginYears: 1 })).toEqual([])
    expect(activeReasons(facts({ meta }), { ...rules, activeLoginYears: 2 })).toEqual(['login'])
  })

  it('reads unix timestamps, and ignores a missing or garbled last_login', () => {
    expect(parseLastLogin('1767225600')?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(parseLastLogin('')).toBeNull()
    expect(parseLastLogin('never')).toBeNull()
    expect(activeReasons(facts({ meta: { last_login: 'never' } }), rules)).toEqual([])
  })

  it('keeps a job or order since the cut-off day, inclusive, via hasRecentJobOrOrder', () => {
    expect(activeReasons(facts({ hasRecentJobOrOrder: true }), rules)).toEqual(['job'])
  })

  it('keeps an active alert subscription but not an inactive one', () => {
    expect(activeReasons(facts({ meta: { jr_alert_status: 'active' } }), rules)).toEqual(['alert'])
    expect(activeReasons(facts({ meta: { jr_alert_status: 'inactive' } }), rules)).toEqual([])
  })

  it('keeps admins and editors, and reports every reason that applies', () => {
    expect(activeReasons(facts({ roles: ['editor'] }), rules)).toEqual(['admin'])
    const all = facts({
      hasRecentJobOrOrder: true,
      meta: { jr_alert_status: 'active', last_login: '2026-01-01 00:00:00' },
      roles: ['administrator'],
    })
    expect(activeReasons(all, rules)).toEqual(['login', 'job', 'alert', 'admin'])
  })
})

describe('legacy user and organisation field mapping @S-130', () => {
  it('reads roles out of the serialized capabilities', () => {
    expect(parseCapabilities('a:2:{s:10:"job_lister";b:1;s:12:"upload_files";b:1;}')).toEqual([
      'job_lister',
      'upload_files',
    ])
    expect(parseCapabilities('a:1:{s:6:"banned";b:0;}')).toEqual([])
    expect(parseCapabilities(undefined)).toEqual([])
  })

  it('maps legacy roles to tenant roles, staff first', () => {
    expect(tenantRoleFor(['administrator', 'job_lister'])).toBe('tenant-admin')
    expect(tenantRoleFor(['editor'])).toBe('tenant-admin')
    expect(tenantRoleFor(['job_lister', 'upload_files'])).toBe('employer')
    expect(tenantRoleFor(['recruiter'])).toBe('employer')
    expect(tenantRoleFor(['job_seeker'])).toBe('seeker')
    expect(tenantRoleFor(['subscriber'])).toBeNull()
  })

  it('treats a present meta row as set unless it says no', () => {
    expect(isFlagSet('')).toBe(true)
    expect(isFlagSet('1')).toBe(true)
    expect(isFlagSet('off')).toBe(false)
    expect(isFlagSet('0')).toBe(false)
    expect(isFlagSet(undefined)).toBe(false)
  })

  it('normalises names so duplicates meet, without over-merging', () => {
    expect(normaliseOrganisationName('Example  Resort Ltd.')).toBe(
      normaliseOrganisationName('example resort LTD'),
    )
    expect(normaliseOrganisationName('Café &amp; Bar')).toBe(normaliseOrganisationName('Cafe and Bar'))
    expect(normaliseOrganisationName('Example Resort')).not.toBe(normaliseOrganisationName('Example Resort Ltd'))
    expect(normaliseOrganisationName('!!!')).toBe('')
  })

  it('maps type and size onto the platform values, leaving the unknown empty', () => {
    expect(mapOrganisationType('Not-for-profit')).toBe('nfp')
    expect(mapOrganisationType('Social Enterprise')).toBe('social-enterprise')
    expect(mapOrganisationType('Mystery')).toBeUndefined()
    expect(mapOrganisationSize('1')).toBe('1-10')
    expect(mapOrganisationSize('11-50')).toBe('11-50')
    expect(mapOrganisationSize('51 to 200 people')).toBe('51-200')
    expect(mapOrganisationSize('201-500')).toBe('201-500')
    expect(mapOrganisationSize('500+')).toBe('500-plus')
    expect(mapOrganisationSize('1,000-5,000')).toBe('500-plus')
    expect(mapOrganisationSize('lots')).toBeUndefined()
  })

  it('accepts web addresses and drops anything else', () => {
    expect(cleanUrl('example.com')).toBe('https://example.com')
    expect(cleanUrl('http://example.com/a')).toBe('http://example.com/a')
    expect(cleanUrl('@handle')).toBeUndefined()
    expect(cleanUrl('two words.com')).toBeUndefined()
  })
})

describe('buildImportPlan @S-130', () => {
  it('keeps the active users and gives every skip a reason', async () => {
    const plan = await buildImportPlan(readerFor(), { now: () => NOW })
    const outcome = (id: number) => plan.users.get(id)?.skip ?? 'kept'

    expect(plan.report.usersRead).toBe(13)
    expect([1, 2, 3, 5, 6, 7, 8, 13].map(outcome)).toEqual(Array(8).fill('kept'))
    expect(outcome(4)).toBe('inactive') // old login, and its only job is from 2021
    expect(outcome(9)).toBe('inactive') // one second outside the login window, order from 2021
    expect(outcome(10)).toBe('no-organisation-name')
    expect(outcome(11)).toBe('unsupported-role')
    expect(outcome(12)).toBe('invalid-email')
    expect(plan.report.usersKept).toBe(8)
  })

  it('does not count a page, only jobs and orders, as activity', async () => {
    const plan = await buildImportPlan(readerFor(), { now: () => NOW })
    expect(plan.users.get(4)?.facts.hasRecentJobOrOrder).toBe(false)
    expect(plan.users.get(6)?.reasons).toEqual(['job'])
  })

  it('merges employers with the same name into one organisation owned by the lowest id', async () => {
    const plan = await buildImportPlan(readerFor(), { now: () => NOW })

    expect(plan.organisationOf.get(2)).toEqual({ organisationLegacyId: 2, owner: true })
    expect(plan.organisationOf.get(3)).toEqual({ organisationLegacyId: 2, owner: false })
    expect(plan.organisationOf.has(5)).toBe(false) // seekers have no organisation
    expect(plan.organisationOf.has(1)).toBe(false) // nor do site managers
    expect(plan.groups.map((group) => group.name)).toEqual([
      'Example Resort Ltd',
      'Sample Charters',
      'Boundary Co',
      'Pacific Staffing',
    ])
    expect(plan.report).toMatchObject({ employersKept: 5, organisations: 4, organisationsMerged: 1 })
  })

  it('merges names that differ only in punctuation', async () => {
    const tables = structuredClone(userTables)
    tables.wp_usermeta = tables.wp_usermeta!.map((row) =>
      row.user_id === 6 && row.meta_key === 'nickname' ? { ...row, meta_value: 'Boundary-Co!' } : row,
    )
    const plan = await buildImportPlan(readerFor(tables), { now: () => NOW })
    const group = plan.groups.find((candidate) => candidate.members.some((m) => m.user.ID === 6))!

    expect(group.members.map((member) => member.user.ID)).toEqual([6, 8])
    expect(group.name).toBe('Boundary-Co!') // the owner (lowest id) names it
  })
})

const run = async (dryRun: boolean, payload = createFakePayload(), opts = {}) => {
  const importers = usersImporters({ now: () => NOW, ...opts })
  const summary = await runImport({
    dryRun,
    importers: Object.values(importers),
    payload: payload.payload,
    reader: readerFor(),
    tenant: 7,
  })
  return { ...payload, summary }
}

describe('the users and organisations importers @S-130', () => {
  it('reports a dry run without writing anything', async () => {
    const { summary, writes } = await run(true)

    expect(writes).toEqual([])
    expect(summary.importers.organisations).toMatchObject({ created: 4, failed: 0 })
    expect(summary.importers.organisations!.report).toEqual({
      'legacy employers merged into another organisation': 1,
      'legacy users read': 13,
      'organisations to import': 4,
    })
    expect(summary.importers.users).toMatchObject({ created: 8, skipped: 5, failed: 0 })
    expect(summary.importers.users!.skipReasons).toEqual({
      inactive: 2,
      'invalid-email': 1,
      'no-organisation-name': 1,
      'unsupported-role': 1,
    })
    expect(summary.errors).toEqual([])
  })

  it('creates the organisations with their billing, visibility and contact fields', async () => {
    const { store, summary } = await run(false)
    expect(summary.errors).toEqual([])

    const resort = store.organisations!.find((doc) => doc.legacyId === 2)!
    expect(resort).toMatchObject({
      about: 'Beach & bungalows',
      billingEmail: 'billing@example.com',
      canPayByInvoice: true,
      legacyId: 2,
      listingRequested: true,
      name: 'Example Resort Ltd',
      pageEnabled: true,
      phone: '678 555 0100',
      size: '11-50',
      slug: 'example-resort-ltd',
      socials: { x: 'https://x.com/example' },
      tenant: 7,
      type: 'business',
      website: 'https://example-resort.test',
      xeroContactCode: 'XC-100',
    })

    const charters = store.organisations!.find((doc) => doc.legacyId === 6)!
    expect(charters).toMatchObject({ canPayByInvoice: false, pageEnabled: false, size: '1-10' })
    expect(charters).not.toHaveProperty('billingEmail')
    expect(store.organisations!.find((doc) => doc.legacyId === 13)?.type).toBe('recruiter')
  })

  it('makes pages private when the tenant asks not to keep legacy visibility', async () => {
    const { store } = await run(false, createFakePayload(), { keepPageVisibility: false })
    expect(store.organisations!.find((doc) => doc.legacyId === 2)?.pageEnabled).toBe(false)
  })

  it('creates users with the owner first, a role per tenant, and the legacy hash', async () => {
    const { store } = await run(false)
    const user = (legacyId: number) => store.users!.find((doc) => doc.legacyId === legacyId)!
    const orgId = (legacyId: number) => store.organisations!.find((doc) => doc.legacyId === legacyId)!.id

    expect(store.users).toHaveLength(8)
    expect(user(2)).toMatchObject({
      _verified: true,
      email: 'pat@example.com',
      firstName: 'Pat',
      legacyPasswordHash: '$P$Bpat',
      organisation: orgId(2),
      organisationRole: 'owner',
      role: 'user',
      tenants: [{ role: 'employer', tenant: 7 }],
    })
    expect(user(3)).toMatchObject({ organisation: orgId(2), organisationRole: 'member' })
    expect(user(1)).toMatchObject({ tenants: [{ role: 'tenant-admin', tenant: 7 }] })
    expect(user(1)).not.toHaveProperty('organisation')
    expect(user(5)).toMatchObject({ _verified: true, tenants: [{ role: 'seeker', tenant: 7 }] })
    expect(user(7)).toMatchObject({ _verified: false }) // never confirmed, never logged in
    expect(user(13)).toMatchObject({ organisationRole: 'owner' })
  })

  it('never stores a plaintext password and bypasses the hooks that would clear the hash', async () => {
    const { store, writes } = await run(false)
    expect(store.users!.every((doc) => !('password' in doc))).toBe(true)
    expect(writes.filter((w) => w.collection === 'users').every((w) => w.op === 'create')).toBe(true)
    // `db.create` is the route that skips hooks; the fake records both routes as 'create', so
    // check the data instead: the hash is present exactly as WordPress stored it.
    expect(store.users!.map((doc) => doc.legacyPasswordHash).every((hash) => String(hash).startsWith('$P$'))).toBe(true)
  })

  it('is idempotent: a re-run updates names but never touches a changed password or role', async () => {
    const first = await run(false)
    const pat = first.store.users!.find((doc) => doc.legacyId === 2)!
    // Pat has since signed in (hash cleared), changed email, and been made a tenant admin.
    Object.assign(pat, {
      email: 'pat@new.example',
      firstName: 'Old',
      legacyPasswordHash: null,
      tenants: [{ role: 'tenant-admin', tenant: 7 }],
    })

    const second = await run(false, { payload: first.payload, store: first.store, writes: first.writes } as never)

    expect(second.summary.importers.users).toMatchObject({ created: 0, updated: 8, failed: 0 })
    expect(second.summary.importers.organisations).toMatchObject({ created: 0, updated: 4 })
    expect(first.store.users).toHaveLength(8)
    expect(first.store.organisations).toHaveLength(4)
    expect(pat).toMatchObject({
      email: 'pat@new.example',
      firstName: 'Pat', // names follow the re-run
      legacyPasswordHash: null, // a consumed hash is not resurrected
      tenants: [{ role: 'tenant-admin', tenant: 7 }],
    })
  })

  it('keeps users of another tenant apart even when the legacy id is the same', async () => {
    const payload = createFakePayload({
      users: [{ id: 1, legacyId: 2, tenants: [{ role: 'employer', tenant: 99 }] }],
    })
    const { store, summary } = await run(false, payload)
    expect(summary.importers.users!.created).toBe(8)
    expect(store.users!.filter((doc) => doc.legacyId === 2)).toHaveLength(2)
  })

  it('leaves no email, hash or name in the summary or its errors', async () => {
    const payload = createFakePayload()
    const original = payload.payload.db!.create
    payload.payload.db!.create = async (args) => {
      if (args.data.legacyId === 3) throw new Error('boom')
      return original(args)
    }
    const { summary } = await run(false, payload)
    const text = JSON.stringify(summary)

    expect(summary.errors).toEqual([{ importer: 'users', legacyId: 3, message: 'boom' }])
    expect(text).not.toMatch(/@example\.com|\$P\$|Pat|Lister/)
  })

  it('does not read applications, CVs, resumes or user_IP', async () => {
    const connection = createFixtureConnection(userTables)
    const reader = new MysqlReader({ connect: async () => connection })
    await buildImportPlan(reader, { now: () => NOW })

    const selects = connection.queries.filter((query) => query.startsWith('SELECT')).join('\n')
    expect(selects).not.toMatch(/user_IP|career_status|resume|application/i)
    expect(selects).toMatch(/`wp_usermeta`.*meta_key IN/s)
  })
})
