/**
 * Payment providers (PJ-23). An order names the provider that collects its money by a stable
 * key. Core registers `invoice` (the tenant invoices the organisation, e.g. through the Xero
 * add-on); add-ons such as Stripe (post-MVP, PJ-106) register their own key through the plugin
 * options. An order can only name a registered provider.
 */

/** How an order is settled. */
export const ORDER_PAYMENT_METHODS = ['invoice', 'free', 'credit'] as const
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number]

export const ORDER_PAYMENT_METHOD_LABELS: Record<OrderPaymentMethod, string> = {
  credit: 'Job credit',
  free: 'Free',
  invoice: 'Invoice',
}

export type PaymentProviderDefinition = {
  /** Stable key stored on orders, e.g. `invoice` or `stripe`. Lowercase words and hyphens. */
  key: string
  /** Shown in the admin. */
  label: string
}

/** The provider core always registers: the tenant sends the organisation an invoice. */
export const INVOICE_PAYMENT_PROVIDER: Readonly<PaymentProviderDefinition> = Object.freeze({
  key: 'invoice',
  label: 'Invoice',
})

export const PAYMENT_PROVIDER_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Core's providers followed by the host's, checked: every key well formed and used once. A host
 * may not redefine `invoice`.
 */
export const resolvePaymentProviders = (
  extra: readonly PaymentProviderDefinition[] = [],
): readonly PaymentProviderDefinition[] => {
  const providers = [INVOICE_PAYMENT_PROVIDER, ...extra]
  const seen = new Set<string>()

  for (const provider of providers) {
    if (typeof provider?.key !== 'string' || !PAYMENT_PROVIDER_KEY_PATTERN.test(provider.key)) {
      throw new Error(
        `payload-jobs: payment provider key "${String(provider?.key)}" must be lowercase words joined by hyphens`,
      )
    }
    if (typeof provider.label !== 'string' || !provider.label.trim()) {
      throw new Error(`payload-jobs: payment provider "${provider.key}" needs a label`)
    }
    if (seen.has(provider.key)) {
      throw new Error(`payload-jobs: payment provider "${provider.key}" is registered twice`)
    }
    seen.add(provider.key)
  }

  return Object.freeze(providers.map((provider) => Object.freeze({ ...provider })))
}

/** True when `key` names one of `providers`. */
export const isRegisteredPaymentProvider = (
  key: unknown,
  providers: readonly PaymentProviderDefinition[],
): key is string => typeof key === 'string' && providers.some((provider) => provider.key === key)
