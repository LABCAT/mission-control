import { describe, expect, it } from 'vitest'

import {
  DEFAULT_FORM_RETENTION_DAYS,
  formRetentionCutoff,
  formRetentionDays,
  formSubmissionData,
  formValueErrors,
  MAX_FORM_RETENTION_DAYS,
  parseFormSubmission,
  type FormDefinition,
} from './forms'

const DAY = 24 * 60 * 60 * 1000

const contactForm: FormDefinition = {
  id: 1,
  fields: [
    { blockType: 'text', label: 'Your name', name: 'name', required: true },
    { blockType: 'email', label: 'Email', name: 'email', required: true },
    { blockType: 'textarea', label: 'Message', name: 'message', required: true },
    { blockType: 'message', message: {} },
    { blockType: 'select', label: 'Reason', name: 'reason', options: [{ label: 'Jobs', value: 'jobs' }, { label: 'Other', value: 'other' }] },
  ],
}

describe('formRetentionDays', () => {
  it('defaults to 90 days when the tenant has not chosen @S-322', () => {
    expect(DEFAULT_FORM_RETENTION_DAYS).toBe(90)
    expect(formRetentionDays(null)).toBe(90)
    expect(formRetentionDays({})).toBe(90)
    expect(formRetentionDays({ formRetentionDays: null })).toBe(90)
  })

  it('keeps 0, which means "email only, store nothing"', () => {
    expect(formRetentionDays({ formRetentionDays: 0 })).toBe(0)
  })

  it('accepts a whole number of days and floors a fraction', () => {
    expect(formRetentionDays({ formRetentionDays: 30 })).toBe(30)
    expect(formRetentionDays({ formRetentionDays: 30.7 })).toBe(30)
  })

  it('refuses a negative or nonsense value instead of shortening the period', () => {
    expect(formRetentionDays({ formRetentionDays: -5 })).toBe(90)
    expect(formRetentionDays({ formRetentionDays: Number.NaN })).toBe(90)
    expect(formRetentionDays({ formRetentionDays: '12' })).toBe(90)
  })

  it('caps an absurd value at the maximum', () => {
    expect(formRetentionDays({ formRetentionDays: 99_999 })).toBe(MAX_FORM_RETENTION_DAYS)
  })
})

describe('formRetentionCutoff', () => {
  const now = new Date('2026-11-23T12:00:00.000Z')

  it('is exactly the retention period before now @S-322', () => {
    expect(formRetentionCutoff(90, now).toISOString()).toBe('2026-08-25T12:00:00.000Z')
  })

  it('is now at 0 days, so nothing stored survives the next run', () => {
    expect(formRetentionCutoff(0, now).toISOString()).toBe(now.toISOString())
  })

  it('keeps a submission dated one day inside the boundary', () => {
    const cutoff = formRetentionCutoff(30, now)
    const inside = new Date(cutoff.getTime() + DAY)

    expect(inside > cutoff).toBe(true)
  })

  it('deletes a submission dated one day past the boundary', () => {
    const cutoff = formRetentionCutoff(30, now)
    const outside = new Date(cutoff.getTime() - 1)

    expect(outside < cutoff).toBe(true)
  })
})

describe('formValueErrors', () => {
  it('accepts a complete set of answers', () => {
    expect(
      formValueErrors(contactForm, {
        email: 'ada@example.invalid',
        message: 'Hello',
        name: 'Ada',
        reason: 'jobs',
      }),
    ).toEqual([])
  })

  it('requires a required field and names it in the message', () => {
    const errors = formValueErrors(contactForm, { email: 'ada@example.invalid', message: 'Hi' })

    expect(errors).toEqual([{ message: 'Your name is required', path: 'name' }])
  })

  it('treats whitespace as empty', () => {
    expect(
      formValueErrors(contactForm, { email: 'ada@example.invalid', message: '   ', name: 'Ada' }),
    ).toEqual([{ message: 'Message is required', path: 'message' }])
  })

  it('checks an email field', () => {
    expect(
      formValueErrors(contactForm, { email: 'not-an-email', message: 'Hi', name: 'Ada' }),
    ).toEqual([{ message: 'Email must be an email address', path: 'email' }])
  })

  it('refuses a select value the editor never offered', () => {
    expect(
      formValueErrors(contactForm, {
        email: 'ada@example.invalid',
        message: 'Hi',
        name: 'Ada',
        reason: 'injected',
      }),
    ).toEqual([{ message: 'Reason is not one of the choices', path: 'reason' }])
  })

  it('ignores a message block, which has no answer', () => {
    expect(
      formValueErrors(contactForm, { email: 'ada@example.invalid', message: 'Hi', name: 'Ada' })
        .length,
    ).toBe(0)
  })
})

describe('formSubmissionData', () => {
  it('stores only the answered fields, in the form order @S-320', () => {
    expect(
      formSubmissionData(contactForm, {
        email: 'ada@example.invalid',
        message: 'Hello',
        name: 'Ada',
        // Not a field of this form, so it is dropped rather than stored.
        tenant: '5',
      }),
    ).toEqual([
      { field: 'name', value: 'Ada' },
      { field: 'email', value: 'ada@example.invalid' },
      { field: 'message', value: 'Hello' },
    ])
  })

  it('stores a ticked checkbox as "true" and an unticked one as nothing', () => {
    const form: FormDefinition = {
      fields: [{ blockType: 'checkbox', label: 'News', name: 'news' }],
      id: 2,
    }

    expect(formSubmissionData(form, { news: 'true' })).toEqual([{ field: 'news', value: 'true' }])
    expect(formSubmissionData(form, {})).toEqual([])
  })
})

describe('parseFormSubmission', () => {
  it('reads the JSON a site sends, with the answers under `values`', () => {
    const parsed = parseFormSubmission(
      'application/json',
      JSON.stringify({
        form: 7,
        turnstileToken: 'token',
        values: { email: 'ada@example.invalid', name: 'Ada' },
      }),
    )

    expect(parsed).toEqual({
      form: 7,
      honeypot: undefined,
      turnstileToken: 'token',
      values: { email: 'ada@example.invalid', name: 'Ada' },
    })
  })

  it('reads a browser form post directly, so a site can proxy it verbatim', () => {
    const body = new URLSearchParams({
      'cf-turnstile-response': 'token',
      email: 'ada@example.invalid',
      form: '7',
      message: 'Hello',
      name: 'Ada',
      'rp-website': '',
    }).toString()

    const parsed = parseFormSubmission('application/x-www-form-urlencoded', body)

    expect(parsed.form).toBe('7')
    expect(parsed.turnstileToken).toBe('token')
    expect(parsed.honeypot).toBe('')
    expect(parsed.values).toEqual({ email: 'ada@example.invalid', message: 'Hello', name: 'Ada' })
  })

  it('keeps the honeypot and token out of the stored answers', () => {
    const parsed = parseFormSubmission(
      'application/json',
      JSON.stringify({ form: 1, 'rp-website': 'bot', values: { name: 'Ada' } }),
    )

    expect(parsed.honeypot).toBe('bot')
    expect(parsed.values).toEqual({ name: 'Ada' })
  })

  it('rejects a body that is not an object', () => {
    expect(() => parseFormSubmission('application/json', '"nope"')).toThrow(/not valid/)
    expect(() => parseFormSubmission('application/json', '{')).toThrow(/not valid/)
  })
})
