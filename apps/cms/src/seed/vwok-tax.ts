import type { TaxSeed } from '@mission-control/payload-jobs'

/**
 * Vanuatu Wok's tax settings. They must do exactly what the old site does (D1): today Xero works
 * the tax out on each invoice, so the values come from the plan and order data in the founder's
 * query (19 Nov) and the Xero settings, not from guesses.
 *
 * `null` = not confirmed yet; `seedTenantTax` refuses to run while any value is `null`.
 * Rates are basis points: 1500 is 15%.
 */
export const vwokTax: TaxSeed = {
  defaultRateKey: 'vat',
  enabled: null,
  exemptXeroTaxType: null,
  pricesIncludeTax: null,
  rates: [{ key: 'vat', name: 'VAT', rate: null, xeroTaxType: null }],
  rounding: null,
}
