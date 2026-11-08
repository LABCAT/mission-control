import { describe, expect, it, vi } from 'vitest'

import { cloudflareEmailAdapter, mapToCloudflareEmailMessage } from './cloudflare-email-adapter'

describe('mapToCloudflareEmailMessage', () => {
  it('maps nodemailer address/name objects to the binding email/name shape', () => {
    const message = mapToCloudflareEmailMessage({
      from: { name: 'Vanuatu Wok', address: 'jobs@vanuatuwok.vu' },
      to: [{ name: 'Applicant', address: 'applicant@example.com' }, 'cc@example.com'],
      subject: 'Your application',
      html: '<p>Thanks</p>',
    })

    expect(message).toEqual({
      from: { name: 'Vanuatu Wok', email: 'jobs@vanuatuwok.vu' },
      to: [{ name: 'Applicant', email: 'applicant@example.com' }, 'cc@example.com'],
      subject: 'Your application',
      html: '<p>Thanks</p>',
    })
  })

  it('passes a plain-string from through unchanged', () => {
    const message = mapToCloudflareEmailMessage({
      from: 'jobs@vanuatuwok.vu',
      to: 'applicant@example.com',
      subject: 's',
    })

    expect(message.from).toBe('jobs@vanuatuwok.vu')
    expect(message.to).toBe('applicant@example.com')
    expect(message.subject).toBe('s')
  })
})

describe('cloudflareEmailAdapter (dev)', () => {
  it('logs instead of sending when there is no binding, and never logs the body', async () => {
    const info = vi.fn()
    const adapter = cloudflareEmailAdapter({ payload: { logger: { info } } as never })

    await adapter.sendEmail({
      from: 'jobs@vanuatuwok.vu',
      to: 'applicant@example.com',
      subject: 'Your application',
      html: '<p>secret token 123</p>',
    })

    expect(info).toHaveBeenCalledTimes(1)
    const logged = String((info.mock.calls[0]?.[0] as { msg?: string })?.msg)
    expect(logged).toContain('applicant@example.com')
    expect(logged).toContain('Your application')
    expect(logged).not.toContain('secret token 123')
  })
})
