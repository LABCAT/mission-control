/**
 * The job page view beacon (PJ-37, decision 20 Nov). One POST per page load; the CMS answers
 * `{ total, today }` and the numbers fill a span the page has already reserved, so the page
 * never shifts. `keepalive` keeps the request alive if the visitor navigates away (the same
 * guarantee `navigator.sendBeacon` gives) while still letting the response be read.
 *
 * Server-side code never imports this: it is the page's only script, and it does nothing until
 * the DOM holds a `[data-job-views]` element.
 */

export type JobViewCounts = { today: number; total: number }

/** The count text for a template such as `{total} views, {today} today`. */
export const formatViewCounts = (template: string, counts: JobViewCounts): string => {
  const total = Number.isFinite(counts.total) ? Math.max(0, Math.trunc(counts.total)) : 0
  const today = Number.isFinite(counts.today) ? Math.max(0, Math.trunc(counts.today)) : 0

  return template
    .replaceAll('{total}', String(total))
    .replaceAll('{today}', String(today))
    .trim()
}

export type SendViewOptions = {
  /** Replaceable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

/** Fire the beacon for one element and show the counts. Never throws. */
export const sendView = async (
  element: HTMLElement,
  options: SendViewOptions = {},
): Promise<JobViewCounts | null> => {
  const endpoint = element.dataset.viewEndpoint?.trim()
  if (!endpoint) return null

  let counts: JobViewCounts | null = null
  try {
    const response = await (options.fetch ?? fetch)(endpoint, {
      body: '{}',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      method: 'POST',
    })
    if (!response.ok) return null
    const body = (await response.json()) as Partial<JobViewCounts>
    if (typeof body?.total !== 'number') return null
    counts = { today: Number(body.today ?? 0), total: body.total }
  } catch {
    // A blocked or offline beacon is not the visitor's problem: leave the count hidden.
    return null
  }

  const target = element.querySelector<HTMLElement>('[data-job-views-count]')
  if (!target) return counts

  target.textContent = formatViewCounts(
    target.dataset.viewsTemplate ?? '{total} views, {today} today',
    counts,
  )
  target.hidden = false

  return counts
}
