import { describe, expect, it, vi } from 'vitest'

import {
  APPLICATION_EVENTS,
  applicationFileDownloadEndpoint,
  applicationRecipient,
  applyEndpoint,
  applyErrors,
  fileLinkURL,
  fileProblem,
  readApplyForm,
  signFileLink,
  verifyFileLink,
  type ApplicationEmailDoc,
  type ApplyOptions,
} from './apply'
import { createMemoryRateLimiter } from './rate-limit'
import { hashSiteKey } from './site-keys'

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]
const DOCX = [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]
const DOC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

const file = (name: string, bytes: number[] = PDF, size?: number): File => {
  const data = new Uint8Array(size ?? bytes.length)
  data.set(bytes.slice(0, data.length))

  return new File([data], name)
}

const goodForm = (overrides: Record<string, string | File | null> = {}): FormData => {
  const form = new FormData()
  const values: Record<string, string | File | null> = {
    consent: 'on',
    cv: file('cv.pdf'),
    'cf-turnstile-response': 'token',
    email: 'Ada@Example.com',
    message: 'I would like to apply.',
    name: 'Ada Lovelace',
    phone: '+678 555 0100',
    ...overrides,
  }
  for (const [key, value] of Object.entries(values)) if (value !== null) form.set(key, value)

  return form
}

type World = {
  application?: Record<string, unknown>
  created: { collection: string; data: Record<string, unknown> }[]
  deleted: string[]
}

const SITE_KEY = 'sk_test'
const JOB = {
  applicationsRecipient: 'hr@employer.example',
  applyOnline: true,
  id: 7,
  organisation: 3,
  status: 'published',
  tenant: 1,
  title: 'Nurse',
}
const TENANT = { accountRequiredToApply: false, adminEmail: 'admin@site.example', id: 1, name: 'Site', slug: 'vwok' }

const harness = async ({
  job = JOB,
  options = {},
  tenant = TENANT,
  user = null,
  siteKeyTenant = 1,
  failApplication = false,
}: {
  failApplication?: boolean
  job?: Record<string, unknown>
  options?: ApplyOptions
  siteKeyTenant?: number
  tenant?: Record<string, unknown>
  user?: null | Record<string, unknown>
} = {}) => {
  const world: World = { created: [], deleted: [] }
  const sent: { doc: ApplicationEmailDoc; event: string }[] = []
  const keyHash = await hashSiteKey(SITE_KEY)
  let nextId = 100

  const payload = {
    create: vi.fn(async ({ collection, data }: { collection: string; data: Record<string, unknown> }) => {
      if (collection === 'applications' && failApplication) throw new Error('db down')
      world.created.push({ collection, data })

      return { id: nextId++ }
    }),
    db: { findOne: vi.fn(async () => (user ? { ...user, tenants: [{ role: 'seeker', tenant: 1 }] } : null)) },
    delete: vi.fn(async ({ collection, id }: { collection: string; id: number }) => {
      world.deleted.push(`${collection}:${id}`)
    }),
    find: vi.fn(async ({ collection, where }: { collection: string; where?: any }) => {
      if (collection === 'site-keys') {
        return { docs: where?.keyHash?.equals === keyHash ? [{ id: 1, keyHash, tenant: { id: siteKeyTenant } }] : [] }
      }
      if (collection === 'users') return { docs: [{ email: 'owner@employer.example' }] }

      return { docs: [] }
    }),
    findByID: vi.fn(async ({ collection, id }: { collection: string; id: number | string }) => {
      if (collection === 'jobs') {
        if (String(id) !== String(job.id)) throw new Error('not found')
        return job
      }
      if (collection === 'tenants') return tenant
      if (collection === 'organisations') return { name: 'Employer Ltd' }
      throw new Error(`unexpected ${collection}`)
    }),
    logger: { error: vi.fn() },
    secret: 'test-secret',
  }

  const rateLimiter = createMemoryRateLimiter({ limit: 3, windowMs: 60_000 })
  const sendEmail = vi.fn(async (event: string, doc: ApplicationEmailDoc) => {
    sent.push({ doc, event })
  })

  const call = async (
    form: FormData,
    { id = '7', headers = {} }: { headers?: Record<string, string>; id?: string } = {},
  ) => {
    const endpoint = applyEndpoint({
      rateLimiter,
      sendEmail,
      turnstile: { secret: () => 'secret', verify: async ({ token }) => ({ success: token === 'token' }) },
      ...options,
    })
    const request = new Request('https://cms.example/api/jobs/7/apply', {
      body: form,
      headers: { 'content-length': '5000', 'x-site-key': SITE_KEY, 'x-end-user-ip': '203.0.113.9', ...headers },
      method: 'POST',
    })
    const req = Object.assign(request, { payload, routeParams: { id }, user })
    const response = await endpoint.handler(req as never)

    return { body: (await response.json()) as Record<string, any>, response }
  }

  return { call, payload, sendEmail, sent, world }
}

describe('applyErrors', () => {
  const valid = () => readApplyForm(goodForm())

  it('accepts a complete application @S-049', async () => {
    expect(await applyErrors(valid())).toEqual([])
  })

  it('requires name, a valid email, the CV and consent @S-049', async () => {
    const errors = await applyErrors(readApplyForm(goodForm({ consent: '', cv: null, email: 'nope', name: '' })))

    expect(errors.map((error) => error.field)).toEqual(['name', 'email', 'cv', 'consent'])
  })

  it('makes phone and cover letter optional @S-049', async () => {
    expect(await applyErrors(readApplyForm(goodForm({ phone: '' })))).toEqual([])
  })

  it('refuses HTML in the plain-text message', async () => {
    const errors = await applyErrors(readApplyForm(goodForm({ message: 'hi <script>alert(1)</script>' })))

    expect(errors).toEqual([expect.objectContaining({ field: 'message' })])
  })

  it('refuses a message past the limit', async () => {
    const errors = await applyErrors(readApplyForm(goodForm({ message: 'x'.repeat(5001) })))

    expect(errors[0]?.field).toBe('message')
  })

  it('accepts PDF, DOC and DOCX by extension and signature', async () => {
    expect(await fileProblem(file('a.pdf', PDF), 'CV')).toBeNull()
    expect(await fileProblem(file('a.docx', DOCX), 'CV')).toBeNull()
    expect(await fileProblem(file('a.doc', DOC), 'CV')).toBeNull()
  })

  it('refuses other types, a renamed file, an empty file and one over 10 MB', async () => {
    expect(await fileProblem(file('a.exe', PDF), 'CV')).toMatch(/PDF, DOC or DOCX/)
    expect(await fileProblem(file('a.pdf', DOCX), 'CV')).toMatch(/not a valid PDF/)
    expect(await fileProblem(new File([], 'a.pdf'), 'CV')).toMatch(/empty/)
    expect(await fileProblem(file('a.pdf', PDF, 10 * 1024 * 1024 + 1), 'CV')).toMatch(/10 MB/)
    expect(await fileProblem(file('a.pdf', PDF, 10 * 1024 * 1024), 'CV')).toBeNull()
  })
})

describe('applicationRecipient', () => {
  it("uses the job's own address first @S-032", async () => {
    const contact = vi.fn(async () => 'owner@employer.example')

    expect(await applicationRecipient({ job: { applicationsRecipient: 'hr@x.example' }, organisationContact: contact })).toBe('hr@x.example')
    expect(contact).not.toHaveBeenCalled()
  })

  it("falls back to the organisation's contact, and ignores a malformed job address @S-032", async () => {
    expect(await applicationRecipient({ job: { applicationsRecipient: 'garbage' }, organisationContact: async () => 'owner@x.example' })).toBe('owner@x.example')
    expect(await applicationRecipient({ job: {}, organisationContact: async () => null })).toBeNull()
  })
})

describe('signed file links', () => {
  const secret = 's3cret'
  const future = Math.floor(Date.now() / 1000) + 60

  it('verifies a fresh signature @S-366', async () => {
    const signature = await signFileLink({ expiresAt: future, fileId: 5, secret })

    expect(await verifyFileLink({ expiresAt: future, fileId: 5, secret, signature })).toBe(true)
  })

  it('rejects another file, another expiry, another secret and an expired link @S-366', async () => {
    const signature = await signFileLink({ expiresAt: future, fileId: 5, secret })

    expect(await verifyFileLink({ expiresAt: future, fileId: 6, secret, signature })).toBe(false)
    expect(await verifyFileLink({ expiresAt: future + 1, fileId: 5, secret, signature })).toBe(false)
    expect(await verifyFileLink({ expiresAt: future, fileId: 5, secret: 'other', signature })).toBe(false)
    expect(await verifyFileLink({ expiresAt: future, fileId: 5, now: (future + 1) * 1000, secret, signature })).toBe(false)
  })

  it('builds an absolute link on the collection download path', async () => {
    const url = await fileLinkURL({ expiresAt: future, fileId: 5, origin: 'https://cms.example', secret })

    expect(url).toMatch(/^https:\/\/cms\.example\/api\/application-files\/download\/5\?exp=\d+&sig=[\w-]+$/)
  })
})

describe('apply endpoint', () => {
  it('stores the CV and the application and answers 201 @S-049', async () => {
    const { call, world } = await harness()
    const { body, response } = await call(goodForm())

    expect(response.status).toBe(201)
    expect(body).toEqual({ ok: true })
    expect(world.created.map((row) => row.collection)).toEqual(['application-files', 'applications'])

    const application = world.created[1]!.data
    expect(application).toMatchObject({ cv: 100, email: 'ada@example.com', job: 7, name: 'Ada Lovelace', tenant: 1 })
    expect(application.consentAt).toEqual(expect.any(String))
    // organisation and tenant on the file come from the job, never the request.
    expect(world.created[0]!.data).toMatchObject({ organisation: 3, tenant: 1 })
  })

  it('stores an optional cover letter next to the CV @S-049', async () => {
    const { call, world } = await harness()
    await call(goodForm({ coverLetter: file('letter.docx', DOCX) }))

    expect(world.created.map((row) => row.collection)).toEqual(['application-files', 'application-files', 'applications'])
    expect(world.created[2]!.data).toMatchObject({ coverLetter: 101, cv: 100 })
  })

  it('rejects invalid input with 400 and field errors and stores nothing @S-049', async () => {
    const { call, sendEmail, world } = await harness()
    const { body, response } = await call(goodForm({ cv: null, email: 'bad' }))

    expect(response.status).toBe(400)
    expect(body.error.errors.map((error: { field: string }) => error.field)).toEqual(['email', 'cv'])
    expect(world.created).toEqual([])
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('rejects an oversize CV and a wrong file type @S-049', async () => {
    const { call, world } = await harness()

    const big = await call(goodForm({ cv: file('cv.pdf', PDF, 10 * 1024 * 1024 + 1) }))
    expect(big.response.status).toBe(400)
    expect(big.body.error.message).toMatch(/10 MB/)

    const wrong = await call(goodForm({ cv: file('cv.exe', PDF) }), { headers: { 'x-end-user-ip': '203.0.113.10' } })
    expect(wrong.response.status).toBe(400)
    expect(world.created).toEqual([])
  })

  it('silently drops a bot that fills the honeypot, storing and sending nothing @S-049', async () => {
    const { call, sendEmail, world } = await harness()
    const { body, response } = await call(goodForm({ 'rp-website': 'http://spam.example' }))

    expect(response.status).toBe(202)
    expect(body).toEqual({ ok: true })
    expect(world.created).toEqual([])
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('refuses a failed or missing Turnstile token @S-049', async () => {
    const { call, world } = await harness()

    expect((await call(goodForm({ 'cf-turnstile-response': 'forged' }))).body.error.code).toBe('turnstile_failed')
    expect((await call(goodForm({ 'cf-turnstile-response': null }), { headers: { 'x-end-user-ip': '203.0.113.11' } })).body.error.code).toBe('turnstile_failed')
    expect(world.created).toEqual([])
  })

  it('fails closed when no Turnstile secret is configured', async () => {
    const { call } = await harness({ options: { turnstile: { secret: () => undefined } } })

    expect((await call(goodForm())).response.status).toBe(500)
  })

  it('rate limits per IP and per email with Retry-After @S-136', async () => {
    const { call } = await harness()
    for (let attempt = 0; attempt < 3; attempt += 1) await call(goodForm())

    const blocked = await call(goodForm())
    expect(blocked.response.status).toBe(429)
    expect(blocked.response.headers.get('retry-after')).toBe('60')

    // A new IP with the same email is still limited, so rotating IPs does not help.
    const rotated = await call(goodForm(), { headers: { 'x-end-user-ip': '198.51.100.1' } })
    expect(rotated.response.status).toBe(429)

    // Another person from another address is unaffected.
    const other = await call(goodForm({ email: 'grace@example.com' }), { headers: { 'x-end-user-ip': '198.51.100.2' } })
    expect(other.response.status).toBe(201)
  })

  it('needs a valid site key', async () => {
    const { call } = await harness()

    expect((await call(goodForm(), { headers: { 'x-site-key': 'wrong' } })).response.status).toBe(401)
  })

  it("answers 404 for another tenant's job, as if it did not exist @S-365", async () => {
    const { call, world } = await harness({ job: { ...JOB, tenant: 2 } })

    expect((await call(goodForm())).response.status).toBe(404)
    expect(world.created).toEqual([])
  })

  it('refuses a job that is closed, expired or has online applying off @S-032', async () => {
    const closed = await harness({ job: { ...JOB, status: 'expired' } })
    expect((await closed.call(goodForm())).body.error.code).toBe('job_closed')

    const past = await harness({ job: { ...JOB, expiresAt: '2020-01-01T00:00:00.000Z' } })
    expect((await past.call(goodForm())).body.error.code).toBe('job_closed')

    const offline = await harness({ job: { ...JOB, applyOnline: false } })
    expect((await offline.call(goodForm())).body.error.code).toBe('apply_offline')
  })

  it('lets a guest apply when the site does not require an account @S-050', async () => {
    const { call } = await harness({ tenant: { ...TENANT, accountRequiredToApply: false } })

    expect((await call(goodForm())).response.status).toBe(201)
  })

  it('asks a guest to sign in when the site requires an account, and stores nothing @S-050', async () => {
    const { call, world } = await harness({ tenant: { ...TENANT, accountRequiredToApply: true } })
    const { body, response } = await call(goodForm())

    expect(response.status).toBe(401)
    expect(body.error.code).toBe('sign_in_required')
    expect(world.created).toEqual([])
  })

  it('links the application to the signed-in applicant when the site requires an account @S-050', async () => {
    const { call, world } = await harness({
      tenant: { ...TENANT, accountRequiredToApply: true },
      user: { collection: 'users', email: 'ada@example.com', id: 42 },
    })

    expect((await call(goodForm())).response.status).toBe(201)
    expect(world.created[1]!.data).toMatchObject({ applicant: 42 })
  })

  it('removes the stored files when the application cannot be written', async () => {
    const { call, world } = await harness({ failApplication: true })
    const { response } = await call(goodForm())

    expect(response.status).toBe(500)
    expect(world.deleted).toEqual(['application-files:100'])
  })

  it('refuses before storing anything when nobody would receive the application', async () => {
    const { call, payload, world } = await harness({ job: { ...JOB, applicationsRecipient: null } })
    payload.find.mockImplementation(async ({ collection }: { collection: string; where?: unknown }) =>
      collection === 'site-keys' ? { docs: [{ id: 1, keyHash: await hashSiteKey(SITE_KEY), tenant: { id: 1 } }] } : { docs: [] },
    )
    const { body, response } = await call(goodForm())

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('apply_not_configured')
    expect(world.created).toEqual([])
  })
})

describe('apply body size and abuse controls @S-368', () => {
  it('refuses an oversized or unsized body with 413 before reading it or touching the database', async () => {
    const { call, payload, world } = await harness()
    const formData = vi.spyOn(Request.prototype, 'formData')

    const big = await call(goodForm(), { headers: { 'content-length': String(21 * 1024 * 1024 + 1) } })
    expect(big.response.status).toBe(413)
    expect(big.body.error.code).toBe('payload_too_large')

    const unsized = await call(goodForm(), { headers: { 'content-length': '' } })
    expect(unsized.response.status).toBe(413)

    const nonsense = await call(goodForm(), { headers: { 'content-length': 'abc' } })
    expect(nonsense.response.status).toBe(413)

    expect(formData).not.toHaveBeenCalled()
    expect(world.created).toEqual([])
    expect(payload.findByID).not.toHaveBeenCalled()
    formData.mockRestore()
  })

  it('accepts a body at the cap', async () => {
    const { call } = await harness()

    expect((await call(goodForm(), { headers: { 'content-length': String(21 * 1024 * 1024) } })).response.status).toBe(201)
  })

  it('rate limits by IP before the body is read, so a flood of big bodies is cut off', async () => {
    const { call } = await harness()
    const formData = vi.spyOn(Request.prototype, 'formData')
    for (let attempt = 0; attempt < 3; attempt += 1) await call(goodForm(), { headers: { 'content-length': '5000' } })
    formData.mockClear()

    expect((await call(goodForm())).response.status).toBe(429)
    expect(formData).not.toHaveBeenCalled()
    formData.mockRestore()
  })

  it('gives Turnstile the visitor address from x-end-user-ip, not the proxy egress address', async () => {
    const verify = vi.fn(async () => ({ success: true }))
    const { call } = await harness({ options: { turnstile: { secret: () => 'secret', verify } } })
    await call(goodForm(), { headers: { 'cf-connecting-ip': '198.51.100.99', 'x-end-user-ip': '203.0.113.9' } })

    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ remoteIp: '203.0.113.9' }))
  })
})

describe('apply emails', () => {
  it('sends the application to the employer, a copy to the applicant and a copy to the admin @S-367', async () => {
    const { call, sent } = await harness()
    await call(goodForm({ coverLetter: file('letter.pdf') }))

    expect(sent.map((row) => [row.event, row.doc.to])).toEqual([
      [APPLICATION_EVENTS.employer, 'hr@employer.example'],
      [APPLICATION_EVENTS.applicant, 'ada@example.com'],
      [APPLICATION_EVENTS.admin, 'admin@site.example'],
    ])

    const [employer, applicant, admin] = sent.map((row) => row.doc)
    expect(employer).toMatchObject({ applicantName: 'Ada Lovelace', jobTitle: 'Nurse', organisationName: 'Employer Ltd', tenantId: 1 })
    expect(employer!.cvLink).toMatch(/\/api\/application-files\/download\/100\?exp=\d+&sig=/)
    expect(employer!.coverLetterLink).toMatch(/download\/101/)
    expect(admin!.cvLink).toBeDefined()
    // The applicant already has their files: their copy carries no download links.
    expect(applicant!.cvLink).toBeUndefined()
    expect(applicant!.coverLetterLink).toBeUndefined()
  })

  it('sends no admin copy when the tenant has no admin address', async () => {
    const { call, sent } = await harness({ tenant: { ...TENANT, adminEmail: null } })
    await call(goodForm())

    expect(sent.map((row) => row.event)).toEqual([APPLICATION_EVENTS.employer, APPLICATION_EVENTS.applicant])
  })

  it('sends nothing when no email sender is wired, but still stores the application', async () => {
    const { call, world } = await harness({ options: { sendEmail: undefined } })

    expect((await call(goodForm())).response.status).toBe(201)
    expect(world.created).toHaveLength(2)
  })

  it('never reveals the recipient to the browser, and a failed email does not fail the application @S-367', async () => {
    const { call, payload, sendEmail } = await harness()
    sendEmail.mockRejectedValue(new Error('smtp down hr@employer.example'))
    const { body, response } = await call(goodForm())

    expect(response.status).toBe(201)
    expect(JSON.stringify(body)).not.toContain('employer.example')
    expect(JSON.stringify(response.headers)).not.toContain('employer.example')
    expect(payload.logger.error).toHaveBeenCalledTimes(3)
  })

  it('never puts the recipient in an error answer either', async () => {
    const { call } = await harness()
    const { body } = await call(goodForm({ email: 'bad' }))

    expect(JSON.stringify(body)).not.toContain('employer.example')
  })
})

describe('application file download', () => {
  const run = async ({ expiresAt, id = '5', signature }: { expiresAt: number; id?: string; signature: string }) => {
    const handler = vi.fn(async () => new Response('%PDF-bytes', { headers: { 'content-type': 'application/pdf' } }))
    const req = Object.assign(new Request(`https://cms.example/api/application-files/download/${id}?exp=${expiresAt}&sig=${signature}`), {
      payload: {
        collections: { 'application-files': { config: { upload: { handlers: [async () => undefined, handler] } } } },
        findByID: vi.fn(async () => ({ filename: 'cv.pdf' })),
        secret: 'test-secret',
      },
      routeParams: { id },
    })
    const response = await applicationFileDownloadEndpoint().handler(req as never)

    return { handler, response }
  }

  it('serves the file for a valid signed link, uncached and as an attachment @S-366', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60
    const signature = await signFileLink({ expiresAt, fileId: 5, secret: 'test-secret' })
    const { handler, response } = await run({ expiresAt, signature })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('%PDF-bytes')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="cv.pdf"')
    expect(handler).toHaveBeenCalled()
  })

  it('answers 404 for a forged, expired or other-file signature @S-366', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60
    const signature = await signFileLink({ expiresAt, fileId: 5, secret: 'test-secret' })

    expect((await run({ expiresAt, signature: 'forged' })).response.status).toBe(404)
    expect((await run({ expiresAt, id: '6', signature })).response.status).toBe(404)

    const past = Math.floor(Date.now() / 1000) - 5
    const expired = await signFileLink({ expiresAt: past, fileId: 5, secret: 'test-secret' })
    expect((await run({ expiresAt: past, signature: expired })).response.status).toBe(404)
  })
})
