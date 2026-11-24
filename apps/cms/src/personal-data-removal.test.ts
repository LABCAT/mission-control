import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { buildConfig, createPayloadRequest, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  payloadJobs,
  REMOVE_PERSONAL_DATA_CSRF_HEADER,
  REMOVE_PERSONAL_DATA_CSRF_VALUE,
  removePersonalDataEndpoint,
  removedUserEmail,
} from '@mission-control/payload-jobs'
import { ALERT_SUBSCRIPTIONS_SLUG, payloadJobsAlerts } from '@mission-control/payload-jobs-alerts'

import { Documents } from './collections/Documents'
import { Folders } from './collections/Folders'
import { Media } from './collections/Media'
import { SiteKeys } from './collections/SiteKeys'
import { Tags } from './collections/Tags'
import { Tenants } from './collections/Tenants'
import { Users } from './collections/Users'
import { payloadJobsCollectionOptions, payloadJobsCollectionSlugs } from './job-board-slugs'
import { multiTenantOptionsFor } from './tenancy'

type Caller = { id: number; role: 'super-admin' | 'user'; tenants: { role: string; tenant: number }[] }

/**
 * The removal against the CMS's real Users collection, whose credential guard
 * (`preventTenantAdminCredentialChanges`) stops a site manager changing someone's email or
 * password. The package harness has no such guard, so only this test sees it @S-311.
 */
describe('personal data removal in the CMS config @S-311', () => {
  let payload: Payload
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const ids: Record<string, number> = {}
  const email = (name: string) => `${name}-${runId}@example.invalid`

  const call = async (actor: Caller, userID: number) => {
    const req = await createPayloadRequest({ payload, user: actor as never })
    Object.assign(req, {
      headers: new Headers({
        [REMOVE_PERSONAL_DATA_CSRF_HEADER]: REMOVE_PERSONAL_DATA_CSRF_VALUE,
      }),
      json: async () => ({ reason: 'ticket 1' }),
      routeParams: { id: String(userID) },
    })

    return removePersonalDataEndpoint({ alertSubscriptionsSlug: ALERT_SUBSCRIPTIONS_SLUG }).handler(
      req as never,
    )
  }

  const emailOf = async (id: number) =>
    ((await payload.findByID({ collection: 'users', id, overrideAccess: true })) as { email: string })
      .email

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL')

    const config = await buildConfig({
      admin: { user: 'users' },
      auth: { passwordHashIterations: 100000 },
      collections: [Users, Media, Folders, Tags, Tenants, SiteKeys, Documents],
      db: postgresAdapter({
        pool: { connectionString: process.env.TEST_DATABASE_URL, max: 10 },
        push: true,
        schemaName: 'personal_data_removal',
      }),
      editor: lexicalEditor(),
      plugins: [
        payloadJobs({
          alertSubscriptionsSlug: ALERT_SUBSCRIPTIONS_SLUG,
          collections: payloadJobsCollectionOptions,
          tenancy: 'multi',
        }),
        payloadJobsAlerts({ slug: ALERT_SUBSCRIPTIONS_SLUG }),
        multiTenantPlugin(multiTenantOptionsFor(payloadJobsCollectionSlugs)),
      ],
      secret: 'test-secret',
    })
    process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'
    payload = await getPayload({ config, key: `personal-data-removal-${runId}` })

    const tenant = async (slug: string) =>
      Number(
        (
          await payload.create({
            collection: 'tenants',
            data: {
              adminEmail: 'admin@example.invalid',
              currency: 'VUV',
              currencyMinorUnits: 0,
              defaultLocale: 'en',
              emailFromAddress: 'jobs@example.invalid',
              emailFromName: 'Jobs',
              locales: [{ locale: 'en' }],
              name: slug,
              slug: `${slug}-${runId}`,
              taxLabel: 'VAT',
              timezone: 'Pacific/Efate',
            } as never,
            overrideAccess: true,
          })
        ).id,
      )
    const user = async (name: string, data: Record<string, unknown>) =>
      Number(
        (
          await payload.create({
            collection: 'users',
            data: { email: email(name), password: 'test-password', ...data } as never,
            overrideAccess: true,
          })
        ).id,
      )

    ids.a = await tenant('removal-a')
    ids.b = await tenant('removal-b')
    // First user of an empty database becomes the super admin, so create one up front.
    ids.superAdmin = await user('super', { role: 'super-admin', tenants: [] })
    ids.manager = await user('manager', {
      role: 'user',
      tenants: [{ role: 'tenant-admin', tenant: ids.a }],
    })
    ids.member = await user('member', { role: 'user', tenants: [{ role: 'seeker', tenant: ids.a }] })
    ids.shared = await user('shared', {
      role: 'user',
      tenants: [
        { role: 'seeker', tenant: ids.a },
        { role: 'tenant-admin', tenant: ids.b },
      ],
    })
  })

  afterAll(async () => {
    if (payload) await payload.destroy()
  })

  const managerCaller = (): Caller => ({
    id: ids.manager,
    role: 'user',
    tenants: [{ role: 'tenant-admin', tenant: ids.a }],
  })

  it('lets a site manager remove a member of their own site, despite the credential guard', async () => {
    const response = await call(managerCaller(), ids.member)

    expect(response.status).toBe(200)
    expect(await emailOf(ids.member)).toBe(removedUserEmail(ids.member))
  })

  it('refuses a site manager removing someone who also belongs to another site', async () => {
    const before = await emailOf(ids.shared)

    await expect(call(managerCaller(), ids.shared)).rejects.toThrow()
    expect(await emailOf(ids.shared)).toBe(before)
  })
})
