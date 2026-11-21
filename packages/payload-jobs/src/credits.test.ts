import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  buildOrganisationHistory,
  canReadOrganisationHistory,
  CREDIT_LEDGER_PURGE_CONTEXT,
  creditIdempotencyKey,
  creditLedgerCollection,
  creditLedgerCreateAccess,
  creditLedgerReadAccess,
  CreditLedgerError,
  creditLockKey,
  creditMovementProblems,
  creditsGrantedByQuote,
  isCreditDelta,
  refuseCreditLedgerDelete,
  sumCreditDeltas,
} from './credits'
import { DEFAULT_PAYLOAD_JOBS_SLUGS, resolvePayloadJobsSlugs } from './slugs'

const user = (tenants: { role: string; tenant: number }[], extra: Record<string, unknown> = {}) =>
  ({ collection: 'users', id: 1, role: 'user', tenants, ...extra }) as never
const reqFor = (u: unknown) => ({ context: {}, user: u }) as never
const paths = (movement: Parameters<typeof creditMovementProblems>[0]) =>
  creditMovementProblems(movement).map((problem) => problem.path)
const deleteArgs = (context: Record<string, unknown>) => ({ collection: { slug: 'credit-ledger' }, id: 1, req: { context } }) as never
const at = (minute: number) => new Date(Date.UTC(2026, 10, 21, 9, minute)).toISOString()

describe('credit movements @S-149', () => {
  it('accepts only whole, non-zero deltas', () => {
    expect(isCreditDelta(1)).toBe(true)
    expect(isCreditDelta(-3)).toBe(true)
    for (const bad of [0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(isCreditDelta(bad)).toBe(false)
    }
  })

  it('checks each reason’s shape', () => {
    expect(creditMovementProblems({ delta: 5, order: 1, reason: 'bought' })).toEqual([])
    expect(creditMovementProblems({ delta: -1, job: 2, reason: 'used' })).toEqual([])
    expect(creditMovementProblems({ delta: 1, job: 2, reason: 'refunded' })).toEqual([])
    expect(creditMovementProblems({ delta: -2, note: 'Duplicate pack', reason: 'adjustment' })).toEqual([])
    expect(creditMovementProblems({ delta: 4, legacyRef: 'wp:123', reason: 'opening' })).toEqual([])

    expect(paths({ delta: -5, order: 1, reason: 'bought' })).toEqual(['delta'])
    expect(paths({ delta: 5, reason: 'bought' })).toEqual(['order'])
    expect(paths({ delta: 5, job: 3, order: 1, reason: 'bought' })).toEqual(['job'])
    expect(paths({ delta: -2, job: 2, reason: 'used' })).toEqual(['delta'])
    expect(paths({ delta: -1, reason: 'used' })).toEqual(['job'])
    expect(paths({ delta: 2, job: 2, reason: 'refunded' })).toEqual(['delta'])
    expect(paths({ delta: 3, note: '   ', reason: 'adjustment' })).toEqual(['note'])
    expect(paths({ delta: 3, reason: 'opening' })).toEqual(['legacyRef'])
    expect(paths({ delta: 0, reason: 'adjustment', note: 'x' })).toEqual(['delta'])
    expect(paths({ delta: 1, reason: 'expired' })).toEqual(['reason'])
  })

  it('keys each once-only movement, and leaves plain adjustments repeatable', () => {
    expect(creditIdempotencyKey({ delta: 5, order: 7, reason: 'bought' })).toBe('bought:order:7')
    expect(creditIdempotencyKey({ delta: -1, job: 9, reason: 'used' })).toBe('used:job:9')
    expect(creditIdempotencyKey({ delta: -1, job: 9, order: 7, reason: 'used' })).toBe('used:job:9:order:7')
    expect(creditIdempotencyKey({ delta: 1, job: { id: 9 }, reason: 'refunded' })).toBe('refunded:job:9')
    expect(creditIdempotencyKey({ delta: 2, legacyRef: ' wp:1 ', reason: 'opening', tenant: 3 })).toBe('opening:3:wp:1')
    expect(creditIdempotencyKey({ delta: 2, note: 'x', reason: 'adjustment' })).toBeNull()
    expect(creditIdempotencyKey({ delta: 2, idempotencyKey: 'form-1', note: 'x', reason: 'adjustment' })).toBe('adjustment:form-1')
  })

  it('sums deltas exactly and refuses to lose precision', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ max: 1000, min: -1000 })), (deltas) => {
        expect(sumCreditDeltas(deltas)).toBe(deltas.reduce((a, b) => a + b, 0))
      }),
    )
    expect(() => sumCreditDeltas([Number.MAX_SAFE_INTEGER, 1])).toThrow(/too large/)
    expect(() => sumCreditDeltas([0.5])).toThrow(/whole/)
  })

  it('locks on a stable signed 32-bit key per organisation', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const key = creditLockKey(text)
        expect(Number.isInteger(key)).toBe(true)
        expect(key).toBeGreaterThanOrEqual(-(2 ** 31))
        expect(key).toBeLessThan(2 ** 31)
        expect(creditLockKey(text)).toBe(key)
      }),
    )
    expect(creditLockKey('1')).not.toBe(creditLockKey('2'))
  })

  it('reports refusals to the admin with their reason, and hides server faults', () => {
    expect(new CreditLedgerError('insufficient-credits', 'x')).toMatchObject({ code: 'insufficient-credits', isPublic: true, status: 400 })
    expect(new CreditLedgerError('already-recorded', 'x')).toMatchObject({ isPublic: true, status: 409 })
    expect(new CreditLedgerError('needs-transaction', 'x')).toMatchObject({ isPublic: false, status: 500 })
  })

  it('reads the granted credits from a quote snapshot', () => {
    expect(creditsGrantedByQuote({ entitlements: { jobCreditsGranted: 5 } })).toBe(5)
    expect(creditsGrantedByQuote({ entitlements: {} })).toBeNull()
    expect(creditsGrantedByQuote(null)).toBeNull()
  })
})

describe('credit ledger access @S-149', () => {
  it('lets members read their own organisation’s rows and site managers their tenant’s', () => {
    const read = creditLedgerReadAccess(true)
    expect(read({ req: reqFor(null) } as never)).toBe(false)
    expect(read({ req: reqFor(user([], { role: 'super-admin' })) } as never)).toBe(true)
    expect(read({ req: reqFor(user([{ role: 'tenant-admin', tenant: 1 }])) } as never)).toEqual({ tenant: { in: [1] } })
    expect(read({ req: reqFor(user([{ role: 'employer', tenant: 1 }], { organisation: 4 })) } as never)).toEqual({
      and: [{ organisation: { equals: 4 } }, { tenant: { in: [1] } }],
    })
    expect(read({ req: reqFor(user([{ role: 'editor', tenant: 1 }])) } as never)).toBe(false)
    expect(read({ req: reqFor(user([{ role: 'seeker', tenant: 1 }], { organisation: 4 })) } as never)).toBe(false)
    expect(read({ req: reqFor(user([{ role: 'employer', tenant: 1 }])) } as never)).toBe(false)
  })

  it('lets only site managers of the submitted tenant create (adjustments)', () => {
    const create = creditLedgerCreateAccess(true)
    const admin = user([{ role: 'tenant-admin', tenant: 1 }])
    expect(create({ data: { tenant: 1 }, req: reqFor(admin) } as never)).toBe(true)
    expect(create({ data: { tenant: 2 }, req: reqFor(admin) } as never)).toBe(false)
    expect(create({ data: {}, req: reqFor(admin) } as never)).toBe(false)
    expect(create({ data: { tenant: 1 }, req: reqFor(user([{ role: 'employer', tenant: 1 }], { organisation: 4 })) } as never)).toBe(false)
    expect(create({ data: { tenant: 1 }, req: reqFor(null) } as never)).toBe(false)
  })

  it('gives nobody update or delete, whatever a host overrides for read', () => {
    const collection = creditLedgerCollection({ access: { read: () => true } })
    const access = collection.access as Record<string, (args: unknown) => unknown>
    expect(access.update({ req: reqFor(user([], { role: 'super-admin' })) })).toBe(false)
    expect(access.delete({ req: reqFor(user([], { role: 'super-admin' })) })).toBe(false)
    expect(collection.versions).toBe(false)
    expect(collection.hooks?.beforeDelete).toContain(refuseCreditLedgerDelete)
  })

  it('refuses deletes even past access, unless a tenant is purged on purpose', () => {
    expect(() => refuseCreditLedgerDelete(deleteArgs({}))).toThrow()
    expect(() => refuseCreditLedgerDelete(deleteArgs({ [CREDIT_LEDGER_PURGE_CONTEXT]: true }))).not.toThrow()
  })

  it('uses the resolved slugs for itself and its relations', () => {
    const slugs = resolvePayloadJobsSlugs({ creditLedger: { slug: 'job-credits' }, orders: { slug: 'sales' } })
    const collection = creditLedgerCollection({ slugs })
    expect(collection.slug).toBe('job-credits')
    expect(JSON.stringify(collection.fields)).toContain('"relationTo":"sales"')
    expect(DEFAULT_PAYLOAD_JOBS_SLUGS.creditLedger).toBe('credit-ledger')
  })

  it('shows the history to super admins, the tenant’s site managers and the organisation’s members only', () => {
    const org = { id: 4, tenant: 1 }
    expect(canReadOrganisationHistory(user([], { role: 'super-admin' }), org, true)).toEqual({ allowed: true, staff: true })
    expect(canReadOrganisationHistory(user([{ role: 'tenant-admin', tenant: 1 }]), org, true)).toEqual({ allowed: true, staff: true })
    expect(canReadOrganisationHistory(user([{ role: 'tenant-admin', tenant: 2 }]), org, true).allowed).toBe(false)
    expect(canReadOrganisationHistory(user([{ role: 'employer', tenant: 1 }], { organisation: 4 }), org, true)).toEqual({ allowed: true, staff: false })
    expect(canReadOrganisationHistory(user([{ role: 'employer', tenant: 1 }], { organisation: 5 }), org, true).allowed).toBe(false)
    expect(canReadOrganisationHistory(user([{ role: 'employer', tenant: 2 }], { organisation: 4 }), org, true).allowed).toBe(false)
    expect(canReadOrganisationHistory(user([{ role: 'editor', tenant: 1 }], { organisation: 4 }), org, true).allowed).toBe(false)
    expect(canReadOrganisationHistory(null, org, true).allowed).toBe(false)
  })
})

describe('organisation history @S-149', () => {

  const orders = [
    {
      createdAt: at(1),
      currency: 'VUV',
      id: 10,
      jobs: [],
      log: [
        { at: at(1), by: 7, event: 'created', to: 'pending' },
        { at: at(2), by: null, event: 'status', from: 'pending', to: 'paid' },
      ],
      status: 'paid',
      total: 17500,
    },
    { createdAt: at(5), currency: 'VUV', id: 11, jobs: [20], log: [{ at: at(5), event: 'created', to: 'pending' }], status: 'pending', total: 0 },
    { createdAt: at(30), currency: 'VUV', id: 12, jobs: [20], log: [], status: 'cancelled', total: 3500 },
  ]
  const jobs = [
    { createdAt: at(4), expiresAt: at(20), id: 20, publishedAt: at(6), status: 'expired', title: 'Brewer' },
    { createdAt: at(8), id: 21, publishedAt: null, status: 'cancelled', title: 'Teller', updatedAt: at(9) },
  ]
  const ledger = [
    { createdAt: at(2), createdBy: null, delta: 5, id: 100, legacyRef: null, order: 10, organisation: 4, reason: 'bought' as const },
    { createdAt: at(5), createdBy: { relationTo: 'users', value: 7 }, delta: -1, id: 101, job: 20, order: 11, organisation: 4, reason: 'used' as const },
    { createdAt: at(8), delta: -1, id: 102, job: 21, organisation: 4, reason: 'used' as const },
    { createdAt: at(9), delta: 1, id: 103, job: 21, organisation: 4, reason: 'refunded' as const },
    { createdAt: at(0), delta: 2, id: 99, legacyRef: 'wp:55', note: 'Imported', organisation: 4, reason: 'opening' as const },
  ]

  it('merges orders, credits and job events in time order with a running balance and totals', () => {
    const history = buildOrganisationHistory({ jobs, ledger, orders, organisation: 4 })
    const rows = history.entries.map((entry) => `${entry.kind}:${entry.event}:${entry.balance}`)

    expect(rows).toEqual([
      'credit:opening:2',
      'order:created:2',
      'order:paid:2',
      'credit:bought:7',
      'job:posted:7',
      'order:created:7',
      'credit:used:6',
      'job:published:6',
      'job:posted:6',
      'credit:used:5',
      'job:cancelled:5',
      'credit:refunded:6',
      'job:expired:6',
      'order:created:6',
      'job:relisted:6',
    ])
    expect(history.totals).toEqual({
      balance: 6,
      creditsIn: 8,
      creditsOut: 2,
      orders: [{ count: 2, currency: 'VUV', total: 17500 }],
    })
  })

  it('links each entry to its order and job, and names who did it', () => {
    const history = buildOrganisationHistory({ jobs, ledger, orders, organisation: 4 })
    const used = history.entries.find((entry) => entry.credit?.id === 101)
    expect(used?.job).toEqual({ id: 20, status: 'expired', title: 'Brewer' })
    expect(used?.order).toEqual({ currency: 'VUV', id: 11, status: 'pending', total: 0 })
    expect(used?.by).toEqual({ collection: 'users', id: 7 })
    expect(history.entries.find((entry) => entry.event === 'relisted')?.order?.id).toBe(12)
  })

  it('shows the legacy reference to site managers only', () => {
    const member = buildOrganisationHistory({ jobs, ledger, orders, organisation: 4 })
    const staff = buildOrganisationHistory({ includeStaffFields: true, jobs, ledger, orders, organisation: 4 })
    expect(member.entries[0].credit).not.toHaveProperty('legacyRef')
    expect(staff.entries[0].credit?.legacyRef).toBe('wp:55')
  })

  it('ends on the sum of the rows, whatever their order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ delta: fc.integer({ max: 20, min: -20 }).filter((d) => d !== 0), minute: fc.integer({ max: 59, min: 0 }) }), { maxLength: 30 }),
        (moves) => {
          const rows = moves.map((move, index) => ({
            createdAt: at(move.minute),
            delta: move.delta,
            id: index + 1,
            note: 'x',
            organisation: 4,
            reason: 'adjustment' as const,
          }))
          const history = buildOrganisationHistory({ jobs: [], ledger: rows, orders: [], organisation: 4 })
          const sum = moves.reduce((total, move) => total + move.delta, 0)
          expect(history.totals.balance).toBe(sum)
          expect(history.entries.at(-1)?.balance ?? 0).toBe(sum)
        },
      ),
    )
  })
})
