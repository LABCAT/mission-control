import { describe, expect, it, vi } from 'vitest'

import {
  applicationsExportEndpoint,
  applicationsToCSV,
  canReadJobApplications,
  csvCell,
  jobApplicationsCSVEndpoint,
  jobApplicationsEndpoint,
  parseExportRange,
} from './application-endpoints'
import { verifyFileLink } from './apply'

const employerA = { id: 1, organisation: 10, tenants: [{ role: 'employer', tenant: 1 }] }
const employerB = { id: 2, organisation: 11, tenants: [{ role: 'employer', tenant: 1 }] }
const employerOtherTenant = { id: 3, organisation: 10, tenants: [{ role: 'employer', tenant: 2 }] }
const staff = { id: 4, tenants: [{ role: 'tenant-admin', tenant: 1 }] }
const seeker = { id: 5, tenants: [{ role: 'seeker', tenant: 1 }] }
const superAdmin = { id: 6, role: 'super-admin' }
const job = { id: 7, organisation: 10, tenant: 1, title: 'Cook' }

const application = {
  id: 100,
  name: 'Ana, "A"',
  coverLetter: { id: 51, filename: 'letter.pdf' },
  createdAt: '2026-11-01T00:00:00.000Z',
  cv: { id: 50, filename: 'cv.pdf' },
  email: 'ana@example.com',
  job,
  message: '=HYPERLINK("x")',
  organisation: { id: 10, name: 'Acme' },
  phone: '+678 1',
}

const reqFor = (user: unknown, url: string, docs: unknown[] = [application], routeParams: Record<string, string> = { jobId: '7' }) => {
  const find = vi.fn(async (_args: Record<string, unknown>) => ({ docs, hasNextPage: false, page: 1, totalDocs: docs.length, totalPages: 1 }))
  const findByID = vi.fn(async ({ id }: { id: unknown }) => {
    if (String(id) !== '7') throw new Error('not found')
    return job
  })

  return {
    req: Object.assign(new Request(url), { payload: { find, findByID, secret: 'test-secret' }, routeParams, user }),
    find,
  }
}

const JOB_URL = 'https://cms.example/api/applications/for-job/7'

describe('canReadJobApplications @S-052', () => {
  const can = (user: unknown) => canReadJobApplications({ job, tenantScoped: true, user: user as never })

  it('allows the job organisation, the tenant staff and super admins only', () => {
    expect(can(employerA)).toBe(true)
    expect(can(staff)).toBe(true)
    expect(can(superAdmin)).toBe(true)
    expect(can(employerB)).toBe(false)
    expect(can(employerOtherTenant)).toBe(false)
    expect(can(seeker)).toBe(false)
    expect(can(null)).toBe(false)
  })
})

describe('applications for a job @S-052', () => {
  it('lists them for a member of the job organisation, with signed expiring file links', async () => {
    const { req, find } = reqFor(employerA, JOB_URL)
    const response = await jobApplicationsEndpoint().handler(req as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(find.mock.calls[0]![0]).toMatchObject({ where: { job: { equals: 7 } } })
    expect(body.docs).toHaveLength(1)
    expect(body.docs[0].applicant.email).toBe('ana@example.com')

    const url = new URL(body.docs[0].cv.url)
    expect(url.pathname).toBe('/api/application-files/download/50')
    const expiresAt = Number(url.searchParams.get('exp'))
    expect(expiresAt * 1000).toBeGreaterThan(Date.now())
    expect(await verifyFileLink({ expiresAt, fileId: 50, secret: 'test-secret', signature: url.searchParams.get('sig') ?? '' })).toBe(true)
    // The link is for that file only.
    expect(await verifyFileLink({ expiresAt, fileId: 51, secret: 'test-secret', signature: url.searchParams.get('sig') ?? '' })).toBe(false)
  })

  it('uses the configured link lifetime', async () => {
    const { req } = reqFor(employerA, JOB_URL)
    const body = await (await jobApplicationsEndpoint({ fileLinkTtlSeconds: 60 }).handler(req as never)).json()
    const exp = Number(new URL(body.docs[0].cv.url).searchParams.get('exp'))

    expect(exp * 1000 - Date.now()).toBeLessThanOrEqual(60_000)
  })

  it('refuses anonymous callers with 401 and other organisations, tenants and seekers with 404', async () => {
    expect((await jobApplicationsEndpoint().handler(reqFor(null, JOB_URL).req as never)).status).toBe(401)

    for (const user of [employerB, employerOtherTenant, seeker]) {
      const { req, find } = reqFor(user, JOB_URL)
      expect((await jobApplicationsEndpoint().handler(req as never)).status).toBe(404)
      expect(find).not.toHaveBeenCalled()
    }
  })

  it('answers 404 for a job that does not exist', async () => {
    const { req } = reqFor(staff, JOB_URL, [], { jobId: '999' })
    expect((await jobApplicationsEndpoint().handler(req as never)).status).toBe(404)
  })

  it('caps the page size', async () => {
    const { req, find } = reqFor(employerA, `${JOB_URL}?limit=100000&page=2`)
    await jobApplicationsEndpoint().handler(req as never)

    expect(find.mock.calls[0]![0]).toMatchObject({ limit: 100, page: 2 })
  })
})

describe('CSV @S-052', () => {
  it('defuses spreadsheet formulas and quotes commas and quotes', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('Ana, "A"')).toBe('"Ana, ""A"""')
    expect(csvCell(' =1+1')).toBe("' =1+1")
    expect(csvCell('\u00a0@SUM(A1)')).toBe("'\u00a0@SUM(A1)")
    expect(csvCell('\n-2+3')).toBe('"\'\n-2+3"')
    expect(csvCell('hello = world')).toBe('hello = world')
    expect(csvCell(null)).toBe('')
  })

  it('exports the job list for a member of its organisation', async () => {
    const { req } = reqFor(employerA, `${JOB_URL}/csv`)
    const response = await jobApplicationsCSVEndpoint().handler(req as never)
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(text).toContain('Applied at,Job,Organisation,Name')
    expect(text).toContain('"Ana, ""A"""')
    expect(text).toContain(`"'=HYPERLINK(""x"")"`)
    expect(text).toContain('/api/application-files/download/50?exp=')
  })

  it('refuses another organisation', async () => {
    const { req } = reqFor(employerB, `${JOB_URL}/csv`)
    expect((await jobApplicationsCSVEndpoint().handler(req as never)).status).toBe(404)
  })

  it('has a header row even when empty', () => {
    expect(applicationsToCSV([])).toMatch(/^﻿Applied at,/)
  })
})

describe('site-manager export @S-385', () => {
  const EXPORT = 'https://cms.example/api/applications/export'

  it('parses the range: whole days, UTC, to inclusive', () => {
    expect(parseExportRange('2026-11-01', '2026-11-02')).toEqual({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-03T00:00:00.000Z' })
    expect(parseExportRange(null, '2026-11-02')).toHaveProperty('error')
    expect(parseExportRange('nope', '2026-11-02')).toHaveProperty('error')
    expect(parseExportRange('2026-11-05', '2026-11-01')).toHaveProperty('error')
  })

  it('exports for a super admin across tenants', async () => {
    const { req, find } = reqFor(superAdmin, `${EXPORT}?from=2026-11-01&to=2026-11-30`)
    const response = await applicationsExportEndpoint().handler(req as never)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('ana@example.com')
    expect(find.mock.calls[0]![0].where).toEqual({
      and: [{ createdAt: { greater_than_equal: '2026-11-01T00:00:00.000Z' } }, { createdAt: { less_than: '2026-12-01T00:00:00.000Z' } }],
    })
  })

  it('limits tenant staff to their own tenants', async () => {
    const { req, find } = reqFor(staff, `${EXPORT}?from=2026-11-01&to=2026-11-30`)
    expect((await applicationsExportEndpoint().handler(req as never)).status).toBe(200)
    expect(JSON.stringify(find.mock.calls[0]![0].where)).toContain('{"tenant":{"in":[1]}}')

    const other = reqFor(staff, `${EXPORT}?from=2026-11-01&to=2026-11-30&tenant=2`)
    expect((await applicationsExportEndpoint().handler(other.req as never)).status).toBe(403)
    expect(other.find).not.toHaveBeenCalled()
  })

  it('refuses employers, seekers and anonymous callers', async () => {
    const query = '?from=2026-11-01&to=2026-11-30'
    expect((await applicationsExportEndpoint().handler(reqFor(null, EXPORT + query).req as never)).status).toBe(401)
    for (const user of [employerA, seeker]) {
      const { req, find } = reqFor(user, EXPORT + query)
      expect((await applicationsExportEndpoint().handler(req as never)).status).toBe(403)
      expect(find).not.toHaveBeenCalled()
    }
  })

  it('requires a valid date range', async () => {
    expect((await applicationsExportEndpoint().handler(reqFor(superAdmin, EXPORT).req as never)).status).toBe(400)
  })
})
