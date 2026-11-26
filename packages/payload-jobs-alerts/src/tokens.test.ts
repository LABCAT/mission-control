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

describe('alert tokens @S-370 @S-087', () => {
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

  it('refuses a token with any byte changed', async () => {
    const token = await sign('confirm', '42')
    const [iv, sealed] = token.split('.') as [string, string]
    // Flip one character in the sealed part, and one in the iv.
    const flip = (value: string) => `${value.slice(0, 3)}${value[3] === 'A' ? 'B' : 'A'}${value.slice(4)}`

    expect(await verify(`${iv}.${flip(sealed)}`)).toBeNull()
    expect(await verify(`${flip(iv)}.${sealed}`)).toBeNull()
    expect(await verify(`${iv}.${sealed.slice(0, -2)}`)).toBeNull()
  })

  it('keeps the subscriber’s address unreadable: a manage link ends up in logs and history', async () => {
    const token = await sign('manage', 'jane@example.com')
    const decoded = (part: string) => {
      try {
        return atob(part.replace(/-/g, '+').replace(/_/g, '/'))
      } catch {
        return ''
      }
    }

    for (const part of token.split('.')) {
      expect(decoded(part)).not.toContain('jane')
      expect(decoded(part)).not.toContain('example.com')
    }
    expect(token).not.toContain('jane')
  })

  it('makes each token of the same thing different, so a link cannot be matched by eye', async () => {
    expect(await sign('manage', 'jane@example.com')).not.toBe(await sign('manage', 'jane@example.com'))
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
