import type { Config } from 'payload'

import type { PayloadJobsCollectionSlugs } from '../slugs'
import { isAddOnEnabled, type AddOnDefinition, type AddOnSettings } from './add-ons'
import type {
  AccountTabDefinition,
  AddOnOwned,
  CheckoutContext,
  CheckoutStepDefinition,
  EmailEventDefinition,
  InvoiceSyncAdapter,
  JobLifecycleContext,
  JobLifecycleHook,
  OrderEvent,
  PaymentProviderDefinition,
  ReportDefinition,
} from './definitions'
import { createRegistry, RegistryError, type Keyed, type Registry } from './registry'

/** What add-on packages need to know about the host installation. */
export type PayloadJobsRegistryContext = {
  settingsSlug: string
  slugs: PayloadJobsCollectionSlugs
  tenancy: 'multi' | 'single'
  tenantsSlug: string
}

export type PayloadJobsRegistry = {
  accountTabs: Registry<AccountTabDefinition>
  addOns: Registry<AddOnDefinition>
  checkoutSteps: Registry<CheckoutStepDefinition>
  context: PayloadJobsRegistryContext
  emailEvents: Registry<EmailEventDefinition>
  invoiceSync: Registry<InvoiceSyncAdapter>
  jobLifecycle: Registry<JobLifecycleHook>
  paymentProviders: Registry<PaymentProviderDefinition>
  reports: Registry<ReportDefinition>
}

/**
 * Core ships `invoice` (the buyer is invoiced, staff mark it paid) plus the internal `free` and
 * `credit` providers, which settle at once. Stripe is a later add-on (PJ-106).
 */
const coreProviders = (): PaymentProviderDefinition[] => [
  {
    createPayment: ({ orderID }) => ({ reference: `INV-${orderID}`, status: 'pending' }),
    currencies: '*',
    key: 'invoice',
    label: 'Invoice',
  },
  { createPayment: () => ({ status: 'paid' }), currencies: '*', key: 'free', label: 'Free' },
  { createPayment: () => ({ status: 'paid' }), currencies: '*', key: 'credit', label: 'Job credit' },
]

export const createPayloadJobsRegistry = (
  context: PayloadJobsRegistryContext,
): PayloadJobsRegistry => {
  const registry: PayloadJobsRegistry = {
    accountTabs: createRegistry('account tab'),
    addOns: createRegistry('add-on'),
    checkoutSteps: createRegistry('checkout step'),
    context,
    emailEvents: createRegistry('email event'),
    invoiceSync: createRegistry('invoice sync adapter'),
    jobLifecycle: createRegistry('job lifecycle hook'),
    paymentProviders: createRegistry('payment provider'),
    reports: createRegistry('report'),
  }

  for (const provider of coreProviders()) registry.paymentProviders.register(provider)

  return registry
}

/** Where the plugin stores its registry, so add-on plugins can find it on the config. */
export const REGISTRY_CONFIG_KEY = 'registry'

type ConfigWithRegistry = { custom?: { payloadJobs?: { registry?: PayloadJobsRegistry } } }

/**
 * The registry of the `payloadJobs()` plugin already applied to `config`. Add-on plugins call
 * this first, so list them after `payloadJobs()` in `plugins`.
 */
export const getPayloadJobsRegistry = (config: Config): PayloadJobsRegistry => {
  const registry = (config as ConfigWithRegistry).custom?.payloadJobs?.registry

  if (!registry) {
    throw new RegistryError(
      'payload-jobs: no registry found. Add payloadJobs() to `plugins` before any add-on plugin.',
    )
  }

  return registry
}

/**
 * Definitions visible to one tenant: core ones, plus those of add-ons the tenant has on. An
 * entry naming an add-on that was never registered is treated as off, so a typo hides it
 * instead of leaking it to every tenant.
 */
export const forTenant = <T extends AddOnOwned & Keyed>(
  registry: PayloadJobsRegistry,
  definitions: Registry<T>,
  tenant: AddOnSettings,
): T[] =>
  definitions
    .list()
    .filter(
      (definition) =>
        definition.addOn === undefined ||
        (registry.addOns.has(definition.addOn) && isAddOnEnabled(tenant, definition.addOn)),
    )

/** Run each applicable step in `order`, threading the context through. */
export const runCheckoutSteps = async (
  registry: PayloadJobsRegistry,
  context: CheckoutContext,
  tenant: AddOnSettings,
): Promise<CheckoutContext> => {
  let current = context

  for (const step of forTenant(registry, registry.checkoutSteps, tenant)) {
    if (await step.applies(current)) current = await step.run(current)
  }

  return current
}

/**
 * Tell the invoice-sync adapters an order was created or changed status. One adapter failing
 * does not stop the others or the order write; its error is collected and returned.
 */
export const emitOrderEvent = async (
  registry: PayloadJobsRegistry,
  kind: 'created' | 'statusChanged',
  event: OrderEvent & { from?: string },
  tenant: AddOnSettings,
): Promise<Error[]> => {
  const errors: Error[] = []

  for (const adapter of forTenant(registry, registry.invoiceSync, tenant)) {
    try {
      if (kind === 'created') await adapter.onOrderCreated?.(event)
      else await adapter.onOrderStatusChanged?.({ ...event, from: event.from ?? '' })
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return errors
}

/** Run the lifecycle hooks listening for `context.event`; failures are collected, not thrown. */
export const emitJobLifecycle = async (
  registry: PayloadJobsRegistry,
  context: JobLifecycleContext,
  tenant: AddOnSettings,
): Promise<Error[]> => {
  const errors: Error[] = []

  for (const hook of forTenant(registry, registry.jobLifecycle, tenant)) {
    if (!hook.events.includes(context.event)) continue
    try {
      await hook.handler(context)
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return errors
}
