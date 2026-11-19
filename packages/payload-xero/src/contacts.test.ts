import { describe, expect, it, vi } from 'vitest'

import {
  AXI_CONTACT_CODE_PREFIX,
  findOrCreateXeroContact,
  legacyContactCode,
  XeroContactError,
  type XeroContact,
} from './contacts'

const ACCESS_TOKEN = 'access-token-1'
const TENANT_ID = 'xero-tenant-1'
const API = 'https://xero.test/api.xro/2.0'

const contact = (overrides: Partial<XeroContact> = {}): XeroContact => ({
  ContactID: 'contact-1',
  ContactNumber: null,
  ContactStatus: 'ACTIVE',
  EmailAddress: null,
  Name: 'Fictional Employer',
  ...overrides,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })

type Call = { body: unknown; headers: Record<string, string>; method: string; url: URL }

/**
 * A stand-in Xero Contacts API: `respond` decides the answer for one call, so a test can script
 * a miss-then-hit sequence and assert exactly which lookups and creates were attempted.
 */
const mockXero = (respond: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = []

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const call: Call = {
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: init?.method ?? 'GET',
      url,
    }
    calls.push(call)

    return respond(call)
  })

  return { calls, fetchMock: fetchMock as unknown as typeof fetch }
}

const found = (...contacts: XeroContact[]) => json({ Contacts: contacts })

const run = (
  xero: ReturnType<typeof mockXero>,
  contactInput: Parameters<typeof findOrCreateXeroContact>[0]['contact'],
  overrides: Partial<Parameters<typeof findOrCreateXeroContact>[0]> = {},
) =>
  findOrCreateXeroContact({
    accessToken: ACCESS_TOKEN,
    apiBaseUrl: API,
    contact: contactInput,
    fetch: xero.fetchMock,
    tenantId: TENANT_ID,
    ...overrides,
  })

describe('legacyContactCode', () => {
  it('builds the code the WordPress plugin wrote', () => {
    expect(legacyContactCode(1234)).toBe('AXI-1234')
    expect(legacyContactCode(1234).startsWith(AXI_CONTACT_CODE_PREFIX)).toBe(true)
  })

  it('refuses an id that cannot be a legacy user', () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => legacyContactCode(value)).toThrow(XeroContactError)
    }
  })
})

describe('findOrCreateXeroContact lookups', () => {
  it('uses the stored xeroContactCode first, and creates nothing', async () => {
    const xero = mockXero(() => found(contact({ ContactNumber: 'ACME-1' })))

    const result = await run(xero, {
      code: 'ACME-1',
      email: 'billing@acme.test',
      legacyUserId: 42,
      name: 'Acme',
    })

    expect(result.matchedBy).toBe('code')
    expect(result.contact.ContactID).toBe('contact-1')
    expect(xero.calls).toHaveLength(1)
    expect(xero.calls[0].method).toBe('GET')
    expect(xero.calls[0].url.origin + xero.calls[0].url.pathname).toBe(`${API}/Contacts`)
    expect(xero.calls[0].url.searchParams.get('where')).toBe('ContactNumber=="ACME-1"')
    expect(xero.calls[0].headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(xero.calls[0].headers['xero-tenant-id']).toBe(TENANT_ID)
  })

  it('falls back to AXI-{legacyUserId} when the stored code misses', async () => {
    const xero = mockXero((call) =>
      call.url.searchParams.get('where') === 'ContactNumber=="AXI-42"'
        ? found(contact({ ContactNumber: 'AXI-42' }))
        : found(),
    )

    const result = await run(xero, {
      code: 'STALE-CODE',
      email: 'billing@acme.test',
      legacyUserId: 42,
      name: 'Acme',
    })

    expect(result.matchedBy).toBe('legacyId')
    expect(xero.calls.map((call) => call.url.searchParams.get('where'))).toEqual([
      'ContactNumber=="STALE-CODE"',
      'ContactNumber=="AXI-42"',
    ])
  })

  it('falls back to the email address when both codes miss', async () => {
    const xero = mockXero((call) =>
      call.url.searchParams.get('where') === 'EmailAddress=="billing@acme.test"'
        ? found(contact({ EmailAddress: 'billing@acme.test' }))
        : found(),
    )

    const result = await run(xero, { code: 'STALE-CODE', email: 'billing@acme.test', legacyUserId: 42 })

    expect(result.matchedBy).toBe('email')
    expect(xero.calls).toHaveLength(3)
    expect(xero.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('looks up each value once when the stored code already is the legacy code', async () => {
    const xero = mockXero(() => found())

    await expect(run(xero, { code: 'AXI-42', legacyUserId: 42 })).rejects.toThrow('needs a contact name')

    expect(xero.calls.map((call) => call.url.searchParams.get('where'))).toEqual([
      'ContactNumber=="AXI-42"',
    ])
  })

  it('ignores an archived contact, which cannot take a new invoice', async () => {
    const xero = mockXero((call) =>
      call.url.searchParams.get('where') === 'ContactNumber=="AXI-42"'
        ? found(contact({ ContactID: 'archived', ContactStatus: 'ARCHIVED' }))
        : found(contact({ ContactID: 'by-email', EmailAddress: 'billing@acme.test' })),
    )

    const result = await run(xero, {
      email: 'billing@acme.test',
      legacyUserId: 42,
      name: 'Acme',
    })

    expect(result.matchedBy).toBe('email')
  })

  it('picks the active contact when the same lookup also returns an archived one', async () => {
    const xero = mockXero(() =>
      found(
        contact({ ContactID: 'archived', ContactStatus: 'ARCHIVED' }),
        contact({ ContactID: 'active', ContactStatus: 'ACTIVE' }),
      ),
    )

    const result = await run(xero, { code: 'ACME-1' })

    expect(result.contact.ContactID).toBe('active')
  })

  it('skips a legacy id that cannot form a code, and still looks up the email', async () => {
    const xero = mockXero((call) =>
      call.url.searchParams.get('where') === 'EmailAddress=="billing@acme.test"'
        ? found(contact({ ContactID: 'by-email' }))
        : found(),
    )

    const result = await run(xero, { email: 'billing@acme.test', legacyUserId: 0 })

    expect(result.matchedBy).toBe('email')
    expect(xero.calls.map((call) => call.url.searchParams.get('where'))).toEqual([
      'EmailAddress=="billing@acme.test"',
    ])
  })

  it('trims blank values, so an empty code or email is not looked up', async () => {
    const xero = mockXero(() => found(contact({ ContactID: 'by-legacy' })))

    await run(xero, { code: '  ', email: '', legacyUserId: 7, name: 'Acme' })

    expect(xero.calls).toHaveLength(1)
    expect(xero.calls[0].url.searchParams.get('where')).toBe('ContactNumber=="AXI-7"')
  })
})

describe('findOrCreateXeroContact creation', () => {
  it('creates the contact when every lookup misses, carrying the code and email', async () => {
    const xero = mockXero((call) =>
      call.method === 'POST'
        ? json({ Contacts: [contact({ ContactID: 'new-contact', ContactNumber: 'ACME-1' })] })
        : found(),
    )

    const result = await run(xero, {
      code: 'ACME-1',
      email: 'billing@acme.test',
      legacyUserId: 42,
      name: 'Acme Ltd',
    })

    expect(result.matchedBy).toBe('created')
    expect(result.contact.ContactID).toBe('new-contact')

    const create = xero.calls.at(-1)!
    expect(create.method).toBe('POST')
    expect(create.url.origin + create.url.pathname).toBe(`${API}/Contacts`)
    expect(create.headers['xero-tenant-id']).toBe(TENANT_ID)
    expect(create.body).toEqual({
      Contacts: [{ ContactNumber: 'ACME-1', EmailAddress: 'billing@acme.test', Name: 'Acme Ltd' }],
    })
  })

  it('creates with the AXI code when the payer has no stored code', async () => {
    const xero = mockXero((call) =>
      call.method === 'POST' ? json({ Contacts: [contact({ ContactID: 'new-contact' })] }) : found(),
    )

    await run(xero, { legacyUserId: 42, name: 'Acme Ltd' })

    expect(xero.calls.at(-1)!.body).toEqual({
      Contacts: [{ ContactNumber: 'AXI-42', Name: 'Acme Ltd' }],
    })
  })

  it('creates a name-only contact when there is no code to send', async () => {
    const xero = mockXero((call) =>
      call.method === 'POST' ? json({ Contacts: [contact({ ContactID: 'new-contact' })] }) : found(),
    )

    await run(xero, { email: 'billing@acme.test', name: 'Acme Ltd' })

    expect(xero.calls.map((call) => call.method)).toEqual(['GET', 'POST'])
    expect(xero.calls.at(-1)!.body).toEqual({
      Contacts: [{ EmailAddress: 'billing@acme.test', Name: 'Acme Ltd' }],
    })
  })

  it('will not create a contact without a name, and has already tried every lookup', async () => {
    const xero = mockXero(() => found())

    await expect(run(xero, { email: 'billing@acme.test', legacyUserId: 42 })).rejects.toMatchObject({
      code: 'invalid_contact',
    })

    expect(xero.calls.map((call) => call.method)).toEqual(['GET', 'GET'])
  })
})

describe('findOrCreateXeroContact failures', () => {
  it('refuses to invoice without a connection', async () => {
    const xero = mockXero(() => found())

    await expect(run(xero, { name: 'Acme' }, { accessToken: '' })).rejects.toMatchObject({
      code: 'not_connected',
      status: 409,
    })
    await expect(run(xero, { name: 'Acme' }, { tenantId: ' ' })).rejects.toMatchObject({
      code: 'not_connected',
    })
    expect(xero.calls).toHaveLength(0)
  })

  it('surfaces Xero’s own validation message, without leaking the token', async () => {
    const xero = mockXero(() =>
      json(
        {
          Elements: [
            { ValidationErrors: [{ Message: 'ContactNumber must be unique' }] },
          ],
        },
        400,
      ),
    )

    const error = await run(xero, { code: 'ACME-1', name: 'Acme' }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(XeroContactError)
    expect(error).toMatchObject({ code: 'contact_lookup_failed', status: 502 })
    expect((error as Error).message).toContain('ContactNumber must be unique')
    expect(JSON.stringify(error)).not.toContain(ACCESS_TOKEN)
  })

  it('reports a failed create separately from a failed lookup', async () => {
    const xero = mockXero((call) =>
      call.method === 'POST' ? json({ Message: 'Account is disabled' }, 403) : found(),
    )

    await expect(run(xero, { name: 'Acme' })).rejects.toMatchObject({
      code: 'contact_create_failed',
      status: 502,
    })
  })

  it('rejects an unreadable or empty create response', async () => {
    for (const response of [json({}), json({ Contacts: [] }), new Response('not json', { status: 200 })]) {
      const xero = mockXero((call) => (call.method === 'POST' ? response : found()))

      await expect(run(xero, { name: 'Acme' })).rejects.toMatchObject({
        code: 'contact_create_failed',
      })
    }
  })

  it('turns a transport failure and a timeout into the same error', async () => {
    for (const failure of [new TypeError('failed to fetch'), new DOMException('timed out', 'TimeoutError')]) {
      const fetchMock = (async () => {
        throw failure
      }) as unknown as typeof fetch

      await expect(
        run({ calls: [], fetchMock }, { code: 'ACME-1', name: 'Acme' }),
      ).rejects.toMatchObject({ code: 'contact_lookup_failed' })
    }
  })

  it('refuses a value Xero’s filter grammar cannot hold', async () => {
    const xero = mockXero(() => found())

    await expect(run(xero, { code: 'ACME"1', name: 'Acme' })).rejects.toMatchObject({
      code: 'invalid_contact',
    })
    await expect(run(xero, { email: 'a\\b@acme.test', name: 'Acme' })).rejects.toMatchObject({
      code: 'invalid_contact',
    })
    expect(xero.calls).toHaveLength(0)
  })
})
