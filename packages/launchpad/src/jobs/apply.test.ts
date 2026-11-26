import { describe, expect, it } from 'vitest'

import { applyMode, applyOutcome, applyPath, signInPath } from './apply'

const base = { accountRequired: false, applyOnline: true, hasHowToApply: true, live: true }

describe('applyMode', () => {
  it('shows the form for a live job with online applying on @S-049', () => {
    expect(applyMode(base)).toBe('form')
  })

  it('shows the how-to-apply text when online applying is off @S-032', () => {
    expect(applyMode({ ...base, applyOnline: false })).toBe('how-to')
  })

  it('shows nothing when online applying is off and there are no instructions', () => {
    expect(applyMode({ ...base, applyOnline: false, hasHowToApply: false })).toBe('none')
  })

  it('asks for sign-in when the site requires an account @S-050', () => {
    expect(applyMode({ ...base, accountRequired: true })).toBe('sign-in')
  })

  it('shows no apply section for a closed job, whatever the settings @S-282', () => {
    expect(applyMode({ ...base, live: false })).toBe('none')
    expect(applyMode({ ...base, accountRequired: true, live: false })).toBe('none')
  })

  it('lets how-to win over the account rule, because there is no form to protect', () => {
    expect(applyMode({ ...base, accountRequired: true, applyOnline: false })).toBe('how-to')
  })
})

describe('paths', () => {
  it('builds the apply page path', () => {
    expect(applyPath('head chef')).toBe('/jobs/head%20chef/apply')
  })

  it('returns to a local path only @S-050', () => {
    expect(signInPath('/jobs/x/apply')).toBe('/account/sign-in?return=%2Fjobs%2Fx%2Fapply')
    expect(signInPath('https://evil.example/')).toBe('/account/sign-in?return=%2F')
    expect(signInPath('//evil.example/')).toBe('/account/sign-in?return=%2F')
  })
})

describe('applyOutcome', () => {
  it('reads a stored application as sent @S-049', () => {
    expect(applyOutcome(201, { ok: true })).toEqual({ kind: 'sent' })
  })

  it('carries field errors for the form to show @S-049', () => {
    const outcome = applyOutcome(400, {
      error: { code: 'invalid_values', errors: [{ field: 'cv', message: 'Attach your CV.' }], message: 'Attach your CV.' },
    })

    expect(outcome).toEqual({ errors: [{ field: 'cv', message: 'Attach your CV.' }], kind: 'invalid', message: 'Attach your CV.' })
  })

  it('asks a guest to sign in @S-050', () => {
    expect(applyOutcome(401, { error: { code: 'sign_in_required' } })).toEqual({ kind: 'sign-in' })
  })

  it('treats a closed job, an offline job and an unknown job alike', () => {
    for (const code of ['job_closed', 'apply_offline', 'not_found']) {
      expect(applyOutcome(409, { error: { code } }).kind).toBe('closed')
    }
  })

  it('reports rate limiting and unknown failures without echoing server text', () => {
    expect(applyOutcome(429, { error: { code: 'too_many_requests' } }).kind).toBe('rate-limited')
    const failure = applyOutcome(500, { error: { code: 'server_error', message: 'stack trace' } })
    expect(failure).toEqual({ kind: 'error', message: 'We could not send your application. Please try again.' })
    expect(applyOutcome(502, 'not json').kind).toBe('error')
  })
})
