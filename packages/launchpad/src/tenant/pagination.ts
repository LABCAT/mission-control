export type PaginationItem =
  | { kind: 'page'; page: number; current: boolean; label: string }
  | { kind: 'gap'; key: string }

export type PaginationLink = { href: string; page: number } | null

export type PaginationModel = {
  items: PaginationItem[]
  next: PaginationLink
  previous: PaginationLink
  page: number
  totalPages: number
}

export type PaginationOptions = {
  page: number
  totalPages: number
  /** Builds the href for a page number; page 1 should be the bare listing URL. */
  href: (page: number) => string
  /** Pages shown either side of the current page. */
  siblings?: number
  /** Pages always shown at each end. */
  edges?: number
}

/** A page number from a URL is untrusted: `?page=abc` must list page 1, not NaN. */
const pageNumber = (value: number, total: number): number => {
  const whole = Number.isFinite(value) ? Math.trunc(value) : 1
  return Math.min(Math.max(whole, 1), total)
}

/**
 * Page numbers for a listing: first and last pages always, the current page with a few
 * siblings, and a single gap wherever numbers are skipped. Pagination is a link list, so it
 * is built from a plain model and rendered without JavaScript.
 */
export const paginationModel = ({
  page,
  totalPages,
  href,
  siblings = 1,
  edges = 1,
}: PaginationOptions): PaginationModel => {
  const total = Number.isFinite(totalPages) ? Math.max(1, Math.trunc(totalPages)) : 1
  const current = pageNumber(page, total)

  const numbers = new Set<number>()

  for (let index = 1; index <= Math.min(edges, total); index += 1) numbers.add(index)
  for (let index = Math.max(1, total - edges + 1); index <= total; index += 1) numbers.add(index)
  for (
    let index = Math.max(1, current - siblings);
    index <= Math.min(total, current + siblings);
    index += 1
  ) {
    numbers.add(index)
  }

  const sorted = [...numbers].toSorted((a, b) => a - b)
  const items: PaginationItem[] = []
  let previous = 0

  for (const number of sorted) {
    if (previous !== 0 && number - previous > 1) {
      items.push({ key: `${previous}-${number}`, kind: 'gap' })
    }
    items.push({
      current: number === current,
      kind: 'page',
      label: String(number),
      page: number,
    })
    previous = number
  }

  return {
    items,
    next: current < total ? { href: href(current + 1), page: current + 1 } : null,
    page: current,
    previous: current > 1 ? { href: href(current - 1), page: current - 1 } : null,
    totalPages: total,
  }
}

/** `Showing 1–20 of 137 jobs` — an en dash, and no numbers when the list is empty. */
export const resultsSummary = (input: {
  page: number
  pageSize: number
  total: number
  /** Plural noun, e.g. `jobs`. */
  noun: string
}): string => {
  const { page, pageSize, total, noun } = input

  if (total <= 0) return `No ${noun} found`
  if (total <= pageSize) return `${total} ${noun}`

  const current = pageNumber(page, Math.ceil(total / pageSize))
  const first = (current - 1) * pageSize + 1
  const last = Math.min(current * pageSize, total)
  return `Showing ${first}–${last} of ${total} ${noun}`
}
