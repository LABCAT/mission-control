import { AnalyticsError } from './errors'
import { ANALYTICS_QUERY, analyticsWindow, buildAnalyticsQuery } from './query'
import type { AnalyticsRange, CloudflareAnalyticsData, RumGroup, RumResponse } from './types'

export const CLOUDFLARE_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'

const toNumber = (value: null | number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const byViewsDesc = <T extends { views: number }>(a: T, b: T): number => b.views - a.views

/** Map the GraphQL groups into the shape the admin dashboard renders. */
export const mapAnalyticsResponse = (
  response: RumResponse,
  range: AnalyticsRange,
): CloudflareAnalyticsData => {
  const account = response.data?.viewer?.accounts?.[0]
  const totals = account?.totals?.[0]

  const topPages = (account?.pages ?? [])
    .map((group: RumGroup) => ({
      path: group.dimensions?.requestPath ?? '',
      views: toNumber(group.count),
    }))
    .filter((page) => page.path !== '')
    .toSorted(byViewsDesc)
    .slice(0, 10)

  const topReferrers = (account?.referrers ?? [])
    .map((group: RumGroup) => ({
      host: group.dimensions?.refererHost ?? '',
      views: toNumber(group.count),
    }))
    .filter((referrer) => referrer.host !== '')
    .toSorted(byViewsDesc)
    .slice(0, 10)

  const daily = (account?.daily ?? [])
    .map((group: RumGroup) => ({
      date: group.dimensions?.date ?? '',
      pageViews: toNumber(group.count),
      visits: toNumber(group.sum?.visits),
    }))
    .filter((day) => day.date !== '')
    .toSorted((a, b) => a.date.localeCompare(b.date))

  return {
    daily,
    pageViews: toNumber(totals?.count),
    range,
    topPages,
    topReferrers,
    visits: toNumber(totals?.sum?.visits),
  }
}

export type FetchAnalyticsArgs = {
  accountId: string
  apiToken: string
  /** GraphQL endpoint override, for tests or a proxy. */
  endpoint?: string
  /** `fetch` override, for tests. */
  fetchImpl?: typeof fetch
  /** Clock override, for tests. */
  now?: Date
  range: AnalyticsRange
  siteTag: string
}

/**
 * Query Cloudflare's GraphQL Analytics API. The token travels only in the Authorization
 * header, and every failure is reported with a fixed message so it cannot leak.
 */
export const fetchCloudflareAnalytics = async ({
  accountId,
  apiToken,
  endpoint = CLOUDFLARE_GRAPHQL_ENDPOINT,
  fetchImpl = fetch,
  now = new Date(),
  range,
  siteTag,
}: FetchAnalyticsArgs): Promise<CloudflareAnalyticsData> => {
  const { end, start } = analyticsWindow(now, range)
  const variables = buildAnalyticsQuery({ accountId, end, siteTag, start })

  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      body: JSON.stringify({ query: ANALYTICS_QUERY, variables }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
  } catch {
    throw new AnalyticsError('request', 'The Cloudflare analytics request failed.')
  }

  if (!response.ok) {
    throw new AnalyticsError('request', `Cloudflare analytics returned HTTP ${response.status}.`)
  }

  let body: RumResponse
  try {
    body = (await response.json()) as RumResponse
  } catch {
    throw new AnalyticsError('request', 'Cloudflare analytics returned an invalid response.')
  }

  if (body.errors?.length) {
    throw new AnalyticsError('request', 'Cloudflare analytics returned an error.')
  }

  return mapAnalyticsResponse(body, range)
}
