/**
 * What the apply section of a job page shows, and how the apply page reads the CMS's answer
 * (PJ-45). Pure, so the rules are tested without a browser or a CMS.
 *
 * The job page itself ships no JavaScript: it shows a button to the apply page, which holds the
 * form and the Turnstile widget. The recipient of an application is never known to the site.
 */

/**
 * - `form`: a button to the apply page.
 * - `sign-in`: the site requires an account; the button goes to sign in and comes back.
 * - `how-to`: online applying is off, so the employer's own instructions are shown instead.
 * - `none`: nothing to apply for (closed job, or online applying off with no instructions).
 */
export type ApplyMode = 'form' | 'how-to' | 'none' | 'sign-in'

export const applyMode = ({
  accountRequired,
  applyOnline,
  hasHowToApply,
  live,
}: {
  accountRequired: boolean
  applyOnline: boolean
  hasHowToApply: boolean
  live: boolean
}): ApplyMode => {
  if (!live) return 'none'
  if (!applyOnline) return hasHowToApply ? 'how-to' : 'none'

  return accountRequired ? 'sign-in' : 'form'
}

/** `/jobs/{slug}/apply`. */
export const applyPath = (slug: string): string => `/jobs/${encodeURIComponent(slug)}/apply`

/** Where a guest signs in, with the page to come back to. Only a local path is ever returned to. */
export const signInPath = (returnTo: string, signIn = '/account/sign-in'): string =>
  `${signIn}?return=${encodeURIComponent(returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/')}`

export type ApplyFieldError = { field: string; message: string }

export type ApplyOutcome =
  | { kind: 'closed'; message: string }
  | { kind: 'error'; message: string }
  | { errors: ApplyFieldError[]; kind: 'invalid'; message: string }
  | { kind: 'rate-limited'; message: string }
  | { kind: 'sent' }
  | { kind: 'sign-in' }

type CmsApplyAnswer = {
  error?: { code?: string; errors?: ApplyFieldError[]; message?: string }
  ok?: boolean
}

/** Turn the CMS's status and body into what the page shows. Unknown answers become a generic error. */
export const applyOutcome = (status: number, body: unknown): ApplyOutcome => {
  const answer = (body && typeof body === 'object' ? body : {}) as CmsApplyAnswer
  const code = answer.error?.code
  const message = answer.error?.message?.trim()

  if (status >= 200 && status < 300 && answer.ok === true) return { kind: 'sent' }
  if (code === 'sign_in_required') return { kind: 'sign-in' }
  if (code === 'invalid_values' || code === 'turnstile_failed') {
    return {
      errors: Array.isArray(answer.error?.errors) ? answer.error!.errors! : [],
      kind: 'invalid',
      message: message || 'Check the form and try again.',
    }
  }
  if (code === 'job_closed' || code === 'apply_offline' || code === 'not_found') {
    return { kind: 'closed', message: message || 'This job is no longer accepting applications.' }
  }
  if (status === 429) {
    return { kind: 'rate-limited', message: 'Too many attempts. Wait a minute and try again.' }
  }

  return { kind: 'error', message: 'We could not send your application. Please try again.' }
}
