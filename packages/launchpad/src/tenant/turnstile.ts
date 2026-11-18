/**
 * Cloudflare Turnstile is the only client-side JavaScript on a site: it guards the apply,
 * alert and contact forms. The site key comes from the deployment's environment, never from
 * a tenant document, because it is paired with the secret key that verifies the token.
 */

export const TURNSTILE_API = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

/**
 * Turnstile site keys start with `0x` (production) or `1x`–`3x` (Cloudflare's test keys that
 * always pass or always fail). Secret keys start with `0x` too but are longer, so a secret
 * pasted into the public variable is caught by its suffix.
 */
const SITE_KEY = /^[0-3]x[A-Za-z0-9_-]{18,}$/

export const isTurnstileSiteKey = (value: null | string | undefined): value is string =>
  typeof value === 'string' && SITE_KEY.test(value)

/** The script URL for explicit rendering, so the widget is created where the component is. */
export const turnstileScriptUrl = (api = TURNSTILE_API): string => `${api}?render=explicit`

export const TURNSTILE_ERROR_CODES = [
  'missing-input-secret',
  'invalid-input-secret',
  'missing-input-response',
  'invalid-input-response',
  'bad-request',
  'timeout-or-duplicate',
  'internal-error',
] as const

export type TurnstileErrorCode = (typeof TURNSTILE_ERROR_CODES)[number]

const MESSAGES: Record<TurnstileErrorCode, string> = {
  'bad-request': 'The verification request was malformed. Reload the page and try again.',
  'internal-error': 'The verification service is unavailable. Please try again.',
  'invalid-input-response': 'The verification expired. Please try again.',
  'invalid-input-secret': 'The verification is not configured correctly. Contact the site owner.',
  'missing-input-response': 'Please complete the verification before sending the form.',
  'missing-input-secret': 'The verification is not configured correctly. Contact the site owner.',
  'timeout-or-duplicate': 'The verification expired. Please try again.',
}

/** A visitor-facing message for a failed verification, never the raw error code. */
export const turnstileErrorMessage = (code: null | string | undefined): string => {
  if (!code) return MESSAGES['missing-input-response']
  return MESSAGES[code as TurnstileErrorCode] ?? 'Verification failed. Please try again.'
}

/** The name of the field Turnstile puts its token in; the server reads it from the form. */
export const TURNSTILE_RESPONSE_FIELD = 'cf-turnstile-response'

/** Shown only when JavaScript is off, because the widget cannot render without it. */
export const TURNSTILE_NOSCRIPT_MESSAGE =
  "This step needs JavaScript. If you can't enable it, email the address on our contact page."

export type TurnstileWidgetOptions = {
  action?: string
  language?: string
  siteKey: string
  theme?: 'auto' | 'dark' | 'light'
}

/** Widget options in the shape Turnstile's `render` call expects. */
export const turnstileWidgetOptions = (options: TurnstileWidgetOptions) => ({
  action: options.action,
  language: options.language ?? 'auto',
  // The component renders and fills its own hidden field; Turnstile's automatic one would
  // submit the same name twice, leaving the server an empty or ambiguous token.
  'response-field': false,
  sitekey: options.siteKey,
  theme: options.theme ?? 'auto',
})
