import type { Field, NumberField, Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection } from '../add-ons'
import { planCollection, withPlanRestrictionGuards } from '../plans'
import { taxonomyCollections } from '../taxonomies'
import { bootTestPayload, type TestHarness } from '../test'
import {
  APPLICATION_FILES_SLUG,
  APPLICATIONS_SLUG,
  applicationDeleteAccess,
  applicationFilesCollection,
  applicationNoWriteAccess,
  applicationReadAccess,
  applicationsCollection,
  blockDeleteWhileReferencedByApplications,
} from './applications'
import { jobsCollection } from './jobs'
import { locationsCollection } from './locations'
import { organisationsCollection } from './organisations'

const tenantFields: Field[] = [
  { name: 'currency', type: 'text' },
  { name: 'isAggregate', type: 'checkbox', defaultValue: false },
]

const as = (user: unknown) => ({ overrideAccess: false, user: user as never })

type Actor = {
  collection: 'users'
  id: number
  organisation?: number
  role: 'super-admin' | 'user'
  tenants: { role: string; tenant: number }[]
}

const reqFor = (user: unknown) => ({ req: { user } }) as never

describe('application access functions @S-052', () => {
  const employer = {
    id: 7,
    organisation: 11,
    role: 'user',
    tenants: [{ role: 'employer', tenant: 1 }],
  }
  const read = (tenantScoped: boolean, user: unknown) =>
    applicationReadAccess(tenantScoped, 'applicant')(reqFor(user)) as unknown

  it('denies anonymous callers and site keys', () => {
    expect(read(true, null)).toBe(false)
  })

  it('scopes an employer to their organisation inside the tenants where they are an employer, and an applicant to their own', () => {
    expect(read(true, employer)).toEqual({
      or: [
        { and: [{ organisation: { equals: 11 } }, { tenant: { in: [1] } }] },
        { applicant: { equals: 7 } },
      ],
    })
  })

  it('gives staff their tenants and a seeker only their own applications', () => {
    expect(read(true, { id: 3, role: 'user', tenants: [{ role: 'editor', tenant: 2 }] })).toEqual({
      or: [{ tenant: { in: [2] } }, { applicant: { equals: 3 } }],
    })
    expect(read(true, { id: 4, role: 'user', tenants: [{ role: 'seeker', tenant: 2 }] })).toEqual({
      applicant: { equals: 4 },
    })
  })

  it('lets nobody create or update over the API, and only admins delete', () => {
    expect(applicationNoWriteAccess({} as never)).toBe(false)

    const del = (user: unknown) => applicationDeleteAccess(true)(reqFor(user)) as unknown
    expect(del({ id: 1, role: 'super-admin', tenants: [] })).toBe(true)
    expect(del({ id: 2, role: 'user', tenants: [{ role: 'tenant-admin', tenant: 5 }] })).toEqual({
      tenant: { in: [5] },
    })
    expect(del({ id: 3, role: 'user', tenants: [{ role: 'editor', tenant: 5 }] })).toBe(false)
    expect(del({ id: 4, role: 'user', organisation: 1, tenants: [{ role: 'employer', tenant: 5 }] })).toBe(false)
    expect(del(null)).toBe(false)
  })
})

describe('applications collection config @S-052', () => {
  it('has no versions, a required CV and job, and keeps the files in a separate collection', () => {
    const config = applicationsCollection({ tenantScoped: true })
    const field = (name: string) => config.fields.find((f) => 'name' in f && f.name === name)

    expect(config.versions).toBe(false)
    expect(field('cv')).toMatchObject({ relationTo: APPLICATION_FILES_SLUG, required: true })
    expect(field('job')).toMatchObject({ required: true })
    expect(field('consentAt')).toMatchObject({ required: true })
    expect(field('message')).toMatchObject({ type: 'textarea' })
  })

  it('has an optional indexed legacyId for the WordPress importer', () => {
    const config = applicationsCollection({ tenantScoped: true })
    const legacyId = config.fields.find((f) => 'name' in f && f.name === 'legacyId') as
      | NumberField
      | undefined

    expect(legacyId).toMatchObject({ index: true, type: 'number' })
    expect(legacyId?.required).toBeFalsy()
  })

  it('accepts only PDF and Word files on the file collection', () => {
    const files = applicationFilesCollection({ tenantScoped: true })

    expect(files.upload).toMatchObject({ mimeTypes: expect.arrayContaining(['application/pdf']) })
    expect(JSON.stringify(files.upload)).not.toContain('image/')
  })
})

describe('applications in Postgres @S-052', () => {
  let harness: TestHarness
  const ids: Record<string, number> = {}
  const users = {} as Record<'editorA' | 'employerA' | 'employerA2' | 'seekerA' | 'applicantA', Actor>

  const create = async (collection: string, data: Record<string, unknown>) =>
    ((await harness.payload.create({ collection, data, overrideAccess: true } as never)) as { id: number }).id

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

  const apply = (extra: Record<string, unknown> = {}) =>
    create(APPLICATIONS_SLUG, {
      consentAt: new Date().toISOString(),
      cv: ids.cvA,
      email: 'someone@example.invalid',
      job: ids.jobA,
      message: 'Hello',
      name: 'Someone',
      ...extra,
    })

  const visible = async (user: unknown): Promise<number[]> => {
    try {
      const { docs } = await harness.payload.find({
        collection: APPLICATIONS_SLUG,
        depth: 0,
        limit: 100,
        ...as(user),
      } as never)
      return docs.map((doc) => Number(doc.id)).sort((a, b) => a - b)
    } catch (error) {
      if ((error as { status?: number }).status === 403) return []
      throw error
    }
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
      tenantData: (which) => ({ currency: which === 'A' ? 'VUV' : 'NZD' }),
      tenantFields,
    })
    const { tenantA, tenantB } = harness

    ids.orgA = await create('organisations', { name: 'Org A', slug: 'org-a', tenant: tenantA.id })
    ids.orgA2 = await create('organisations', { name: 'Org A2', slug: 'org-a2', tenant: tenantA.id })
    ids.orgB = await create('organisations', { name: 'Org B', slug: 'org-b', tenant: tenantB.id })

    const makeUser = async (label: string, tenants: Actor['tenants'], organisation?: number): Promise<Actor> => {
      const id = await create('users', {
        email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants,
      })
      return { collection: 'users', id, organisation, role: 'user', tenants }
    }
    users.editorA = await makeUser('editor-a', [{ role: 'editor', tenant: tenantA.id }])
    users.employerA = await makeUser('employer-a', [{ role: 'employer', tenant: tenantA.id }], ids.orgA)
    users.employerA2 = await makeUser('employer-a2', [{ role: 'employer', tenant: tenantA.id }], ids.orgA2)
    users.seekerA = await makeUser('seeker-a', [{ role: 'seeker', tenant: tenantA.id }])
    users.applicantA = await makeUser('applicant-a', [{ role: 'seeker', tenant: tenantA.id }])

    ids.jobA = await create('jobs', { organisation: ids.orgA, status: 'published', tenant: tenantA.id, title: 'Job A' })
    ids.jobA2 = await create('jobs', { organisation: ids.orgA2, status: 'published', tenant: tenantA.id, title: 'Job A2' })
    ids.jobB = await create('jobs', { organisation: ids.orgB, status: 'published', tenant: tenantB.id, title: 'Job B' })

    ids.cvA = await file(ids.orgA, tenantA.id)
    ids.cvA2 = await file(ids.orgA2, tenantA.id)
    ids.cvB = await file(ids.orgB, tenantB.id)
    ids.cvOwn = await file(ids.orgA, tenantA.id, users.applicantA.id)

    ids.appA = await apply()
    ids.appA2 = await apply({ cv: ids.cvA2, job: ids.jobA2 })
    ids.appB = await apply({ cv: ids.cvB, job: ids.jobB })
    ids.appOwn = await apply({ applicant: users.applicantA.id, cv: ids.cvOwn })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('copies the organisation and tenant from the job, whatever the request says', async () => {
    const stored = (await harness.payload.findByID({
      collection: APPLICATIONS_SLUG,
      depth: 0,
      id: ids.appA,
      overrideAccess: true,
    } as never)) as unknown as { organisation: number; tenant: number }
    expect(stored.organisation).toBe(ids.orgA)
    expect(stored.tenant).toBe(harness.tenantA.id)

    const lied = await apply({ organisation: ids.orgB, tenant: harness.tenantB.id })
    const after = (await harness.payload.findByID({
      collection: APPLICATIONS_SLUG,
      depth: 0,
      id: lied,
      overrideAccess: true,
    } as never)) as unknown as { organisation: number; tenant: number }
    expect(after.organisation).toBe(ids.orgA)
    expect(after.tenant).toBe(harness.tenantA.id)
  })

  it('requires a CV, a consent date and a real job', async () => {
    await expect(apply({ cv: undefined })).rejects.toThrow()
    await expect(apply({ consentAt: undefined })).rejects.toThrow()
    await expect(apply({ job: 999_999 })).rejects.toThrow()
  })

  it('refuses a CV that was uploaded for another organisation', async () => {
    await expect(apply({ cv: ids.cvB })).rejects.toThrow(/field is invalid: cv/)
    await expect(apply({ cv: ids.cvA2 })).rejects.toThrow(/field is invalid: cv/)
  })

  it('lets an employer read only their own organisation’s applications', async () => {
    const own = await visible(users.employerA)
    expect(own).toContain(ids.appA)
    expect(own).not.toContain(ids.appA2)
    expect(own).not.toContain(ids.appB)
    expect(await visible(users.employerA2)).toEqual([ids.appA2])
  })

  it('lets site managers read their tenant and no other, and a super admin read all', async () => {
    const tenantA = await visible(harness.tenantAdminA)
    expect(tenantA).toEqual(expect.arrayContaining([ids.appA, ids.appA2, ids.appOwn]))
    expect(tenantA).not.toContain(ids.appB)
    expect(await visible(users.editorA)).toEqual(tenantA)
    expect(await visible(harness.tenantAdminB)).toEqual([ids.appB])
    expect(await visible(harness.superAdmin)).toEqual(expect.arrayContaining([ids.appA, ids.appB]))
  })

  it('lets an applicant read their own application and never another’s', async () => {
    expect(await visible(users.applicantA)).toEqual([ids.appOwn])
    expect(await visible(users.seekerA)).toEqual([])
  })

  it('gives anonymous callers nothing, even with a site key header', async () => {
    await expect(
      harness.payload.find({
        collection: APPLICATIONS_SLUG,
        overrideAccess: false,
        req: { headers: new Headers({ 'x-site-key': 'sk_anything' }) } as never,
      } as never),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('keeps the CV files as private as the applications', async () => {
    const files = async (user: unknown) =>
      (
        await harness.payload.find({
          collection: APPLICATION_FILES_SLUG as never,
          depth: 0,
          limit: 100,
          ...as(user),
        } as never)
      ).docs
        .map((doc) => Number(doc.id))
        .sort((a, b) => a - b)

    expect(await files(users.employerA)).toEqual(expect.arrayContaining([ids.cvA]))
    expect(await files(users.employerA)).not.toContain(ids.cvA2)
    expect(await files(users.employerA)).not.toContain(ids.cvB)
    expect(await files(users.applicantA)).toEqual([ids.cvOwn])
    await expect(
      harness.payload.find({ collection: APPLICATION_FILES_SLUG as never, overrideAccess: false } as never),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('refuses create, update and employer delete over the API', async () => {
    const data = {
      consentAt: new Date().toISOString(),
      cv: ids.cvA,
      email: 'x@example.invalid',
      job: ids.jobA,
      name: 'X',
    }

    for (const user of [users.employerA, harness.tenantAdminA, harness.superAdmin]) {
      await expect(
        harness.payload.create({ collection: APPLICATIONS_SLUG, data, ...as(user) } as never),
      ).rejects.toMatchObject({ status: 403 })
    }

    await expect(
      harness.payload.update({ collection: APPLICATIONS_SLUG, data: { name: 'Changed' }, id: ids.appA, ...as(harness.tenantAdminA) } as never),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      harness.payload.delete({ collection: APPLICATIONS_SLUG, id: ids.appA, ...as(users.employerA) } as never),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('lets a tenant admin delete in their tenant only', async () => {
    const victim = await apply()
    await expect(
      harness.payload.delete({ collection: APPLICATIONS_SLUG, id: ids.appB, ...as(harness.tenantAdminA) } as never),
    ).rejects.toThrow()
    await harness.payload.delete({ collection: APPLICATIONS_SLUG, id: victim, ...as(harness.tenantAdminA) } as never)
  })
})

describe('delete guard for documents applications point at', () => {
  const run = (totalDocs: number) => {
    const where: unknown[] = []
    const hook = blockDeleteWhileReferencedByApplications({ fields: ['cv', 'coverLetter'], label: 'file' })
    const req = {
      payload: {
        count: (args: { where: unknown }) => {
          where.push(args.where)
          return Promise.resolve({ totalDocs })
        },
      },
    }
    return { result: Promise.resolve(hook({ id: 7, req } as never)), where }
  }

  it('refuses with a clear message while an application uses the document @S-052', async () => {
    const { result, where } = run(2)
    await expect(result).rejects.toThrow('used by 2 applications')
    expect(where[0]).toEqual({ or: [{ cv: { equals: 7 } }, { coverLetter: { equals: 7 } }] })
  })

  it('can check the application files collection for an organisation @S-052', async () => {
    const seen: unknown[] = []
    const hook = blockDeleteWhileReferencedByApplications({
      collection: APPLICATION_FILES_SLUG,
      fields: ['organisation'],
      label: 'organisation',
    })
    const req = {
      payload: {
        count: (args: { collection: string }) => {
          seen.push(args.collection)
          return Promise.resolve({ totalDocs: 1 })
        },
      },
    }
    await expect(Promise.resolve(hook({ id: 3, req } as never))).rejects.toThrow('1 application file ')
    expect(seen).toEqual([APPLICATION_FILES_SLUG])
  })

  it('allows the delete when no application uses it @S-052', async () => {
    await expect(run(0).result).resolves.toBeUndefined()
  })
})
