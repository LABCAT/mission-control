import type { Field } from 'payload'

/**
 * Per-tenant alert settings (PJ-47). The add-on appends these fields to the tenants collection
 * (or the settings global on a single-tenant site); every default is vwok's behaviour.
 */

export const ALERTS_ALLOW_WITHOUT_ACCOUNT_FIELD = 'alertsAllowWithoutAccount'
export const ALERTS_DOUBLE_OPT_IN_FIELD = 'alertsDoubleOptIn'
export const ALERTS_MAX_PER_EMAIL_FIELD = 'alertsMaxPerEmail'

export const DEFAULT_ALERTS_MAX_PER_EMAIL = 10
export const MAX_ALERTS_MAX_PER_EMAIL = 50

export type AlertSettings = {
  /** Visitors may subscribe with just an email address. Off means they must be signed in. */
  allowWithoutAccount: boolean
  /** A new alert waits for the emailed confirmation link. Off activates it at once. */
  doubleOptIn: boolean
  /** How many alerts one address can hold on this site. */
  maxPerEmail: number
}

/** A tenant (or settings global) as far as the alerts are concerned. */
export type AlertSettingsSource = Record<string, unknown> | null | undefined

/** Anything unset or unusable falls back to the default, never to "off". */
export const alertSettings = (source: AlertSettingsSource): AlertSettings => {
  const max = source?.[ALERTS_MAX_PER_EMAIL_FIELD]

  return {
    allowWithoutAccount: source?.[ALERTS_ALLOW_WITHOUT_ACCOUNT_FIELD] !== false,
    doubleOptIn: source?.[ALERTS_DOUBLE_OPT_IN_FIELD] !== false,
    maxPerEmail:
      typeof max === 'number' && Number.isInteger(max) && max >= 1
        ? Math.min(max, MAX_ALERTS_MAX_PER_EMAIL)
        : DEFAULT_ALERTS_MAX_PER_EMAIL,
  }
}

export const alertSettingsFields = (): Field[] => [
  {
    name: ALERTS_ALLOW_WITHOUT_ACCOUNT_FIELD,
    type: 'checkbox',
    defaultValue: true,
    admin: {
      description:
        'Let visitors set up job alerts with just an email address. Turn off to require a signed-in account.',
    },
  },
  {
    name: ALERTS_DOUBLE_OPT_IN_FIELD,
    type: 'checkbox',
    defaultValue: true,
    admin: {
      description:
        'New alerts wait until the subscriber follows the link in a confirmation email. Turn off to start them at once.',
    },
  },
  {
    name: ALERTS_MAX_PER_EMAIL_FIELD,
    type: 'number',
    defaultValue: DEFAULT_ALERTS_MAX_PER_EMAIL,
    min: 1,
    max: MAX_ALERTS_MAX_PER_EMAIL,
    admin: { description: 'How many job alerts one email address can have on this site.', step: 1 },
    validate: (value: null | number | undefined) => {
      if (value === null || value === undefined) return true
      return Number.isInteger(value) && value >= 1 && value <= MAX_ALERTS_MAX_PER_EMAIL
        ? true
        : `Use a whole number from 1 to ${MAX_ALERTS_MAX_PER_EMAIL}`
    },
  },
]
