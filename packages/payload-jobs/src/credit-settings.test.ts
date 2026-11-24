import type { Field, Payload } from 'payload'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PACK_CREDIT_MODE,
  isPackCreditMode,
  PACK_CREDIT_MODES,
  packCreditGrantProblem,
  packCreditModeForOrder,
  packCreditsGrantingStatuses,
  tenantPackCreditMode,
  tenantPackCreditsField,
} from './credit-settings'

const field = tenantPackCreditsField() as Field & { defaultValue?: unknown; options?: { value: string }[] }

/** A Payload stub carrying only what the resolver reads, recording each lookup it makes. */
const stubPayload = ({
  global,
  globals = ['job-board-settings'],
  tenant,
  tenancy = 'multi',
  tenants = true,
}: {
  global?: Record<string, unknown>
  globals?: string[]
  tenant?: null | Record<string, unknown>
  tenancy?: 'multi' | 'single'
  tenants?: boolean
}): Payload & { calls: { collection: string; id: unknown }[]; globalsRead: string[] } => {
  const calls: { collection: string; id: unknown }[] = []
  const globalsRead: string[] = []

  return {
    calls,
    collections: tenants ? { tenants: {} } : {},
    config: {
      custom: { payloadJobs: { registry: { context: { settingsSlug: 'job-board-settings', tenancy, tenantsSlug: 'tenants' } } } },
      globals: globals.map((slug) => ({ slug })),
    },
    findByID: async ({ collection, id }: { collection: string; id: unknown }) => {
      calls.push({ collection, id })
      if (!tenant) throw new Error(`No ${collection} with id ${String(id)}`)
      return tenant
    },
    findGlobal: async ({ slug }: { slug: string }) => {
      globalsRead.push(slug)
      return global ?? {}
    },
    globalsRead,
  } as unknown as Payload & { calls: { collection: string; id: unknown }[]; globalsRead: string[] }
}

describe('pack credit settings (PJ-120)', () => {
  it('defaults to the old site’s rule: credits wait for payment', () => {
    expect(DEFAULT_PACK_CREDIT_MODE).toBe('on_payment')
    expect(PACK_CREDIT_MODES).toEqual(['on_payment', 'on_invoice'])
    expect(tenantPackCreditMode(undefined)).toBe('on_payment')
    expect(tenantPackCreditMode(null)).toBe('on_payment')
    expect(tenantPackCreditMode({})).toBe('on_payment')
    expect(tenantPackCreditMode({ packCreditsUsableAt: 'on_payment' })).toBe('on_payment')
    expect(tenantPackCreditMode({ packCreditsUsableAt: 'on_invoice' })).toBe('on_invoice')
  })

  it('keeps the legacy rule for a stored value it does not recognise', () => {
    expect(tenantPackCreditMode({ packCreditsUsableAt: 'weekly' })).toBe('on_payment')
    expect(isPackCreditMode('on_invoice')).toBe(true)
    expect(isPackCreditMode('on-delivery')).toBe(false)
    expect(isPackCreditMode(null)).toBe(false)
  })

  it('offers the setting as a per-tenant select, defaulted to on_payment', () => {
    expect(field).toMatchObject({ name: 'packCreditsUsableAt', type: 'select', defaultValue: 'on_payment' })
    expect(field.options?.map((option) => option.value)).toEqual(['on_payment', 'on_invoice'])
  })

  it('grants only on a paid order when credits wait for payment', () => {
    expect(packCreditsGrantingStatuses('on_payment')).toEqual(['paid'])
    expect(packCreditGrantProblem({ mode: 'on_payment', status: 'paid' })).toBeNull()
    for (const status of ['waiting_for_purchase', 'pending', 'invoiced', 'cancelled', 'failed']) {
      expect(packCreditGrantProblem({ mode: 'on_payment', status })).toMatch(/when the order is paid/)
    }
  })

  it('grants on invoice or payment when credits follow the invoice', () => {
    expect(packCreditsGrantingStatuses('on_invoice')).toEqual(['invoiced', 'paid'])
    expect(packCreditGrantProblem({ mode: 'on_invoice', status: 'invoiced' })).toBeNull()
    expect(packCreditGrantProblem({ mode: 'on_invoice', status: 'paid' })).toBeNull()
    for (const status of ['waiting_for_purchase', 'pending', 'cancelled', 'failed']) {
      expect(packCreditGrantProblem({ mode: 'on_invoice', status })).toBe(`A ${status} order grants no credits`)
    }
  })

  it('treats a missing status as one that grants nothing', () => {
    for (const mode of PACK_CREDIT_MODES) {
      expect(packCreditGrantProblem({ mode, status: undefined })).toBe('An order with no status grants no credits')
      expect(packCreditGrantProblem({ mode, status: null })).toBe('An order with no status grants no credits')
      expect(packCreditGrantProblem({ mode, status: '' })).toBe('An order with no status grants no credits')
    }
  })
})

describe('resolving the mode for an order (PJ-120)', () => {
  it('reads the multi-tenant setting from the order’s own tenant', async () => {
    const payload = stubPayload({ tenant: { packCreditsUsableAt: 'on_invoice' } })

    expect(await packCreditModeForOrder({ order: { tenant: 7 }, payload })).toBe('on_invoice')
    expect(payload.calls).toEqual([{ collection: 'tenants', id: 7 }])
    expect(payload.globalsRead).toEqual([])
  })

  it('defaults to on_payment for a tenant that never set it, or stored something unknown', async () => {
    for (const tenant of [{}, { packCreditsUsableAt: null }, { packCreditsUsableAt: 'weekly' }]) {
      const payload = stubPayload({ tenant })
      expect(await packCreditModeForOrder({ order: { tenant: 7 }, payload })).toBe('on_payment')
    }
  })

  it('does not look up a tenant for an order without one, or a config without the collection', async () => {
    const noTenant = stubPayload({ tenant: { packCreditsUsableAt: 'on_invoice' } })
    expect(await packCreditModeForOrder({ order: {}, payload: noTenant })).toBe('on_payment')
    expect(noTenant.calls).toEqual([])

    const noCollection = stubPayload({ tenant: { packCreditsUsableAt: 'on_invoice' }, tenants: false })
    expect(await packCreditModeForOrder({ order: { tenant: 7 }, payload: noCollection })).toBe('on_payment')
    expect(noCollection.calls).toEqual([])
  })

  it('reads the single-tenant setting from the settings global', async () => {
    const payload = stubPayload({ global: { packCreditsUsableAt: 'on_invoice' }, tenancy: 'single' })
    expect(await packCreditModeForOrder({ order: {}, payload })).toBe('on_invoice')
    expect(payload.globalsRead).toEqual(['job-board-settings'])

    const unset = stubPayload({ tenancy: 'single' })
    expect(await packCreditModeForOrder({ order: { tenant: 7 }, payload: unset })).toBe('on_payment')
  })

  it('defaults to on_payment when a single-tenant config has no settings global', async () => {
    const payload = stubPayload({ globals: [], tenancy: 'single' })
    expect(await packCreditModeForOrder({ order: {}, payload })).toBe('on_payment')
    expect(payload.globalsRead).toEqual([])
  })
})
