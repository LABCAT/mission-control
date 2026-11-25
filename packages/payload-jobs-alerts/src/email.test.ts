import { createEmailEventRegistry, renderEmail, type SendTemplateResult } from '@mission-control/payload-jobs'
import type { Payload } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { ALERT_EMAIL_TEMPLATE_EVENTS, createAlertTemplateSender, type AlertEmailDoc } from './email'

const confirmDoc: AlertEmailDoc = {
  email: 'jo@example.com',
  id: 7,
  tenant: 3,
  variables: {
    alertSummary: '“cook” · <b>Efate</b>',
    confirmUrl: 'https://vwok.example/alerts/confirm/abc.def',
    frequency: 'weekly',
    manageUrl: 'https://vwok.example/alerts/manage/ghi.jkl',
    siteName: 'Vanuatu Wok',
  },
}

const sendResult = (status: SendTemplateResult['status']): SendTemplateResult => ({ redirected: false, status })

describe('alert email templates @S-375', () => {
  const registry = createEmailEventRegistry(ALERT_EMAIL_TEMPLATE_EVENTS)

  it('declares both events with the variables the service passes, so a tenant can edit them', () => {
    expect([...registry.keys()]).toEqual(expect.arrayContaining(['alert-confirm', 'alert-manage-link']))
    expect(registry.get('alert-confirm')!.variables.map((variable) => variable.key)).toEqual([
      'siteName',
      'alertSummary',
      'frequency',
      'confirmUrl',
      'manageUrl',
    ])
    expect(registry.get('alert-manage-link')!.variables.map((variable) => variable.key)).toEqual([
      'siteName',
      'manageUrl',
    ])
  })

  it('addresses the email to the subscriber', () => {
    expect(registry.get('alert-confirm')!.recipient!({ email: 'jo@example.com' })).toBe('jo@example.com')
  })

  it('renders the confirmation with the link, and escapes what a visitor typed', async () => {
    const rendered = await renderEmail({ doc: { ...confirmDoc.variables, email: confirmDoc.email }, event: registry.get('alert-confirm')! })

    expect(rendered.subject).toBe('Confirm your job alert on Vanuatu Wok')
    expect(rendered.html).toContain('https://vwok.example/alerts/confirm/abc.def')
    expect(rendered.text).toContain('https://vwok.example/alerts/confirm/abc.def')
    expect(rendered.html).not.toContain('<b>Efate</b>')
    expect(rendered.html).toContain('&lt;b&gt;Efate&lt;/b&gt;')
  })

  it('renders the manage-link email', async () => {
    const rendered = await renderEmail({
      doc: { manageUrl: 'https://vwok.example/alerts/manage/x.y', siteName: 'Vanuatu Wok' },
      event: registry.get('alert-manage-link')!,
    })

    expect(rendered.subject).toBe('Manage your job alerts on Vanuatu Wok')
    expect(rendered.text).toContain('https://vwok.example/alerts/manage/x.y')
  })
})

describe('createAlertTemplateSender @S-375', () => {
  const payload = {} as Payload

  it('sends through sendTemplate to the subscriber, for the tenant, linked to the alert', async () => {
    const send = vi.fn(async (..._args: unknown[]) => sendResult('sent'))
    await createAlertTemplateSender(send as never)('alert-confirm', confirmDoc, { alertsSlug: 'alert-subscriptions', payload })

    expect(send).toHaveBeenCalledWith(
      payload,
      'alert-confirm',
      { ...confirmDoc.variables, email: 'jo@example.com', tenant: 3 },
      { linked: { collection: 'alert-subscriptions', id: 7 }, tenant: 3, to: 'jo@example.com' },
    )
  })

  it('links nothing when the email is not about one alert', async () => {
    const send = vi.fn(async (..._args: unknown[]) => sendResult('sent'))
    await createAlertTemplateSender(send as never)(
      'alert-manage-link',
      { email: 'jo@example.com', tenant: 3, variables: { manageUrl: 'u', siteName: 's' } },
      { alertsSlug: 'alert-subscriptions', payload },
    )

    expect(send.mock.calls[0]![3]).toEqual({ tenant: 3, to: 'jo@example.com' })
  })

  it('treats a failed send as an error, so the visitor is told, and a skipped one as fine', async () => {
    const failed = createAlertTemplateSender((async () => ({ ...sendResult('failed'), error: 'no sender' })) as never)
    await expect(failed('alert-confirm', confirmDoc, { alertsSlug: 'a', payload })).rejects.toThrow(/no sender/)

    // The tenant switched this email off, or a preview has no redirect inbox: nothing to report.
    const skipped = createAlertTemplateSender((async () => sendResult('skipped')) as never)
    await expect(skipped('alert-confirm', confirmDoc, { alertsSlug: 'a', payload })).resolves.toBeUndefined()
  })
})
