import { describe, expect, it } from 'vitest'

import {
  dispatchNotifications,
  EMAIL_DEFER_CONTEXT,
  formatMoney,
  jobContentChanged,
  planJobEmails,
  planOrderEmails,
  planOrganisationEmails,
  type NotificationContext,
} from './notifications'
import { BUILT_IN_EMAIL_EVENTS } from './events'

const ctx: NotificationContext = {
  adminEmail: 'admin@site.test',
  employer: { email: 'boss@brew.test', firstName: 'Bo' },
  order: { currency: 'VUV', id: 9, paymentMethod: 'invoice', status: 'invoiced', total: 3900 },
  organisationName: 'Brew',
  owner: { email: 'owner@brew.test', firstName: 'Olu' },
}
const job = { id: 5, status: 'pending', tenant: 1, title: 'Cook', updatedAt: 't1' }

describe('job emails @S-365', () => {
  it('sends ONE submitted email to the employer, with the order inside, and one to the admin', () => {
    const out = planJobEmails(job, { ...job, status: 'draft' }, ctx)

    expect(out.map((entry) => [entry.event, entry.to])).toEqual([
      ['job-submitted', 'boss@brew.test'],
      ['job-submitted-admin', 'admin@site.test'],
    ])
    expect(out[0]?.doc).toMatchObject({ orderNumber: '9', orderStatus: 'invoiced', title: 'Cook' })
    expect(out[0]?.doc.orderTotal).toMatch(/3,?900/)
  })

  it('copies the billing address of an invoice-me organisation, and only that one @S-368', () => {
    const withBilling = { ...ctx, billingEmail: 'accounts@brew.test' }
    expect(planJobEmails(job, null, withBilling).map((entry) => entry.to)).toEqual([
      'boss@brew.test',
      'accounts@brew.test',
      'admin@site.test',
    ])
    const card = { ...withBilling, order: { ...ctx.order!, paymentMethod: 'card' } }
    expect(planJobEmails(job, null, card).map((entry) => entry.to)).toEqual(['boss@brew.test', 'admin@site.test'])
  })

  it('falls back to the organisation owner when the creator is unknown, and skips the admin when none is set', () => {
    const out = planJobEmails(job, null, { ...ctx, adminEmail: null, employer: null })
    expect(out.map((entry) => [entry.event, entry.to])).toEqual([['job-submitted', 'owner@brew.test']])
  })

  it('sends "live" when a job is published, once', () => {
    const live = { ...job, status: 'published' }
    expect(planJobEmails(live, job, ctx).map((entry) => [entry.event, entry.to])).toEqual([['job-approved', 'boss@brew.test']])
    expect(planJobEmails(live, { ...live }, ctx)).toEqual([])
  })

  it('tells the admin when an employer edits a job that is waiting, but not for system or bookkeeping saves', () => {
    const edited = { ...job, title: 'Head cook', updatedAt: 't2' }
    expect(planJobEmails(edited, job, ctx).map((entry) => entry.event)).toEqual(['job-edited-pending'])
    expect(planJobEmails(edited, job, ctx, { system: true })).toEqual([])
    expect(planJobEmails({ ...job, views: 4, updatedAt: 't3' }, job, ctx)).toEqual([])
    expect(jobContentChanged({ ...job, order: 3 }, job)).toBe(false)
  })

  it('has a distinct key for every transition, so a repeat is recognised', () => {
    const a = planJobEmails(job, null, ctx).map((entry) => entry.key)
    expect(new Set(a).size).toBe(a.length)
    expect(planJobEmails(job, null, ctx).map((entry) => entry.key)).toEqual(a)
  })
})

describe('order emails @S-110', () => {
  const order = { currency: 'VUV', id: 9, paymentMethod: 'invoice', status: 'pending', tenant: 1, total: 3900 }

  it('sends nothing for an order that comes with a job (the job email covers it)', () => {
    expect(planOrderEmails(order, null, ctx, { hasJobs: true })).toEqual([])
  })

  it('sends "order created" to the owner (and billing) and the admin for an order with no job', () => {
    const out = planOrderEmails(order, null, { ...ctx, billingEmail: 'accounts@brew.test' }, { hasJobs: false })
    expect(out.map((entry) => [entry.event, entry.to])).toEqual([
      ['order-created', 'owner@brew.test'],
      ['order-created', 'accounts@brew.test'],
      ['order-created-admin', 'admin@site.test'],
    ])
  })

  it('sends one email when an order is paid or cancelled, none for other moves', () => {
    const paid = { ...order, status: 'paid' }
    expect(planOrderEmails(paid, order, ctx, { hasJobs: true }).map((entry) => [entry.event, entry.to])).toEqual([['order-paid', 'owner@brew.test']])
    expect(planOrderEmails({ ...order, status: 'cancelled' }, order, ctx, { hasJobs: false }).map((entry) => entry.event)).toEqual(['order-cancelled'])
    expect(planOrderEmails({ ...order, status: 'invoiced' }, order, ctx, { hasJobs: false })).toEqual([])
    expect(planOrderEmails(paid, paid, ctx, { hasJobs: false })).toEqual([])
  })
})

describe('organisation page emails @S-367', () => {
  const organisation = { id: 3, listingRequested: false, pageEnabled: false, tenant: 1 }

  it('tells the admin when a page is requested and the owner when it is approved, each once', () => {
    const requested = { ...organisation, listingRequested: true }
    expect(planOrganisationEmails(requested, organisation, ctx).map((entry) => [entry.event, entry.to])).toEqual([
      ['organisation-page-requested', 'admin@site.test'],
    ])
    const approved = { ...requested, pageEnabled: true }
    expect(planOrganisationEmails(approved, requested, ctx).map((entry) => [entry.event, entry.to])).toEqual([
      ['organisation-page-approved', 'owner@brew.test'],
    ])
    expect(planOrganisationEmails(approved, approved, ctx)).toEqual([])
  })
})

describe('dispatch @S-366', () => {
  it('holds emails while a transaction may roll back, and never queues the same key twice in a request', async () => {
    const held: unknown[] = []
    const req = { context: { [EMAIL_DEFER_CONTEXT]: held }, payload: {} } as never
    const planned = planJobEmails(job, null, ctx)

    await dispatchNotifications(req, planned, 1)
    await dispatchNotifications(req, planned, 1)

    expect(held).toHaveLength(planned.length)
  })

  it('formats money from minor units and the currency code', () => {
    expect(formatMoney(3900, 'VUV')).toMatch(/3,?900/)
    expect(formatMoney(1250, 'NZD')).toMatch(/12\.50/)
    expect(formatMoney(null, 'NZD')).toBe('')
  })

  it('declares an event with variables for everything the plans send', () => {
    const slugs = BUILT_IN_EMAIL_EVENTS.map((event) => event.slug)
    for (const slug of [
      'job-submitted', 'job-submitted-admin', 'job-edited-pending', 'job-approved', 'order-created', 'order-created-admin',
      'order-paid', 'order-cancelled', 'organisation-page-requested', 'organisation-page-approved',
    ]) {
      expect(slugs).toContain(slug)
    }
    for (const event of BUILT_IN_EMAIL_EVENTS) {
      expect(event.defaultBody.length).toBeGreaterThan(0)
      const keys = new Set(event.variables.map((variable) => variable.key))
      for (const paragraph of event.defaultBody) {
        for (const part of paragraph) if (typeof part !== 'string') expect(keys.has(part.variable), `${event.slug}: ${part.variable}`).toBe(true)
      }
    }
  })
})
