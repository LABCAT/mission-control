import type { CollectionConfig, Field } from 'payload'
import type { ReactElement, ReactNode } from 'react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection } from '../add-ons'
import { JOBS_SLUG, jobsCollection } from '../collections/jobs'
import { locationsCollection } from '../collections/locations'
import { organisationsCollection } from '../collections/organisations'
import { planCollection, withPlanRestrictionGuards } from '../plans'
import { taxonomyCollections } from '../taxonomies'
import { bootTestPayload, type TestHarness } from '../test'
import { orderCollection } from '../orders'
import { SiteManagerDashboard } from './SiteManagerDashboard'

const tenantFields: Field[] = [{ name: 'currency', type: 'text' }]

const Orders: CollectionConfig = orderCollection({ couponsEnabled: false })

/** Every piece of text an element tree renders, including the props this dashboard passes. */
const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')

  const { props } = node as ReactElement<Record<string, unknown>>
  const own = Object.entries(props)
    .filter(([key]) => key !== 'children' && key !== 'style' && key !== 'aria-label')
    .flatMap(([, value]) => (typeof value === 'string' || typeof value === 'number' ? [String(value)] : []))

  return [...own, textOf(props.children as ReactNode)].join(' ')
}

const render = async (props: Record<string, unknown>): Promise<ReactNode> =>
  (await SiteManagerDashboard({
    ...props,
  } as never)) as ReactNode

describe('site manager dashboard view @S-117', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [
        Orders,
        organisationsCollection({ mediaSlug: null, tenantScoped: true }),
        locationsCollection({ requireTenant: true }),
        ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
        planCollection(),
        addOnCollection(),
        jobsCollection({ tenantScoped: true }),
      ],
      tenantData: () => ({ currency: 'VUV' }),
      tenantFields,
    })

    const org = (await harness.payload.create({
      collection: 'organisations',
      data: { name: 'Org A', slug: 'org-a', tenant: harness.tenantA.id },
      overrideAccess: true,
    })) as { id: number }
    const orgB = (await harness.payload.create({
      collection: 'organisations',
      data: { name: 'Org B', slug: 'org-b', tenant: harness.tenantB.id },
      overrideAccess: true,
    })) as { id: number }

    await harness.payload.create({
      collection: JOBS_SLUG,
      data: {
        organisation: org.id,
        status: 'pending',
        tenant: harness.tenantA.id,
        title: 'Pending A',
      },
      overrideAccess: true,
    })
    await harness.payload.create({
      collection: JOBS_SLUG,
      data: {
        organisation: orgB.id,
        status: 'pending',
        tenant: harness.tenantB.id,
        title: 'Pending B',
      },
      overrideAccess: true,
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('renders the active tenant’s pending jobs and orders for a site manager @S-148', async () => {
    const view = await render({ payload: harness.payload, user: harness.tenantAdminA })
    const text = textOf(view)

    expect(text).toContain('Pending A')
    expect(text).toContain('Pending jobs')
    expect(text).toContain('Recent orders')
    // Never another tenant's job, even though this site manager could not read it either way.
    expect(text).not.toContain('Pending B')
  })

  it('renders nothing for a super admin, whose dashboard stays Payload’s own', async () => {
    expect(await render({ payload: harness.payload, user: harness.superAdmin })).toBeNull()
  })

  it('renders nothing for a signed-out visitor or a user without a tenant role', async () => {
    expect(await render({ payload: harness.payload, user: null })).toBeNull()
    expect(
      await render({
        payload: harness.payload,
        user: { id: 99, role: 'user', tenants: [{ role: 'employer', tenant: harness.tenantA.id }] },
      }),
    ).toBeNull()
  })
})
