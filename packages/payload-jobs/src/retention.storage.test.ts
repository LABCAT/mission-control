import { r2Storage } from '@payloadcms/storage-r2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection } from './add-ons'
import {
  APPLICATION_FILES_SLUG,
  APPLICATIONS_SLUG,
  applicationFilesCollection,
  applicationsCollection,
} from './collections/applications'
import { jobsCollection } from './collections/jobs'
import { locationsCollection } from './collections/locations'
import { organisationsCollection } from './collections/organisations'
import { planCollection, withPlanRestrictionGuards } from './plans'
import { deleteApplicationData, deleteExpiredApplicationsTask, tenantRetentionField } from './retention'
import { taxonomyCollections } from './taxonomies'
import { bootTestPayload, type TestHarness } from './test'

/**
 * PJ-88: the daily task and the admin action must remove the CV *bytes* from R2, not just the
 * document rows. These tests upload real files through an `r2Storage` adapter over an
 * in-memory bucket, so a delete that never reaches the adapter's `handleDelete` leaves a key
 * behind and fails here.
 */
const NOW = new Date('2026-11-23T03:30:00.000Z')

const makeBucket = () => {
  const objects = new Map<string, Uint8Array>()
  const deleted: string[] = []

  const bucket = {
    createMultipartUpload: async () => {
      throw new Error('not used')
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key)
        deleted.push(key)
      }
    },
    get: async () => null,
    head: async (key: string) => (objects.has(key) ? ({ key } as never) : null),
    list: async () => ({ objects: [] }),
    put: async (key: string, value: unknown) => {
      objects.set(key, new Uint8Array(await new Response(value as BodyInit).arrayBuffer()))

      return {}
    },
    resumeMultipartUpload: () => {
      throw new Error('not used')
    },
  }

  return { bucket, deleted, objects }
}

const store = makeBucket()

describe('CV files leave R2 @S-300', () => {
  let harness: TestHarness
  const ids: Record<string, number> = {}
  let counter = 0

  const create = async (collection: string, data: Record<string, unknown>, file?: unknown) =>
    ((await harness.payload.create({ collection, data, file, overrideAccess: true } as never)) as { id: number }).id

  const cv = async (organisation: number, tenant: number): Promise<{ id: number; key: string }> => {
    const name = `cv-${++counter}.doc`
    // Payload sniffs the bytes: the OLE compound-file header is what a legacy .doc starts with.
    const data = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504, counter)])
    const id = await create(
      APPLICATION_FILES_SLUG,
      { organisation, tenant },
      { data, mimetype: 'application/x-cfb', name, size: data.length },
    )
    // The adapter files each upload under a generated folder, so find its key by file name.
    const key = [...store.objects.keys()].find((candidate) => candidate.endsWith(`/${name}`)) ?? ''

    return { id, key }
  }

  const apply = (job: number, file: number) =>
    create(APPLICATIONS_SLUG, {
      consentAt: new Date().toISOString(),
      cv: file,
      email: 'someone@example.invalid',
      job,
      name: 'Someone',
    })

  const closedJob = async (tenant: number, organisation: number, closedAt: string) => {
    const job = await create('jobs', { organisation, status: 'published', tenant, title: `Job ${++counter}` })
    await harness.payload.update({ collection: 'jobs', data: { status: 'expired' } as never, id: job, overrideAccess: true })
    await harness.payload.update({ collection: 'jobs', data: { expiresAt: closedAt } as never, id: job, overrideAccess: true })

    return job
  }

  const runTask = async (batchSize?: number) => {
    const task = deleteExpiredApplicationsTask({
      ...(batchSize ? { batchSize } : {}),
      clock: () => NOW,
      jobsSlug: 'jobs',
      tenancy: 'multi',
      tenantsSlug: 'tenants',
    })
    const handler = task.handler as unknown as (args: unknown) => Promise<{ output: Record<string, number> }>

    return (await handler({ req: { payload: harness.payload, user: null } as never })).output
  }

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [
        organisationsCollection({ mediaSlug: null, tenantScoped: true }),
        locationsCollection({ requireTenant: true }),
        ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
        planCollection(),
        addOnCollection(),
        jobsCollection({ tenantScoped: true }),
        applicationFilesCollection({ tenantScoped: true }),
        applicationsCollection({ tenantScoped: true }),
      ],
      storage: [r2Storage({ bucket: store.bucket as never, collections: { [APPLICATION_FILES_SLUG]: true } })],
      tenantData: () => ({ currency: 'VUV', retention: { applicationsMonths: 12 } }),
      tenantFields: [{ name: 'currency', type: 'text' }, tenantRetentionField()],
    })
    ids.org = await create('organisations', { name: 'Org', slug: 'org-r2', tenant: harness.tenantA.id })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('stores uploaded CVs in the bucket', async () => {
    const file = await cv(ids.org, harness.tenantA.id)

    expect(file.key).not.toBe('')
    expect(store.objects.has(file.key)).toBe(true)
  })

  it('removes the bytes of every expired CV from the bucket, across pages of one @S-300', async () => {
    const old = await closedJob(harness.tenantA.id, ids.org, '2025-01-01T00:00:00.000Z')
    const live = await create('jobs', {
      organisation: ids.org,
      status: 'published',
      tenant: harness.tenantA.id,
      title: 'Live',
    })
    const oldFiles = [await cv(ids.org, harness.tenantA.id), await cv(ids.org, harness.tenantA.id), await cv(ids.org, harness.tenantA.id)]
    const liveFile = await cv(ids.org, harness.tenantA.id)
    for (const file of oldFiles) await apply(old, file.id)
    await apply(live, liveFile.id)

    // batchSize 1 forces the id-cursor loops past their first page.
    expect(await runTask(1)).toMatchObject({ applicationsDeleted: 3, filesDeleted: 3 })

    for (const file of oldFiles) {
      expect(store.objects.has(file.key)).toBe(false)
      expect(store.deleted).toContain(file.key)
    }
    expect(store.objects.has(liveFile.key)).toBe(true)

    // A second run finds nothing and touches nothing.
    expect(await runTask(1)).toEqual({ applicationsDeleted: 0, filesDeleted: 0 })
    expect(store.objects.has(liveFile.key)).toBe(true)
  })

  it('removes the bytes on the admin action, and keeps a CV another application still uses @S-303', async () => {
    const job = await create('jobs', {
      organisation: ids.org,
      status: 'published',
      tenant: harness.tenantA.id,
      title: 'Live 2',
    })
    const own = await cv(ids.org, harness.tenantA.id)
    const shared = await cv(ids.org, harness.tenantA.id)
    const first = await apply(job, own.id)
    const second = await apply(job, shared.id)
    await apply(job, shared.id)
    const req = { payload: harness.payload, user: null } as never
    const load = async (id: number) =>
      (await harness.payload.findByID({ collection: APPLICATIONS_SLUG, depth: 0, id, overrideAccess: true })) as never

    expect(await deleteApplicationData({ application: await load(first), req })).toEqual({ filesDeleted: 1 })
    expect(store.objects.has(own.key)).toBe(false)

    expect(await deleteApplicationData({ application: await load(second), req })).toEqual({ filesDeleted: 0 })
    expect(store.objects.has(shared.key)).toBe(true)
  })
})
