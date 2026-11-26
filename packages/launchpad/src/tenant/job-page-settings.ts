/**
 * The job-page rules a tenant chooses (PJ-37): what a closed job shows, and whether the public
 * view count is on. These are the same defaults the CMS stores on the tenant, so a tenant that
 * never opened the setting reads the same as one that saved it.
 */

export const EXPIRED_JOB_MODES = ['notice', 'gone'] as const
export type ExpiredJobMode = (typeof EXPIRED_JOB_MODES)[number]

/** Twelve months: the default before an expired job's URL answers 410 Gone. */
export const DEFAULT_GONE_AFTER_MONTHS = 12

export type TenantJobPageSource = {
  /** Guests must sign in before applying (PJ-45). Off unless the tenant turns it on. */
  accountRequiredToApply?: null | boolean
  expiredJobGoneAfterMonths?: null | number
  expiredJobMode?: null | string
  publicJobViews?: null | boolean
}

export type TenantJobPageSettings = {
  /** Only signed-in accounts can apply. */
  accountRequiredToApply: boolean
  /** `notice`: keep the page with a banner and noindex. `gone`: 410 as soon as it expires. */
  expiredJobMode: ExpiredJobMode
  /** Months after the expiry before the URL is 410 Gone. `null` keeps the notice for ever. */
  goneAfterMonths: null | number
  /** Show “N views” from the beacon. */
  publicJobViews: boolean
}

/**
 * A tenant's job-page settings. An unknown mode falls back to `notice`, the documented default;
 * a negative or non-integer month count becomes 0 ("never gone"), so a bad value cannot make a
 * page disappear from under a shared link.
 */
export const tenantJobPageSettings = (
  source: null | TenantJobPageSource | undefined,
): TenantJobPageSettings => {
  const mode = source?.expiredJobMode
  const months = source?.expiredJobGoneAfterMonths

  return {
    accountRequiredToApply: source?.accountRequiredToApply === true,
    expiredJobMode: (EXPIRED_JOB_MODES as readonly string[]).includes(mode ?? '')
      ? (mode as ExpiredJobMode)
      : 'notice',
    goneAfterMonths:
      typeof months === 'number' && Number.isSafeInteger(months) && months >= 0
        ? months === 0
          ? null
          : months
        : DEFAULT_GONE_AFTER_MONTHS,
    publicJobViews: source?.publicJobViews === true,
  }
}
