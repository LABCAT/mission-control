import { describe, expect, it, vi } from 'vitest'

import {
  addDays,
  authoriseInvoice,
  buildDraftInvoice,
  createDraftInvoice,
  currencyExponent,
  decimalToMinor,
  findInvoicesByReference,
  getOnlineInvoiceUrl,
  invoiceInputProblems,
  minorToDecimal,
  xeroDay,
  XeroInvoiceError,
  type XeroInvoiceInput,
} from './invoices'

const ID = '11111111-2222-4333-8444-555555555555'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })

const api = (fetch: typeof globalThis.fetch) => ({ accessToken: 'secret-token', fetch, tenantId: 'org-1' })

const input = (extra: Partial<XeroInvoiceInput> = {}): XeroInvoiceInput => ({
  contact: { name: 'Brew' },
  currency: 'VUV',
  expectedTotal: 4900,
  lineAmountTypes: 'NoTax',
  lines: [
    { accountCode: '225', description: 'Basic', quantity: 1, unitAmount: 3900 },
    { accountCode: '226', description: 'Featured', quantity: 1, unitAmount: 1500 },
    { accountCode: '227', description: 'Coupon SAVE', quantity: 1, unitAmount: -500 },
  ],
  reference: 'Order 12',
  ...extra,
})

describe('money @S-102', () => {
  it('knows each currency’s decimal places', () => {
    expect(currencyExponent('VUV')).toBe(0)
    expect(currencyExponent('NZD')).toBe(2)
    expect(currencyExponent('KWD')).toBe(3)
    expect(() => currencyExponent('vuv')).toThrow(XeroInvoiceError)
    expect(() => currencyExponent('ZZZ1')).toThrow(XeroInvoiceError)
  })

  it('turns minor units into decimals digit by digit, with no float error', () => {
    expect(minorToDecimal(3900, 0)).toBe(3900)
    expect(minorToDecimal(1999, 2)).toBe(19.99)
    expect(minorToDecimal(5, 2)).toBe(0.05)
    expect(minorToDecimal(-500, 2)).toBe(-5)
    expect(minorToDecimal(1, 3)).toBe(0.001)
    // 0.1 + 0.2 style errors never reach Xero.
    expect(minorToDecimal(30, 2)).toBe(0.3)
    expect(() => minorToDecimal(1.5, 2)).toThrow(XeroInvoiceError)
  })

  it('reads Xero’s decimals back as exact minor units, and refuses fractions', () => {
    expect(decimalToMinor(19.99, 2)).toBe(1999)
    expect(decimalToMinor(0.3, 2)).toBe(30)
    expect(decimalToMinor(3900, 0)).toBe(3900)
    expect(decimalToMinor(19.995, 2)).toBeNull()
    expect(decimalToMinor('19.99', 2)).toBeNull()
    expect(decimalToMinor(null, 2)).toBeNull()
  })
})

describe('invoice input @S-102', () => {
  it('accepts lines that add up to the expected total', () => {
    expect(invoiceInputProblems(input())).toEqual([])
  })

  it('refuses lines that do not add up, fractional money, and an unsafe reference', () => {
    expect(invoiceInputProblems(input({ expectedTotal: 5000 }))).toEqual([
      'the lines add up to 4900, not the expected total 5000',
    ])
    expect(invoiceInputProblems(input({ lines: [{ description: 'x', quantity: 1, unitAmount: 1.5 }] }))).toContain(
      'line 1: unitAmount must be whole minor units',
    )
    expect(invoiceInputProblems(input({ reference: 'Order "12"' }))).toContain('reference cannot contain a quote or backslash')
    expect(invoiceInputProblems(input({ expectedTotal: 0 }))).toContain('expectedTotal must be above 0')
  })

  it('builds an ACCREC draft with the settings’ branding and tracking, and no tax fields without tax', () => {
    const body = buildDraftInvoice(input(), 'contact-1', {
      brandingThemeId: 'theme-1',
      tracking: { name: 'Region', option: 'Efate' },
    })

    expect(body).toEqual({
      BrandingThemeID: 'theme-1',
      Contact: { ContactID: 'contact-1' },
      CurrencyCode: 'VUV',
      LineAmountTypes: 'NoTax',
      LineItems: [
        { AccountCode: '225', Description: 'Basic', Quantity: 1, Tracking: [{ Name: 'Region', Option: 'Efate' }], UnitAmount: 3900 },
        { AccountCode: '226', Description: 'Featured', Quantity: 1, Tracking: [{ Name: 'Region', Option: 'Efate' }], UnitAmount: 1500 },
        { AccountCode: '227', Description: 'Coupon SAVE', Quantity: 1, Tracking: [{ Name: 'Region', Option: 'Efate' }], UnitAmount: -500 },
      ],
      Reference: 'Order 12',
      Status: 'DRAFT',
      Type: 'ACCREC',
    })
  })

  it('sends per-line tax and discounts in decimals when the invoice is taxed', () => {
    const body = buildDraftInvoice(
      {
        ...input(),
        currency: 'NZD',
        expectedTotal: 1150,
        lineAmountTypes: 'Exclusive',
        lines: [{ description: 'Basic', discountAmount: 100, quantity: 1, taxAmount: 150, taxType: 'OUTPUT2', unitAmount: 1100 }],
      },
      'contact-1',
    )

    expect(body.LineItems).toEqual([
      { Description: 'Basic', DiscountAmount: 1, Quantity: 1, TaxAmount: 1.5, TaxType: 'OUTPUT2', UnitAmount: 11 },
    ])
  })

  it('refuses to build an invoice from a bad input', () => {
    expect(() => buildDraftInvoice(input({ lines: [] }), 'c')).toThrow(/at least one line/)
  })
})

const link = (url: string) => vi.fn(async () => json({ OnlineInvoices: [{ OnlineInvoiceUrl: url }] }))

describe('Xero calls @S-151', () => {
  it('sends the idempotency key and the organisation with a create, and never leaks the token in errors', async () => {
    const fetch = vi.fn(async () => json({ Elements: [{ ValidationErrors: [{ Message: 'Account code is invalid' }] }] }, 400))

    const error = await createDraftInvoice(api(fetch), { Type: 'ACCREC' }, 'key-1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(XeroInvoiceError)
    expect(error).toMatchObject({ code: 'xero_rejected', retryable: false })
    expect((error as Error).message).toContain('Account code is invalid')
    expect(JSON.stringify(error)).not.toContain('secret-token')
    expect((error as Error).message).not.toContain('secret-token')

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.xero.com/api.xro/2.0/Invoices')
    expect(init.method).toBe('PUT')
    const headers = new Headers(init.headers)
    expect(headers.get('idempotency-key')).toBe('key-1')
    expect(headers.get('xero-tenant-id')).toBe('org-1')
  })

  it.each([401, 429, 500, 503])('treats HTTP %i as retryable', async (status) => {
    const fetch = vi.fn(async () => json({}, status))

    await expect(createDraftInvoice(api(fetch), {}, 'k')).rejects.toMatchObject({ code: 'xero_unavailable', retryable: true })
  })

  it('treats a network failure or timeout as retryable', async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })

    await expect(createDraftInvoice(api(fetch), {}, 'k')).rejects.toMatchObject({
      code: 'xero_unavailable',
      message: 'Xero did not answer in time.',
    })
  })

  it('refuses to call Xero without a token or organisation', async () => {
    const fetch = vi.fn()

    await expect(createDraftInvoice({ accessToken: '', fetch, tenantId: 'org' }, {}, 'k')).rejects.toMatchObject({
      code: 'not_connected',
      retryable: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('looks an invoice up by its exact reference, leaving out voided ones', async () => {
    const fetch = vi.fn(async () =>
      json({ Invoices: [{ InvoiceID: ID, Reference: 'Order 12' }, { InvoiceID: ID, Reference: 'order 12' }] }),
    )

    const found = await findInvoicesByReference(api(fetch), 'Order 12')

    expect(found).toEqual([{ InvoiceID: ID, Reference: 'Order 12' }])
    const url = new URL((fetch.mock.calls[0] as unknown as [string])[0])
    expect(url.searchParams.get('where')).toBe('Type=="ACCREC" AND Reference=="Order 12"')
    expect(url.searchParams.get('Statuses')).toBe('DRAFT,SUBMITTED,AUTHORISED,PAID')
    await expect(findInvoicesByReference(api(fetch), 'x" OR Reference!="')).rejects.toMatchObject({ code: 'invalid_invoice' })
  })

  it('authorises with the due date, and only for a well-formed invoice id', async () => {
    const fetch = vi.fn(async () => json({ Invoices: [{ InvoiceID: ID, Status: 'AUTHORISED' }] }))

    await authoriseInvoice(api(fetch), { dueDate: '2026-12-05', invoiceId: ID }, 'auth-key')

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.xero.com/api.xro/2.0/Invoices/${ID}`)
    expect(JSON.parse(String(init.body))).toEqual({ Invoices: [{ DueDate: '2026-12-05', InvoiceID: ID, Status: 'AUTHORISED' }] })
    await expect(authoriseInvoice(api(fetch), { dueDate: '2026-12-05', invoiceId: '../Contacts' }, 'k')).rejects.toMatchObject({
      code: 'invalid_invoice',
    })
  })

  it('keeps only an https online invoice link', async () => {
    expect(await getOnlineInvoiceUrl(api(link('https://in.xero.com/abc')), ID)).toBe('https://in.xero.com/abc')
    expect(await getOnlineInvoiceUrl(api(link('javascript:alert(1)')), ID)).toBeNull()
    expect(await getOnlineInvoiceUrl(api(vi.fn(async () => json({ OnlineInvoices: [] }))), ID)).toBeNull()
  })
})

describe('due dates @S-102', () => {
  it('reads Xero’s invoice day and adds the due days across month and year ends', () => {
    expect(xeroDay({ DateString: '2026-11-21T00:00:00' })).toBe('2026-11-21')
    expect(xeroDay({ Date: '/Date(1795219200000+0000)/' })).toBe('2026-11-21')
    expect(xeroDay({})).toBeNull()
    expect(addDays('2026-11-21', 14)).toBe('2026-12-05')
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08')
    expect(addDays('2028-02-20', 14)).toBe('2028-03-05')
  })
})
