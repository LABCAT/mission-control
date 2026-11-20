import type { CollectionSlug, Payload, PayloadRequest } from 'payload'

import type { Keyed } from './registry'

/**
 * Plug point definitions (PJ-115). Each one is a plain object an add-on registers on the
 * registry (`getPayloadJobsRegistry(config)`). Every definition may name the `addOn` it belongs
 * to; the registry's `forTenant` helper then leaves it out for tenants that switched that
 * add-on off.
 */

/** Shared by every definition: which add-on owns it (if any). Core entries leave it empty. */
export type AddOnOwned = { addOn?: string }

/** (2) Email events: what PJ-27 / PJ-50 list in the template editor. */
export type EmailEventVariable = { description?: string; key: string; label: string }
export type EmailEventDefinition = AddOnOwned &
  Keyed & {
    /** Block chips an editor can drop into the body, such as a list of jobs. */
    blocks?: { key: string; label: string }[]
    /** Built-in subject and body (Liquid-free; variables are `{{key}}` chips). */
    defaults: { body: string; subject: string }
    label: string
    /** Who the event may be sent to, such as `employer`, `admin`, `applicant`, `subscriber`. */
    recipients: string[]
    variables: EmailEventVariable[]
  }

/** (3) Report types. */
export type ReportField = { default?: boolean; key: string; label: string }
export type ReportRunArgs = {
  /** Fields the user ticked; always a subset of the report's `fields`. */
  fields: string[]
  from?: string
  payload: Payload
  req?: PayloadRequest
  tenantID: null | number | string
  to?: string
}
export type ReportResult = { columns: string[]; rows: Record<string, unknown>[] }
export type ReportDefinition = AddOnOwned &
  Keyed & {
    fields: ReportField[]
    label: string
    run: (args: ReportRunArgs) => Promise<ReportResult> | ReportResult
  }

/** (4) Account tabs, rendered by /account through a component map on the Astro side. */
export type AccountTabDefinition = AddOnOwned &
  Keyed & {
    /** Path of the endpoint that feeds the tab, relative to the CMS API root. */
    dataEndpoint: string
    label: string
    order: number
  }

/** (5) Checkout steps. The pipeline threads a context through each applicable step in order. */
export type CheckoutContext = {
  /** Amounts are integer minor units in `currency`. */
  currency: string
  lines: { amount: number; description: string; key: string }[]
  organisationID?: null | number | string
  payload: Payload
  req?: PayloadRequest
  tenantID: null | number | string
  total: number
  [extra: string]: unknown
}
export type CheckoutStepDefinition = AddOnOwned &
  Keyed & {
    applies: (context: CheckoutContext) => boolean | Promise<boolean>
    order: number
    run: (context: CheckoutContext) => CheckoutContext | Promise<CheckoutContext>
  }

/** (6) Payment providers and invoice sync. */
export type PaymentRequest = {
  amount: number
  currency: string
  orderID: number | string
  payload: Payload
  req?: PayloadRequest
  tenantID: null | number | string
}
export type PaymentResult = {
  /** `paid` settles the order now; `pending` waits for a webhook or a staff action. */
  status: 'failed' | 'paid' | 'pending'
  /** Provider reference, such as an invoice number. */
  reference?: string
  /** Where the buyer continues, for hosted payments. */
  redirectURL?: string
}
export type PaymentProviderDefinition = AddOnOwned &
  Keyed & {
    createPayment: (request: PaymentRequest) => PaymentResult | Promise<PaymentResult>
    /** `'*'` accepts every currency. */
    currencies: '*' | string[]
    label: string
    onWebhook?: (request: Request, payload: Payload) => Promise<Response> | Response
  }

export type OrderEvent = {
  orderID: number | string
  payload: Payload
  req?: PayloadRequest
  status: string
  tenantID: null | number | string
}
export type InvoiceSyncAdapter = AddOnOwned &
  Keyed & {
    label: string
    onOrderCreated?: (event: OrderEvent) => Promise<void> | void
    onOrderStatusChanged?: (event: OrderEvent & { from: string }) => Promise<void> | void
  }

/** (7) Job lifecycle hooks. */
export const JOB_LIFECYCLE_EVENTS = ['published', 'expired', 'cancelled'] as const
export type JobLifecycleEvent = (typeof JOB_LIFECYCLE_EVENTS)[number]
export type JobLifecycleContext = {
  event: JobLifecycleEvent
  /** The job after the change. */
  job: Record<string, unknown>
  jobsSlug: CollectionSlug | string
  payload: Payload
  previousStatus: null | string
  req?: PayloadRequest
  tenantID: null | number | string
}
export type JobLifecycleHook = AddOnOwned &
  Keyed & {
    /** Events this hook handles. */
    events: JobLifecycleEvent[]
    handler: (context: JobLifecycleContext) => Promise<void> | void
  }
