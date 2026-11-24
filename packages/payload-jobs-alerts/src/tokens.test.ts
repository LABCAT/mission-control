import { describe, expect, it } from 'vitest'

import {
  ALERT_TOKEN_TTL_MS,
  signAlertToken,
  verifyAlertToken,
  type AlertTokenPurpose,
} from './tokens'

const SECRET = 'a-secret-of-some-length'
const NOW = new Date('2026-11-24T00:00:00Z')

const sign = (purpose: AlertTokenPurpose = 'confirm', subject = '42', tenant: number | string = 1) =>
  signAlertToken({ now: NOW, purpose, secret: SECRET, subject, tenant })

const verify = (
  token: string,
  purpose: AlertTokenPurpose = 'confirm',
  tenant: number | string = 1,
  now: Date = NOW,
  secret = SECRET,
) => verifyAlertToken({ now, purpose, secret, tenant, token })

describe('alert tokens @S-360 @S-087', () => {
  it('round-trips the subject for its own purpose and tenant', async () => {
    expect(await verify(await sign())).toEqual({ subject: '42' })
    expect(await verify(await sign('manage', 'a@example.com'), 'manage')).toEqual({
      subject: 'a@example.com',
    })
  })

  it('is URL-safe, so it fits a path segment in an email', async () => {
    expect(await sign('manage', 'a+b@example.com')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })

  it('refuses a token used for another purpose, so a confirm link cannot unsubscribe', async () => {
    const token = await sign('confirm')

    expect(await verify(token, 'unsubscribe')).toBeNull()
    expect(await verify(token, 'manage')).toBeNull()
  })

  it('refuses a token from another tenant', async () => {
    expect(await verify(await sign('confirm', '42', 1), 'confirm', 2)).toBeNull()
    expect(await verify(await sign('confirm', '42', 1), 'confirm', '1')).toEqual({ subject: '42' })
  })

  it('refuses a token signed with another secret', async () => {
    expect(await verify(await sign(), 'confirm', 1, NOW, 'another-secret')).toBeNull()
  })

  it('refuses a payload that was edited after signing', async () => {
    const [payload, signature] = (await sign('confirm', '42')).split('.')
    const forged = btoa(JSON.stringify({ e: 0, p: 'confirm', s: '43', t: '1' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    expect(forged).not.toBe(payload)
    expect(await verify(`${forged}.${signature}`)).toBeNull()
  })

  it.each(['', 'nodot', 'a.b.c', '.', 'abc.', '.abc', '%%%.%%%', 'e30.e30'])(
    'refuses garbage: %j',
    async (token) => {
      expect(await verify(token)).toBeNull()
    },
  )

  it('expires a confirm token after its lifetime, to the millisecond', async () => {
    const token = await sign('confirm')
    const ttl = ALERT_TOKEN_TTL_MS.confirm as number

    expect(await verify(token, 'confirm', 1, new Date(NOW.getTime() + ttl - 1))).not.toBeNull()
    expect(await verify(token, 'confirm', 1, new Date(NOW.getTime() + ttl))).toBeNull()
  })

  it('expires a manage link, but never an unsubscribe link', async () => {
    const manage = await sign('manage', 'a@example.com')
    const unsubscribe = await sign('unsubscribe', '7')
    const later = new Date(NOW.getTime() + 400 * 24 * 60 * 60 * 1000)

    expect(ALERT_TOKEN_TTL_MS.unsubscribe).toBeNull()
    expect(await verify(manage, 'manage', 1, later)).toBeNull()
    expect(await verify(unsubscribe, 'unsubscribe', 1, later)).toEqual({ subject: '7' })
  })

  it('refuses to sign with an empty secret', async () => {
    await expect(
      signAlertToken({ purpose: 'confirm', secret: '', subject: '1', tenant: 1 }),
    ).rejects.toThrow(/secret/)
  })
})
