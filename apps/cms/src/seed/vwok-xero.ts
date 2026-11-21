import type { XeroSettingsSeed } from '@mission-control/payload-jobs-xero'

/**
 * Vanuatu Wok's Xero settings, from the old site's Xero plugin options (founder query 19, 19 Nov):
 * job plan 225, add-on 226, coupon discount 227, invoices due in 14 days, no payment
 * reconciliation account and no tracking category. Tax is off for vwok (tenant tax settings).
 * Invoices are authorised once checkout completes (invoice-only MVP).
 *
 * The Xero organisation and branding theme come from connecting Xero (PJ-59), not from here.
 */
export const vwokXero: XeroSettingsSeed = {
  accountCodes: { addOn: '226', discount: '227', plan: '225' },
  authorise: true,
  dueDays: 14,
  reconciliationAccountCode: null,
  trackingCategory: null,
}
