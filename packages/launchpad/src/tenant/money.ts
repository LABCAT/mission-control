/**
 * Money is always an integer number of minor units plus a currency code, never a float.
 * `currencyMinorUnits` comes from the tenant (0 for VUV, 2 for NZD).
 */
import { resolveLocale } from './locale'

export type Money = {
  /** 150000 is VUV 1500, or NZD 1500.00. */
  amountMinor: number
  currency: string
}

type FormatMoneyOptions = {
  locale?: string
  /** Defaults to the ISO 4217 exponent of `currency`. */
  minorUnits?: null | number
}

const CURRENCY = /^[A-Z]{3}$/

/** The ISO 4217 exponent for a currency. Defaults to 2, with the usual exceptions. */
export const currencyMinorUnits = (currency: string): number => {
  const code = currency.toUpperCase()

  if (['VUV', 'JPY', 'KRW', 'CLP', 'ISK'].includes(code)) return 0
  if (['BHD', 'JOD', 'KWD', 'OMR', 'TND'].includes(code)) return 3
  return 2
}

const MINOR_UNIT_LIMIT = 3

/** Splits minor units into an exact decimal string, so formatting never divides into a float. */
const decimalString = (amountMinor: number, minorUnits: number): string => {
  const negative = amountMinor < 0
  const digits = String(Math.abs(Math.trunc(amountMinor))).padStart(minorUnits + 1, '0')
  const whole = digits.slice(0, digits.length - minorUnits)
  const fraction = digits.slice(digits.length - minorUnits)
  const decimal = minorUnits === 0 ? whole : `${whole}.${fraction}`
  return negative ? `-${decimal}` : decimal
}

/**
 * Formats money for a tenant. The currency code is always the tenant's; the locale is the
 * tenant's default locale so the same amount reads correctly on every site.
 */
export const formatMoney = (
  money: Money,
  { locale = 'en', minorUnits }: FormatMoneyOptions = {},
): string => {
  const currency = money.currency.toUpperCase()

  if (!CURRENCY.test(currency)) {
    throw new TypeError(`Money needs a 3-letter ISO 4217 currency code, got "${money.currency}"`)
  }

  if (!Number.isInteger(money.amountMinor)) {
    throw new TypeError(`Money needs an integer amount of minor units, got ${money.amountMinor}`)
  }

  const units = minorUnits ?? currencyMinorUnits(currency)

  if (!Number.isInteger(units) || units < 0 || units > MINOR_UNIT_LIMIT) {
    throw new TypeError(
      `Minor units must be a whole number from 0 to ${MINOR_UNIT_LIMIT}, got ${units}`,
    )
  }

  return new Intl.NumberFormat(locale, {
    currency,
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: units,
    minimumFractionDigits: units,
    style: 'currency',
  }).format(Number(decimalString(money.amountMinor, units)))
}

export type TenantMoneySettings = {
  currency?: null | string
  currencyMinorUnits?: null | number
  defaultLocale?: null | string
  locales?: null | string[] | { locale?: null | string }[]
}

/**
 * Formats an amount in the tenant's currency. The aggregate tenant has no currency of its
 * own, so it must pass the currency of the job's tenant instead.
 */
export const formatTenantMoney = (tenant: TenantMoneySettings, amountMinor: number): string => {
  if (!tenant.currency) {
    throw new TypeError('formatTenantMoney needs a tenant currency; the aggregate tenant has none')
  }

  return formatMoney(
    { amountMinor, currency: tenant.currency },
    { locale: resolveLocale(tenant), minorUnits: tenant.currencyMinorUnits ?? undefined },
  )
}
