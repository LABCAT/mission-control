/**
 * The jobs listing filter is a plain GET form: every control has a `name`, submitting
 * produces a query string, and the page is rendered on the server. It works with JavaScript
 * off, and a shared URL is a shared set of results.
 */

export type FilterValues = Record<string, string>

export type FilterDefinition = {
  /** Query-parameter name. */
  name: string
  /** Values to keep; anything else is dropped, so a hand-edited URL can't inject a filter. */
  allowed?: readonly string[]
}

/** Trims values, drops empty ones, and drops unknown parameters and disallowed values. */
export const parseFilters = (
  search: null | string | URLSearchParams,
  definitions: readonly FilterDefinition[],
): FilterValues => {
  const params = typeof search === 'string' ? new URLSearchParams(search) : (search ?? new URLSearchParams())
  const values: FilterValues = {}

  for (const { allowed, name } of definitions) {
    const raw = params.get(name)?.trim()
    if (!raw) continue
    if (allowed && !allowed.includes(raw)) continue
    values[name] = raw
  }

  return values
}

/**
 * Builds the query string for a set of values, in the order the form defines, so the same
 * filters always produce the same URL. Empty values are omitted rather than sent as `x=`.
 */
export const filterQuery = (
  values: FilterValues,
  definitions: readonly FilterDefinition[],
): string => {
  const params = new URLSearchParams()

  for (const { allowed, name } of definitions) {
    const value = values[name]?.trim()
    if (!value) continue
    if (allowed && !allowed.includes(value)) continue
    params.set(name, value)
  }

  return params.toString()
}

/** True when at least one filter is set; the listing then shows a "clear filters" link. */
export const hasActiveFilters = (values: FilterValues): boolean =>
  Object.values(values).some((value) => value.trim() !== '')

/**
 * The hidden inputs a pagination link needs, so moving to page 2 keeps the filters. The page
 * number itself is never hidden: the link carries it.
 */
export const hiddenFilterFields = (
  values: FilterValues,
  definitions: readonly FilterDefinition[],
  exclude: readonly string[] = ['page'],
): { name: string; value: string }[] => {
  const query = new URLSearchParams(filterQuery(values, definitions))
  return [...query.entries()]
    .filter(([name]) => !exclude.includes(name))
    .map(([name, value]) => ({ name, value }))
}

/** A filter value as a readable label: `full-time` becomes `Full time`. */
export const humaniseFilterValue = (value: string): string => {
  const words = value.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
