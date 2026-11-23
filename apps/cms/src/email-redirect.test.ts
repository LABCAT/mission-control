import { afterEach, describe, expect, it } from 'vitest'

import { emailRedirect } from './email-redirect'

afterEach(() => {
  delete process.env.ENVIRONMENT
  delete process.env.EMAIL_REDIRECT_TO
})

describe('emailRedirect @S-161', () => {
  it('is off only for ENVIRONMENT=production', () => {
    expect(emailRedirect({ ENVIRONMENT: 'production', EMAIL_REDIRECT_TO: 'a@x.test' })).toBeUndefined()
  })
  it.each([undefined, '', 'preview', 'staging', 'Prod', 'productionish'])('is on for %j', (environment) => {
    const config = emailRedirect({ ENVIRONMENT: environment, EMAIL_REDIRECT_TO: 'a@x.test' })
    expect(config?.to).toBe('a@x.test')
  })
  it('has no inbox when EMAIL_REDIRECT_TO is unset, so the adapter delivers nothing @S-163', () => {
    expect(emailRedirect({})?.to).toBeUndefined()
  })
  it('reads process.env outside Workers', () => {
    process.env.EMAIL_REDIRECT_TO = 'dev@x.test'
    expect(emailRedirect()).toEqual({ to: 'dev@x.test', label: 'non-production' })
  })
})
