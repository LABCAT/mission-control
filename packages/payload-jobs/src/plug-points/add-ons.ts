import type { Keyed } from './registry'

/**
 * Per-tenant add-on switch (PJ-115). An add-on is a separate package that registers itself under
 * a key; a tenant's `addOns` setting is the list of keys that tenant has switched on.
 *
 * - `null` / unset: every registered add-on is on. Mission Control's default, and what a tenant
 *   that predates the setting gets, so installing an add-on never silently turns it off.
 * - an array: exactly those add-ons are on. `[]` switches them all off.
 */

export type AddOnDefinition = Keyed & {
  label: string
  /** Slugs of the collections the add-on owns. Hidden for tenants that switch it off. */
  collections?: string[]
  description?: string
}

/** What `isAddOnEnabled` reads: a tenant document, or the single-tenant settings global. */
export type AddOnSettings = { addOns?: unknown } | null | undefined

export const ADD_ONS_FIELD = 'addOns'

/** The enabled keys, or `null` when the tenant has not chosen (every add-on is on). */
export const enabledAddOnKeys = (tenant: AddOnSettings): null | string[] => {
  const value = tenant?.addOns

  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null
}

export const isAddOnEnabled = (tenant: AddOnSettings, key: string): boolean => {
  const keys = enabledAddOnKeys(tenant)

  return keys === null || keys.includes(key)
}

/** Field validation: only a list of registered add-on keys (or nothing) may be stored. */
export const validateAddOnKeys =
  (isRegistered: (key: string) => boolean) =>
  (value: unknown): string | true => {
    if (value === null || value === undefined) return true
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      return 'Use a list of add-on keys, for example ["alerts"], or leave empty for all add-ons.'
    }
    const unknown = [...new Set(value as string[])].filter((key) => !isRegistered(key))

    return unknown.length === 0 ? true : `Unknown add-on: ${unknown.join(', ')}`
  }
