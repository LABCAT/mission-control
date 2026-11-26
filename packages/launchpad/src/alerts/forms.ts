import type { AlertFilters, AlertFrequency } from './client'

/**
 * Reading the plain HTML forms of the alert pages (PJ-47). They post without JavaScript, so the
 * values arrive as form fields named like the listing's own filters, and nothing is trusted: the
 * CMS normalises and validates again.
 */

export const ALERT_FORM_FIELDS = {
  email: 'email',
  frequency: 'frequency',
  honeypot: 'alert_website',
  turnstile: 'cf-turnstile-response',
} as const

const text = (data: FormData, name: string): string => {
  const value = data.get(name)

  return typeof value === 'string' ? value.trim() : ''
}

/** The filters on the form, named like the listing's query parameters. Empty ones are dropped. */
export const readAlertFilters = (data: FormData | URLSearchParams): AlertFilters => {
  const get = (name: string): string => {
    const value = data.get(name)

    return typeof value === 'string' ? value.trim() : ''
  }
  const filters: AlertFilters = {}

  for (const name of ['q', 'category', 'type', 'location'] as const) {
    const value = get(name)
    if (value) filters[name] = value
  }

  return filters
}

export const readFrequency = (value: unknown): AlertFrequency | undefined =>
  value === 'weekly' ? 'weekly' : value === 'daily' ? 'daily' : undefined

export const readSubscribeForm = (data: FormData) => ({
  email: text(data, ALERT_FORM_FIELDS.email),
  filters: readAlertFilters(data),
  frequency: readFrequency(text(data, ALERT_FORM_FIELDS.frequency)),
  honeypot: text(data, ALERT_FORM_FIELDS.honeypot),
  turnstileToken: text(data, ALERT_FORM_FIELDS.turnstile),
})

/** An alert's own manage-page form: which alert, and what to do. */
export const readManageForm = (data: FormData) => ({
  action: text(data, 'action'),
  active: data.get('active') !== null,
  frequency: readFrequency(text(data, 'frequency')),
  id: text(data, 'id'),
})

/** The listing page's filters as the alert form's hidden fields. */
export const alertFilterFields = (filters: AlertFilters | Record<string, string>): { name: string; value: string }[] =>
  (['q', 'category', 'type', 'location'] as const)
    .map((name) => ({ name, value: (filters as Record<string, string | undefined>)[name]?.trim() ?? '' }))
    .filter((field) => field.value !== '')
