import type { AnalyticsRange } from './types'

/** GraphQL query against the Web Analytics (RUM) dataset. */
export const ANALYTICS_QUERY = `query CloudflareWebAnalytics(
  $accountTag: String!
  $siteTag: String!
  $start: Time!
  $end: Time!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      totals: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $start, datetime_leq: $end }
        limit: 1
      ) {
        count
        sum {
          visits
        }
      }
      pages: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $start, datetime_leq: $end }
        limit: 10
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          requestPath
        }
      }
      referrers: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $start, datetime_leq: $end }
        limit: 10
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          refererHost
        }
      }
      daily: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $start, datetime_leq: $end }
        limit: 100
        orderBy: [date_ASC]
      ) {
        count
        sum {
          visits
        }
        dimensions {
          date
        }
      }
    }
  }
}`

export type AnalyticsQueryVariables = {
  accountTag: string
  end: string
  siteTag: string
  start: string
}

/** Build the GraphQL variables for one account/site/range lookup. */
export const buildAnalyticsQuery = ({
  accountId,
  end,
  siteTag,
  start,
}: {
  accountId: string
  end: Date
  siteTag: string
  start: Date
}): AnalyticsQueryVariables => ({
  accountTag: accountId,
  end: end.toISOString(),
  siteTag,
  start: start.toISOString(),
})

/** Only 7 and 30 are supported; anything else falls back to 7. */
export const parseAnalyticsRange = (value: unknown): AnalyticsRange => {
  const raw = Array.isArray(value) ? value[0] : value
  return String(raw) === '30' ? 30 : 7
}

/**
 * Start of the first day in the window (UTC midnight) through `now`. A 7-day window
 * includes today and the six days before it.
 */
export const analyticsWindow = (now: Date, range: AnalyticsRange): { end: Date; start: Date } => {
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() - (range - 1))
  return { end: new Date(now), start }
}
