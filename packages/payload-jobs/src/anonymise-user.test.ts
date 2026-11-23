import type { CollectionConfig, Field, Payload } from 'payload'

import type { MissionControlUser } from './access'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  anonymiseUser,
  blockUserHardDelete,
  canRemovePersonalData,
  removedUserEmail,
  USER_PURGE_CONTEXT,
  withPersonalDataRemoval,
} from './anonymise-user'
import { addOnCollection } from './add-ons'
import {
  APPLICATION_FILES_SLUG,
  applicationFilesCollection,
  applicationsCollection,
} from './collections/applications'
import { jobsCollection } from './collections/jobs'
import { locationsCollection } from './collections/locations'
import { organisationsCollection } from './collections/organisations'
import { couponCollection } from './coupons'
import { orderCollection } from './orders'
import { resolvePaymentProviders } from './payment-providers'
import { planCollection, withPlanRestrictionGuards } from './plans'
import { taxonomyCollections } from './taxonomies'
import { bootTestPayload, type TestHarness } from './test'

const ALERTS = 'alert-subscriptions'
const ORDERS = 'orders'

/** The fields the removal scrubs, on the harness's users collection. */
const userFields: Field[] = [
  { name: 'firstName', type: 'text' },
  { name: 'lastName', type: 'text' },
  { name: 'phone', type: 'text' },
  { name: 'legacyId', type: 'number' },
]

/** A stand-in for the alerts add-on's collection: an email and a tenant, nothing more. */
const alertSubscriptions = (): CollectionConfig => ({
  slug: ALERTS,
  access: { create: () => true, delete: () => true, read: () => true, update: () => true },
  fields: [
    { name: 'email', type: 'email', required: true },
    { name: 'confirmed', type: 'checkbox', defaultValue: false },
  ],
  versions: false,
})

type Doc = Record<string, any> & { id: number }

describe('personal data removal rules @S-311', () => {
  type Actor = MissionControlUser & { id: number; tenants: { role: string; tenant: number }[] }

  const superAdmin = { id: 1, role: 'super-admin', tenants: [] } as Actor
  const tenantAdmin = {
    id: 2,
    role: 'user',
    tenants: [{ role: 'tenant-admin', tenant: 7 }],
  } as Actor
  const member = { id: 3, role: 'user', tenants: [{ role: 'seeker', tenant: 7 }] } as Actor

  it('lets a super admin remove anyone but themselves', () => {
    expect(canRemovePersonalData({ target: member, user: superAdmin })).toBe(true)
    expect(canRemovePersonalData({ target: superAdmin, user: superAdmin })).toBe(false)
  })

  it('lets a site manager remove a member of their own site only', () => {
    expect(canRemovePersonalData({ target: member, user: tenantAdmin })).toBe(true)
    expect(
      canRemovePersonalData({
        target: { id: 4, role: 'user', tenants: [{ tenant: 8 }] },
        user: tenantAdmin,
      }),
    ).toBe(false)
  })

  it('never lets a site manager remove a super admin, and never acts while viewing as someone', () => {
    expect(canRemovePersonalData({ target: superAdmin, user: tenantAdmin })).toBe(false)
    expect(
      canRemovePersonalData({ target: member, user: { ...superAdmin, _viewAs: { by: 9 } } as never }),
    ).toBe(false)
  })

  it('refuses an anonymous caller and an ordinary member', () => {
    expect(canRemovePersonalData({ target: member, user: null })).toBe(false)
    expect(canRemovePersonalData({ target: member, user: member })).toBe(false)
  })

  it('builds a stable, non-personal address from the user id', () => {
    expect(removedUserEmail(42)).toBe('removed-user-42@removed.invalid')
  })

  it('adds the endpoint and the delete guard without adding a field', () => {
    const base: CollectionConfig = { slug: 'users', fields: [], versions: false }
    const wrapped = withPersonalDataRemoval(base, { usersSlug: 'users' })

    expect(wrapped.fields).toEqual([])
    expect(
      Array.isArray(wrapped.endpoints) ? wrapped.endpoints.map((endpoint) => endpoint.path) : [],
    ).toContain('/:id/remove-personal-data')
    expect(wrapped.hooks?.beforeDelete).toContain(blockUserHardDelete)
  })
})

describe('personal data removal in Postgres @S-311', () => {
  let harness: TestHarness
  const ids: Record<string, number> = {}
  const emails = {
    seeker: `seeker-${Date.now()}@example.invalid`,
    guest: `guest-${Date.now()}@example.invalid`,
    other: `other-${Date.now()}@example.invalid`,
  }

  const read = async (collection: string, id: number): Promise<Doc | null> =>
    (await harness.payload
      .findByID({ collection: collection as never, depth: 0, id: id as never, overrideAccess: true })
      .catch(() => null)) as Doc | null

  const count = async (collection: string, where: Record<string, unknown>): Promise<number> =>
    (
      await harness.payload.count({
        collection: collection as never,
        overrideAccess: true,
        where: where as never,
      })
    ).totalDocs

  const create = async (collection: string, data: Record<string, unknown>): Promise<number> =>
    Number(
      (
        await harness.payload.create({
          collection: collection as never,
          data: data as never,
          overrideAccess: true,
        })
      ).id,
    )

  const file = async (organisation: number, tenant: number, applicant?: number): Promise<number> =>
    Number(
      (
        await (harness.payload as Payload).db.create({
          collection: APPLICATION_FILES_SLUG as never,
          data: {
            applicant,
            filename: `cv-${Math.random().toString(36).slice(2, 10)}.pdf`,
            filesize: 10,
            mimeType: 'application/pdf',
            organisation,
            tenant,
          },
        })
      ).id,
    )

  const apply = (extra: Record<string, unknown>): Promise<number> =>
    create('applications', {
      consentAt: new Date().toISOString(),
      email: emails.seeker,
      job: ids.job,
      message: 'Please consider me',
      name: 'Sera Seeker',
      phone: '+678 555 1234',
      ...extra,
    })

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [
        organisationsCollection({ mediaSlug: null, tenantScoped: true }),
        locationsCollection({ requireTenant: true }),
        ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
        planCollection(),
        addOnCollection(),
        couponCollection(),
        jobsCollection({ tenantScoped: true }),
        applicationFilesCollection({ tenantScoped: true }),
        applicationsCollection({ tenantScoped: true }),
        orderCollection({
          isOrganisationOwner: () => false,
          paymentProviders: resolvePaymentProviders(),
        }),
        alertSubscriptions(),
      ],
      tenantData: () => ({ currency: 'VUV' }),
      tenantFields: [{ name: 'currency', type: 'text' }],
      userFields,
      wrapUsers: (collection) =>
        withPersonalDataRemoval(collection, { alertSubscriptionsSlug: ALERTS, usersSlug: 'users' }),
    })

    const tenant = harness.tenantA.id
    ids.organisation = await create('organisations', {
      name: 'Santo Bakery',
      slug: `bakery-${Date.now()}`,
      tenant,
    })
    ids.job = await create('jobs', {
      organisation: ids.organisation,
      status: 'published',
      tenant,
      title: 'Head Chef',
    })

    ids.seeker = await create('users', {
      email: emails.seeker,
      firstName: 'Sera',
      lastName: 'Seeker',
      password: 'test-password',
      phone: '+678 555 1234',
      role: 'user',
      tenants: [{ role: 'seeker', tenant }],
    })
    ids.other = await create('users', {
      email: emails.other,
      firstName: 'Other',
      password: 'test-password',
      role: 'user',
      tenants: [{ role: 'seeker', tenant }],
    })

    ids.cv = await file(ids.organisation, tenant, ids.seeker)
    ids.coverLetter = await file(ids.organisation, tenant, ids.seeker)
    ids.ownApplication = await apply({ applicant: ids.seeker, coverLetter: ids.coverLetter, cv: ids.cv })
    // A guest application from the same address: no applicant, but the same personal data.
    ids.guestCv = await file(ids.organisation, tenant)
    ids.guestApplication = await apply({ cv: ids.guestCv })

    ids.otherCv = await file(ids.organisation, tenant, ids.other)
    ids.otherApplication = await apply({
      applicant: ids.other,
      cv: ids.otherCv,
      email: emails.other,
      name: 'Other Person',
    })

    ids.subscription = await create(ALERTS, { email: emails.seeker, tenant })
    ids.otherSubscription = await create(ALERTS, { email: emails.other, tenant })

    // An invoice order: money records must survive the removal untouched.
    ids.order = await create(ORDERS, {
      currency: 'VUV',
      discount: 0,
      organisation: ids.organisation,
      paymentMethod: 'invoice',
      paymentProvider: 'invoice',
      subtotal: 5000,
      tax: 0,
      tenant,
      total: 5000,
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('removes the profile, applications, files and subscriptions, keeping the row @S-311', async () => {
    const result = await anonymiseUser({
      actorID: harness.superAdmin.id,
      alertSubscriptionsSlug: ALERTS,
      payload: harness.payload,
      reason: 'Email request, ticket 12',
      userID: ids.seeker,
    })

    expect(result.applicationsRemoved).toBe(2)
    expect(result.filesRemoved).toBe(3)
    expect(result.subscriptionsRemoved).toBe(1)
    expect(result.email).toBe(removedUserEmail(ids.seeker))

    const user = await read('users', ids.seeker)
    expect(user).not.toBeNull()
    expect(user?.email).toBe(removedUserEmail(ids.seeker))
    expect(user?.firstName ?? null).toBeNull()
    expect(user?.lastName ?? null).toBeNull()
    expect(user?.phone ?? null).toBeNull()
    expect(user?.tenants).toEqual([])

    expect(await count('applications', { email: { equals: emails.seeker } })).toBe(0)
    expect(await count(APPLICATION_FILES_SLUG, { id: { in: [ids.cv, ids.coverLetter, ids.guestCv] } })).toBe(0)
    expect(await count(ALERTS, { email: { equals: emails.seeker } })).toBe(0)
  })

  it('leaves another person’s data alone @S-311', async () => {
    expect(await read('applications', ids.otherApplication)).not.toBeNull()
    expect(await read(APPLICATION_FILES_SLUG, ids.otherCv)).not.toBeNull()
    expect(await read(ALERTS, ids.otherSubscription)).not.toBeNull()
    expect((await read('users', ids.other))?.email).toBe(emails.other)
  })

  it('keeps orders pointing at the same user id @S-311', async () => {
    const order = await read(ORDERS, ids.order)

    expect(order).not.toBeNull()
    expect(order?.total).toBe(5000)
    expect(order?.tenant).toBe(harness.tenantA.id)
  })

  it('cannot be signed into with the old password after removal @S-311', async () => {
    await expect(
      harness.payload.login({
        collection: 'users',
        data: { email: removedUserEmail(ids.seeker), password: 'test-password' },
      }),
    ).rejects.toThrow()
  })

  it('is idempotent: a second run removes nothing and keeps the anonymised row @S-311', async () => {
    const before = await read('users', ids.seeker)
    const result = await anonymiseUser({
      actorID: harness.superAdmin.id,
      alertSubscriptionsSlug: ALERTS,
      payload: harness.payload,
      userID: ids.seeker,
    })

    expect(result.applicationsRemoved).toBe(0)
    expect(result.filesRemoved).toBe(0)
    expect(result.subscriptionsRemoved).toBe(0)
    expect((await read('users', ids.seeker))?.email).toBe(before?.email)
  })

  it('writes an audit trail that does not keep the address it removed @S-311', async () => {
    const email = `audited-${Date.now()}@example.invalid`
    const userID = await create('users', {
      email,
      firstName: 'Audited',
      password: 'test-password',
      role: 'user',
      tenants: [],
    })

    // This harness has no audit-log collection, so the entry goes to the logger instead.
    const entries: unknown[] = []
    const spy = vi.spyOn(harness.payload.logger, 'info').mockImplementation((entry: unknown) => {
      entries.push(entry)
    })

    try {
      await anonymiseUser({ actorID: harness.superAdmin.id, payload: harness.payload, userID })
    } finally {
      spy.mockRestore()
    }

    const entry = entries.find(
      (candidate) => (candidate as { msg?: string }).msg === 'user.personal-data-removed',
    )
    expect(entry).toBeDefined()
    expect(JSON.stringify(entry)).not.toContain(email)
    expect(entry).toMatchObject({ actorID: String(harness.superAdmin.id), targetID: String(userID) })
  })

  it('refuses a hard delete, so orders never lose the user they point at @S-311', async () => {
    await expect(
      harness.payload.delete({ collection: 'users', id: ids.other, overrideAccess: true }),
    ).rejects.toThrow(/Users are never deleted/)

    expect(await read('users', ids.other)).not.toBeNull()
  })

  it('still allows a delete for teardown, which sets the purge context @S-311', async () => {
    const throwaway = await create('users', {
      email: `throwaway-${Date.now()}@example.invalid`,
      password: 'test-password',
      role: 'user',
      tenants: [],
    })

    await harness.payload.delete({
      collection: 'users',
      context: { [USER_PURGE_CONTEXT]: true },
      id: throwaway,
      overrideAccess: true,
    })

    expect(await read('users', throwaway)).toBeNull()
  })
})
