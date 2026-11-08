import { describe, expect, it, vi } from 'vitest'

import { createTenantEmailSender, mapTenantEmailMessage } from './email'

const tenant = {
  emailFromName: 'Vanuatu Wok',
  emailFromAddress: 'jobs@vanuatuwok.vu',
}

describe('mapTenantEmailMessage', () => {
  it('takes the from name and address from the tenant and passes the rest through', () => {
    const message = mapTenantEmailMessage({
      tenant,
      to: 'applicant@example.com',
      subject: 'Your application',
      html: '<p>Thanks</p>',
    })

    expect(message).toEqual({
      from: { name: 'Vanuatu Wok', address: 'jobs@vanuatuwok.vu' },
      to: 'applicant@example.com',
      subject: 'Your application',
      html: '<p>Thanks</p>',
    })
  })

  it('omits the name and leaves an empty address when the tenant has no sender', () => {
    const message = mapTenantEmailMessage({
      tenant: { emailFromName: null, emailFromAddress: null },
      to: 'a@example.com',
      subject: 's',
      html: 'h',
    })

    expect(message.from).toEqual({ address: '' })
    expect('name' in message.from).toBe(false)
  })
})

describe('createTenantEmailSender', () => {
  it('sends the mapped message through the payload email adapter', async () => {
    const sendEmail = vi.fn(async () => undefined)
    const sendTenantEmail = createTenantEmailSender({ sendEmail })

    await sendTenantEmail({
      tenant,
      to: 'applicant@example.com',
      subject: 'Your application',
      html: '<p>Thanks</p>',
    })

    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledWith({
      from: { name: 'Vanuatu Wok', address: 'jobs@vanuatuwok.vu' },
      to: 'applicant@example.com',
      subject: 'Your application',
      html: '<p>Thanks</p>',
    })
  })
})
