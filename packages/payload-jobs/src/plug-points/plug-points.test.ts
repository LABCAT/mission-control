import type { Access, Config, Endpoint, PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { payloadJobs } from '../index'
import {
  ADD_ONS_FIELD,
  addOnWriteGuard,
  createPayloadJobsRegistry,
  createRegistry,
  emitJobLifecycle,
  emitOrderEvent,
  enabledAddOnKeys,
  forTenant,
  gateCollectionAccess,
  gateEndpoint,
  getPayloadJobsRegistry,
  isAddOnEnabled,
  jobLifecycleHook,
  orderEventHook,
  runCheckoutSteps,
  validateAddOnKeys,
  RegistryError,
  type CheckoutContext,
  type PayloadJobsRegistry,
} from './index'
import { DEFAULT_PAYLOAD_JOBS_SLUGS } from '../slugs'

const newRegistry = (tenancy: 'multi' | 'single' = 'multi'): PayloadJobsRegistry =>
  createPayloadJobsRegistry({
    settingsSlug: 'job-board-settings',
    slugs: DEFAULT_PAYLOAD_JOBS_SLUGS,
    tenancy,
    tenantsSlug: 'tenants',
  })

describe('registry @S-147', () => {
  it('lists by order, then by registration', () => {
    const registry = createRegistry<{ key: string; order?: number }>('thing')
    registry.register({ key: 'c' })
    registry.register({ key: 'a', order: 10 })
    registry.register({ key: 'b', order: 10 })
    registry.register({ key: 'z', order: 200 })

    expect(registry.list().map((entry) => entry.key)).toEqual(['a', 'b', 'c', 'z'])
  })

  it('throws on a duplicate key, naming the plug point', () => {
    const registry = createRegistry<{ key: string }>('report')
    registry.register({ key: 'jobs-by-month' })

    expect(() => registry.register({ key: 'jobs-by-month' })).toThrow(
      /report "jobs-by-month" is already registered/,
    )
    expect(() => registry.register({ key: 'jobs-by-month' })).toThrow(RegistryError)
  })

  it('rejects keys that are not safe in URLs and settings', () => {
    const registry = createRegistry<{ key: string }>('report')

    for (const key of ['', 'Jobs', '1jobs', 'jobs month', 'jobs/month']) {
      expect(() => registry.register({ key })).toThrow(/invalid/)
    }
    expect(registry.register({ key: 'job.views_by-day' }).key).toBe('job.views_by-day')
  })

  it('gives each plug point its own namespace', () => {
    const registry = newRegistry()
    registry.emailEvents.register({
      defaults: { body: 'Hi', subject: 'Hi' },
      key: 'job-live',
      label: 'Job live',
      recipients: ['employer'],
      variables: [],
    })

    expect(() =>
      registry.reports.register({ fields: [], key: 'job-live', label: 'x', run: () => ({ columns: [], rows: [] }) }),
    ).not.toThrow()
  })

  it('ships the invoice, free and credit payment providers in core', () => {
    expect(newRegistry().paymentProviders.list().map((provider) => provider.key)).toEqual([
      'invoice',
      'free',
      'credit',
    ])
  })
})

describe('per-tenant add-on switch @S-147', () => {
  it('treats a tenant that never chose as having every add-on on', () => {
    expect(isAddOnEnabled({}, 'alerts')).toBe(true)
    expect(isAddOnEnabled(null, 'alerts')).toBe(true)
    expect(isAddOnEnabled({ addOns: null }, 'alerts')).toBe(true)
    expect(enabledAddOnKeys({ addOns: 'nonsense' })).toBeNull()
  })

  it('switches off what is not listed, and everything with an empty list', () => {
    expect(isAddOnEnabled({ addOns: ['reports'] }, 'alerts')).toBe(false)
    expect(isAddOnEnabled({ addOns: ['reports'] }, 'reports')).toBe(true)
    expect(isAddOnEnabled({ addOns: [] }, 'reports')).toBe(false)
  })

  it('only accepts registered keys', () => {
    const validate = validateAddOnKeys((key) => key === 'alerts')

    expect(validate(undefined)).toBe(true)
    expect(validate(null)).toBe(true)
    expect(validate(['alerts'])).toBe(true)
    expect(validate(['alerts', 'xero'])).toBe('Unknown add-on: xero')
    expect(validate('alerts')).toMatch(/list of add-on keys/)
    expect(validate([1])).toMatch(/list of add-on keys/)
  })

  it('adds the setting to the tenants collection and to the single-tenant global', async () => {
    const base = { collections: [{ slug: 'users', fields: [] }], secret: 'x' } as unknown as Config
    const single = await payloadJobs()(base)
    const multi = await payloadJobs({ accountAuth: false, tenancy: 'multi' })({
      ...base,
      collections: [{ slug: 'users', fields: [] }, { slug: 'tenants', fields: [] }],
    } as unknown as Config)
    const named = (fields: unknown[]) =>
      fields.some((field) => (field as { name?: string }).name === ADD_ONS_FIELD)

    expect(named(single.globals?.[0]?.fields ?? [])).toBe(true)
    expect(named(multi.collections?.find((c) => c.slug === 'tenants')?.fields ?? [])).toBe(true)
  })

  it('hides a disabled add-on’s definitions for that tenant only', () => {
    const registry = newRegistry()
    registry.addOns.register({ key: 'alerts', label: 'Alerts' })
    registry.accountTabs.register({ addOn: 'alerts', dataEndpoint: '/x', key: 'my-alerts', label: 'Alerts', order: 20 })
    registry.accountTabs.register({ dataEndpoint: '/y', key: 'applications', label: 'Applications', order: 10 })
    registry.accountTabs.register({ addOn: 'typo', dataEndpoint: '/z', key: 'ghost', label: 'Ghost', order: 30 })

    const keys = (tenant: { addOns?: unknown }) =>
      forTenant(registry, registry.accountTabs, tenant).map((tab) => tab.key)

    expect(keys({})).toEqual(['applications', 'my-alerts'])
    expect(keys({ addOns: [] })).toEqual(['applications'])
  })

  it('is found on the config by add-on plugins, which fail clearly without it', async () => {
    const base = { collections: [{ slug: 'users', fields: [] }], secret: 'x' } as unknown as Config
    expect(() => getPayloadJobsRegistry(base)).toThrow(/Add payloadJobs\(\)/)

    const withJobs = await payloadJobs()(base)
    expect(getPayloadJobsRegistry(withJobs).context.tenancy).toBe('single')
  })
})

describe('checkout pipeline @S-147', () => {
  const context = (): CheckoutContext =>
    ({ currency: 'VUV', lines: [], tenantID: 1, total: 1000 }) as unknown as CheckoutContext

  it('runs applicable steps in order and skips the rest', async () => {
    const registry = newRegistry()
    const seen: string[] = []
    const step = (key: string, order: number, applies: boolean) =>
      registry.checkoutSteps.register({
        applies: () => applies,
        key,
        order,
        run: (ctx) => {
          seen.push(key)
          return { ...ctx, total: ctx.total - 100 }
        },
      })
    step('tax', 40, true)
    step('coupon', 10, true)
    step('credit', 20, false)

    const result = await runCheckoutSteps(registry, context(), {})

    expect(seen).toEqual(['coupon', 'tax'])
    expect(result.total).toBe(800)
  })

  it('leaves out steps of an add-on the tenant switched off', async () => {
    const registry = newRegistry()
    registry.addOns.register({ key: 'promo', label: 'Promo' })
    const run = vi.fn((ctx: CheckoutContext) => ctx)
    registry.checkoutSteps.register({ addOn: 'promo', applies: () => true, key: 'promo', order: 1, run })

    await runCheckoutSteps(registry, context(), { addOns: [] })
    expect(run).not.toHaveBeenCalled()

    await runCheckoutSteps(registry, context(), {})
    expect(run).toHaveBeenCalledOnce()
  })
})

describe('invoice sync and lifecycle hooks @S-147', () => {
  const orderEvent = { orderID: 7, payload: {} as never, status: 'paid', tenantID: 1 }

  it('tells adapters about orders, and one failing does not stop the next', async () => {
    const registry = newRegistry()
    const second = vi.fn()
    registry.invoiceSync.register({
      key: 'broken',
      label: 'Broken',
      onOrderStatusChanged: () => {
        throw new Error('xero down')
      },
    })
    registry.invoiceSync.register({ key: 'ok', label: 'OK', onOrderStatusChanged: second })

    const errors = await emitOrderEvent(registry, 'statusChanged', { ...orderEvent, from: 'pending' }, {})

    expect(errors.map((error) => error.message)).toEqual(['xero down'])
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ from: 'pending', status: 'paid' }))
  })

  it('runs lifecycle hooks for their events only, and not for a switched-off add-on', async () => {
    const registry = newRegistry()
    registry.addOns.register({ key: 'alerts', label: 'Alerts' })
    const onPublished = vi.fn()
    const onExpired = vi.fn()
    registry.jobLifecycle.register({ addOn: 'alerts', events: ['published'], handler: onPublished, key: 'alerts-published' })
    registry.jobLifecycle.register({ events: ['expired'], handler: onExpired, key: 'core-expired' })
    const context = {
      event: 'published' as const,
      job: {},
      jobsSlug: 'jobs',
      payload: {} as never,
      previousStatus: 'pending',
      tenantID: 1,
    }

    await emitJobLifecycle(registry, context, {})
    expect(onPublished).toHaveBeenCalledOnce()
    expect(onExpired).not.toHaveBeenCalled()

    await emitJobLifecycle(registry, context, { addOns: [] })
    expect(onPublished).toHaveBeenCalledOnce()
  })

  it('fires from the jobs afterChange hook only when the status actually changes', async () => {
    const registry = newRegistry()
    const handler = vi.fn()
    registry.jobLifecycle.register({ events: ['published', 'cancelled'], handler, key: 'spy' })
    const hook = jobLifecycleHook(registry, 'jobs')
    const req = {
      payload: {
        findByID: async () => ({ id: 1 }),
        logger: { error: vi.fn() },
      },
    } as unknown as PayloadRequest
    const run = (doc: Record<string, unknown>, previousDoc: Record<string, unknown>, operation = 'update') =>
      hook({ collection: {} as never, context: {}, doc, operation, previousDoc, req } as never)

    await run({ id: 1, status: 'published', tenant: 1 }, { status: 'pending' })
    await run({ id: 1, status: 'published', tenant: 1 }, { status: 'published' })
    await run({ id: 1, status: 'pending', tenant: 1 }, { status: 'draft' })
    await run({ id: 2, status: 'published', tenant: 1 }, {}, 'create')
    await run({ id: 1, status: 'cancelled', tenant: { id: 1 } }, { status: 'pending' })

    expect(handler.mock.calls.map(([ctx]) => [ctx.event, ctx.previousStatus, ctx.tenantID])).toEqual([
      ['published', 'pending', 1],
      ['published', null, 1],
      ['cancelled', 'pending', 1],
    ])
  })

  it('logs, and does not throw, when a lifecycle hook fails', async () => {
    const registry = newRegistry()
    registry.jobLifecycle.register({
      events: ['published'],
      handler: () => {
        throw new Error('boom')
      },
      key: 'bad',
    })
    const error = vi.fn()
    const req = { payload: { findByID: async () => ({}), logger: { error } } } as unknown as PayloadRequest

    await expect(
      jobLifecycleHook(registry, 'jobs')({
        doc: { id: 1, status: 'published', tenant: 1 },
        operation: 'update',
        previousDoc: { status: 'pending' },
        req,
      } as never),
    ).resolves.toBeTruthy()
    expect(error).toHaveBeenCalledOnce()
  })
})

describe('order events @S-102', () => {
  const tenants = [
    { addOns: null, id: 1 },
    { addOns: [], id: 2 },
  ]
  const reqWith = (error = vi.fn()) =>
    ({
      payload: {
        findByID: async ({ id }: { id: number }) => tenants.find((tenant) => tenant.id === id),
        logger: { error },
      },
    }) as unknown as PayloadRequest

  it('tells the invoice adapters about new orders and status changes only', async () => {
    const registry = newRegistry()
    registry.addOns.register({ key: 'xero', label: 'Xero' })
    const created = vi.fn()
    const changed = vi.fn()
    registry.invoiceSync.register({ addOn: 'xero', key: 'spy', label: 'Spy', onOrderCreated: created, onOrderStatusChanged: changed })
    const hook = orderEventHook(registry)
    const req = reqWith()
    const run = (doc: Record<string, unknown>, previousDoc: Record<string, unknown>, operation = 'update') =>
      hook({ collection: {} as never, context: {}, doc, operation, previousDoc, req } as never)

    await run({ id: 5, status: 'pending', tenant: 1 }, {}, 'create')
    await run({ id: 5, status: 'pending', tenant: 1 }, { status: 'pending' })
    await run({ id: 5, status: 'invoiced', tenant: { id: 1 } }, { status: 'pending' })
    // A tenant with the add-on switched off hears nothing.
    await run({ id: 6, status: 'pending', tenant: 2 }, {}, 'create')

    expect(created.mock.calls.map(([event]) => [event.orderID, event.status, event.tenantID])).toEqual([[5, 'pending', 1]])
    expect(changed.mock.calls.map(([event]) => [event.orderID, event.from, event.status])).toEqual([[5, 'pending', 'invoiced']])
    expect(created.mock.calls[0]![0].req).toBe(req)
  })

  it('logs, and never fails the order save, when an adapter throws', async () => {
    const registry = newRegistry()
    registry.invoiceSync.register({
      key: 'bad',
      label: 'Bad',
      onOrderCreated: () => {
        throw new Error('Xero is down')
      },
    })
    const error = vi.fn()
    const doc = { id: 5, status: 'pending', tenant: 1 }

    await expect(
      orderEventHook(registry)({ doc, operation: 'create', previousDoc: {}, req: reqWith(error) } as never),
    ).resolves.toBe(doc)
    expect(error).toHaveBeenCalledOnce()
  })
})

describe('add-on gate @S-147', () => {
  const tenants = [
    { addOns: ['alerts'], id: 1 },
    { addOns: [], id: 2 },
    { id: 3 },
  ]
  const reqWith = (extra: Record<string, unknown> = {}) =>
    ({
      payload: {
        find: async () => ({ docs: tenants }),
        findByID: async ({ id }: { id: number }) => tenants.find((tenant) => tenant.id === id),
        findGlobal: async () => ({ addOns: [] }),
        ...extra,
      },
    }) as unknown as PayloadRequest
  const gate = { key: 'alerts', registry: newRegistry() }

  it('narrows reads to the tenants that have the add-on on', async () => {
    const wrapped = gateCollectionAccess(gate, (() => true) as Access)
    expect(await wrapped({ req: reqWith() } as never)).toEqual({ tenant: { in: [1, 3] } })

    const scoped = gateCollectionAccess(gate, (() => ({ organisation: { equals: 5 } })) as Access)
    expect(await scoped({ req: reqWith() } as never)).toEqual({
      and: [{ organisation: { equals: 5 } }, { tenant: { in: [1, 3] } }],
    })
  })

  it('keeps a denial a denial, without asking the database', async () => {
    const find = vi.fn()
    const wrapped = gateCollectionAccess(gate, (() => false) as Access)

    expect(await wrapped({ req: reqWith({ find }) } as never)).toBe(false)
    expect(find).not.toHaveBeenCalled()
  })

  it('denies everything on a single-tenant site that switched the add-on off', async () => {
    const single = { key: 'alerts', registry: newRegistry('single') }
    const wrapped = gateCollectionAccess(single, (() => true) as Access)

    expect(await wrapped({ req: reqWith() } as never)).toBe(false)
    expect(
      await wrapped({ req: reqWith({ findGlobal: async () => ({}) }) } as never),
    ).toBe(true)
  })

  it('refuses writes for a tenant with the add-on off, and allows the rest', async () => {
    const guard = addOnWriteGuard(gate)
    const call = (tenant: number) =>
      guard({ collection: { slug: 'alert-subscriptions' }, data: { tenant }, req: reqWith() } as never)

    await expect(call(2)).rejects.toThrow()
    await expect(call(1)).resolves.toEqual({ tenant: 1 })
    await expect(call(3)).resolves.toEqual({ tenant: 3 })
  })

  it('answers 404 from a gated endpoint for a tenant with the add-on off', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const endpoint: Endpoint = { handler, method: 'get', path: '/alerts/confirm/:token' }
    const wrapped = gateEndpoint(gate, endpoint, (req) => (req as unknown as { tenant: number }).tenant)
    const call = (tenant: number) =>
      wrapped.handler({ ...reqWith(), tenant } as unknown as PayloadRequest)

    expect((await call(2)).status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
    expect((await call(1)).status).toBe(200)
    expect(wrapped.path).toBe(endpoint.path)
  })
})
