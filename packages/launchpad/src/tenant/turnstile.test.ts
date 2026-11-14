import { describe, expect, it } from 'vitest'

import {
  TURNSTILE_RESPONSE_FIELD,
  isTurnstileSiteKey,
  turnstileErrorMessage,
  turnstileScriptUrl,
  turnstileWidgetOptions,
} from './turnstile'

describe('isTurnstileSiteKey', () => {
  it('accepts the documented test and production key shapes', () => {
    expect(isTurnstileSiteKey('1x00000000000000000000AA')).toBe(true)
    expect(isTurnstileSiteKey('0x4AAAAAAABkMYinukE8nzY')).toBe(true)
  })

  it('rejects an unset key and any placeholder text', () => {
    expect(isTurnstileSiteKey(undefined)).toBe(false)
    expect(isTurnstileSiteKey('')).toBe(false)
    expect(isTurnstileSiteKey('YOUR_SITE_KEY')).toBe(false)
    expect(isTurnstileSiteKey('0x123')).toBe(false)
  })
})

describe('turnstileScriptUrl', () => {
  it('asks for explicit rendering so the widget is created in place', () => {
    expect(turnstileScriptUrl()).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    )
  })
})

describe('turnstileErrorMessage', () => {
  it('tells the visitor to complete the check when the token is missing', () => {
    expect(turnstileErrorMessage('missing-input-response')).toBe(
      'Please complete the verification before sending the form.',
    )
  })

  it('asks the visitor to try again when the token expired or was reused', () => {
    expect(turnstileErrorMessage('timeout-or-duplicate')).toBe(
      'The verification expired. Please try again.',
    )
  })

  it('never leaks the raw code for an unknown or absent error', () => {
    expect(turnstileErrorMessage(undefined)).toBe(
      'Please complete the verification before sending the form.',
    )
    expect(turnstileErrorMessage('something-new')).toBe('Verification failed. Please try again.')
  })

  it('covers every documented error code with its own message', () => {
    expect(turnstileErrorMessage('invalid-input-secret')).toContain('configured correctly')
    expect(turnstileErrorMessage('internal-error')).toContain('unavailable')
  })
})

describe('turnstileWidgetOptions', () => {
  it('defaults the theme and language, and fills the field name Turnstile posts back', () => {
    expect(turnstileWidgetOptions({ action: 'apply', siteKey: '0x4AAAAAAABkMYinukE8nzY' })).toEqual({
      action: 'apply',
      language: 'auto',
      sitekey: '0x4AAAAAAABkMYinukE8nzY',
      theme: 'auto',
    })
    expect(TURNSTILE_RESPONSE_FIELD).toBe('cf-turnstile-response')
  })
})
