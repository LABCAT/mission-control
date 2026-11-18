import { describe, expect, it } from 'vitest'

import { decryptToken, encryptToken, generateEncryptionKey, XeroCryptoError } from './crypto'

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.super-secret-refresh-token'

describe('token encryption', () => {
  it('round-trips a token', async () => {
    const key = generateEncryptionKey()
    const encrypted = await encryptToken(TOKEN, key)

    expect(encrypted).not.toContain(TOKEN)
    expect(await decryptToken(encrypted, key)).toBe(TOKEN)
  })

  it('uses a fresh IV, so equal tokens encrypt differently', async () => {
    const key = generateEncryptionKey()

    expect(await encryptToken(TOKEN, key)).not.toBe(await encryptToken(TOKEN, key))
  })

  it('fails to decrypt with the wrong key', async () => {
    const encrypted = await encryptToken(TOKEN, generateEncryptionKey())

    await expect(decryptToken(encrypted, generateEncryptionKey())).rejects.toThrow(XeroCryptoError)
  })

  it('fails when the ciphertext is tampered with', async () => {
    const key = generateEncryptionKey()
    const [version, iv, ciphertext] = (await encryptToken(TOKEN, key)).split('.')
    const flipped = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1)

    await expect(decryptToken(`${version}.${iv}.${flipped}`, key)).rejects.toThrow('Could not decrypt token')
    await expect(decryptToken(`${version}.${iv}.${ciphertext.slice(0, -4)}`, key)).rejects.toThrow(
      XeroCryptoError,
    )
  })

  it('fails when the IV is tampered with', async () => {
    const key = generateEncryptionKey()
    const [version, iv, ciphertext] = (await encryptToken(TOKEN, key)).split('.')
    const flipped = (iv[0] === 'A' ? 'B' : 'A') + iv.slice(1)

    await expect(decryptToken(`${version}.${flipped}.${ciphertext}`, key)).rejects.toThrow(XeroCryptoError)
  })

  it('binds the token to its context, so it cannot move to another tenant', async () => {
    const key = generateEncryptionKey()
    const encrypted = await encryptToken(TOKEN, key, 'tenant:1')

    expect(await decryptToken(encrypted, key, 'tenant:1')).toBe(TOKEN)
    await expect(decryptToken(encrypted, key, 'tenant:2')).rejects.toThrow(XeroCryptoError)
    await expect(decryptToken(encrypted, key)).rejects.toThrow(XeroCryptoError)
  })

  it('rejects malformed payloads', async () => {
    const key = generateEncryptionKey()

    for (const bad of ['', 'garbage', 'v2.a.b', 'v1.a', 'v1.!!.??']) {
      await expect(decryptToken(bad, key)).rejects.toThrow(XeroCryptoError)
    }
  })

  it('rejects a missing, non-base64 or wrong-length key', async () => {
    await expect(encryptToken(TOKEN, undefined)).rejects.toThrow('is not set')
    await expect(encryptToken(TOKEN, '***')).rejects.toThrow('must be base64')
    await expect(encryptToken(TOKEN, btoa('too short'))).rejects.toThrow('32 bytes')
  })

  it('never leaks the token or key in an error message', async () => {
    const key = generateEncryptionKey()
    const encrypted = await encryptToken(TOKEN, key)
    const errors: string[] = []

    for (const attempt of [
      () => decryptToken(encrypted, generateEncryptionKey()),
      () => decryptToken(encrypted.slice(0, -3), key),
      () => encryptToken(TOKEN, 'bad-key'),
    ]) {
      await attempt().catch((error: Error) => errors.push(error.message))
    }

    expect(errors).toHaveLength(3)
    for (const message of errors) {
      expect(message).not.toContain(TOKEN)
      expect(message).not.toContain(key)
      expect(message).not.toContain(encrypted)
    }
  })
})
