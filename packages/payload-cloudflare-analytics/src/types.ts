/** Supported reporting windows, in days. */
export type AnalyticsRange = 7 | 30

export type AnalyticsPage = {
  /** Request path, for example `/jobs/site-manager`. */
  path: string
  /** Page views for the path. */
  views: number
}

export type AnalyticsReferrer = {
  /** Referrer hostname, for example `news.example.com`. */
  host: string
  /** Page views attributed to the host. */
  views: number
}

export type AnalyticsDay = {
  /** UTC date, `YYYY-MM-DD`. */
  date: string
  /** Page views on the day. */
  pageViews: number
  /** Visits on the day. */
  visits: number
}

/** The traffic numbers the admin component renders. */
export type CloudflareAnalyticsData = {
  daily: AnalyticsDay[]
  /** Page views over the range. */
  pageViews: number
  range: AnalyticsRange
  topPages: AnalyticsPage[]
  topReferrers: AnalyticsReferrer[]
  /** Visits over the range. */
  visits: number
}

/** A tenant with no site tag, or a deployment without the account id/token, is not set up. */
export type AnalyticsLoadResult =
  | { configured: false }
  | { configured: true; data: CloudflareAnalyticsData }

/** The read-only endpoint returns one of these shapes. */
export type AnalyticsResponse = AnalyticsLoadResult

/** GraphQL group row from `rumPageloadEventsAdaptiveGroups`. */
export type RumGroup = {
  count?: number | null
  dimensions?: {
    date?: null | string
    refererHost?: null | string
    requestPath?: null | string
  } | null
  sum?: {
    visits?: null | number
  } | null
}

/** The subset of the Cloudflare GraphQL response we read. */
export type RumResponse = {
  data?: {
    viewer?: {
      accounts?: {
        daily?: RumGroup[] | null
        pages?: RumGroup[] | null
        referrers?: RumGroup[] | null
        totals?: RumGroup[] | null
      }[] | null
    } | null
  } | null
  errors?: { message?: string }[] | null
}
