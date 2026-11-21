# payload-jobs modules (PJ-115)

payload-jobs is a **core** plugin plus separate **add-on** packages. Add-ons plug into the core
through registries; a tenant switches each add-on on or off.

## Core, add-ons, generic packages

| Kind | Packages | Contains |
| --- | --- | --- |
| Core | `payload-jobs` | organisations (+ membership/roles), jobs, taxonomies/locations, plans/add-ons/pricing (quote, tax), credits + orders, coupons, applications, emails (templates, `sendTemplate`, log), job view counts |
| Add-on | `payload-jobs-alerts` | alert subscriptions (confirm/manage tokens), later the digest and run log (PJ-47/48) |
| Add-on | `payload-jobs-reports` | report types and CSV export (PJ-53). Skeleton today: registers itself, no reports |
| Add-on | `payload-xero` + a thin adapter (follow-up) | generic Xero plugin, never depends on payload-jobs; the adapter implements the invoice-sync plug point |
| Generic | `payload-email-cloudflare`, `payload-email-smtp`, `payload-cloudflare-analytics`, `rocketship-payload`, `payload-backups` | no payload-jobs dependency; cross-links are optional peers plus adapters |

An add-on depends on `payload-jobs`; `payload-jobs` never depends on an add-on.

## Installing

```ts
plugins: [
  payloadJobs({ tenancy: 'multi' }),   // first: it creates the registry
  payloadJobsAlerts(),                 // add-ons come after
  payloadJobsReports(),
  multiTenantPlugin({ collections: { 'alert-subscriptions': {}, /* ... */ } }),
]
```

`getPayloadJobsRegistry(config)` throws a clear error when `payloadJobs()` did not run first. An
add-on's collections stay tenant collections: list them in the multi-tenant plugin
(`alertsTenantCollections(options)` returns the slug).

## Per-tenant switch

The tenant (or, in single-tenant mode, the settings global) has an `addOns` JSON setting.

- unset / `null`: every installed add-on is on (Mission Control's default; a tenant that
  predates the setting keeps everything).
- `["alerts", "reports"]`: exactly those are on. `[]`: all off.
- Saving an unknown key is refused.

```ts
isAddOnEnabled(tenant: { addOns?: unknown } | null | undefined, key: string): boolean
```

A disabled add-on shows nothing for that tenant:

- **collections**: `gateCollectionAccess(gate, access)` narrows read/update/delete to tenants that
  have it on (single-tenant: denies); `addOnWriteGuard(gate)` refuses writes. Both are wired into
  `payload-jobs-alerts`.
- **endpoints**: `gateEndpoint(gate, endpoint, resolveTenantID)` answers 404.
- **tabs, reports, email events, steps, hooks**: `forTenant(registry, registry.X, tenant)` leaves
  out entries whose `addOn` the tenant has off. An entry naming an add-on that was never
  registered is treated as off.

Data cleanup (for example deleting a tenant's subscribers when the tenant is deleted) runs whether
or not the add-on is on.

## Registry

Every plug point is a keyed registry on `PayloadJobsRegistry`. Keys match
`/^[a-z][a-z0-9._-]*$/`; a duplicate key throws `RegistryError` while the config is built.
`order` (default 100) sorts ascending, ties by registration. Any definition may set
`addOn: '<key>'` so it follows that add-on's tenant switch.

```ts
const registry = getPayloadJobsRegistry(config) // inside a Plugin
registry.addOns.register({ key: 'alerts', label: 'Job alerts', collections: ['alert-subscriptions'] })
```

### 1. Collections

Add-ons add collections in their own plugin (`config.collections`), with slugs that are options
(PJ-80). Extend core collections through the config, as `payloadJobs()` does for `tenants`.
`registry.context` has the resolved core slugs, tenancy mode and tenants/settings slugs.

### 2. Email events (PJ-27 / PJ-50)

```ts
type EmailEventDefinition = {
  key: string; label: string; order?: number; addOn?: string
  variables: { key: string; label: string; description?: string }[]
  blocks?: { key: string; label: string }[]       // block chips such as "Job list"
  defaults: { subject: string; body: string }
  recipients: string[]                            // 'employer' | 'admin' | 'applicant' | 'subscriber' | ...
}
registry.emailEvents.register({
  key: 'alerts.digest', addOn: 'alerts', label: 'Alerts digest', recipients: ['subscriber'],
  variables: [{ key: 'unsubscribeUrl', label: 'Unsubscribe link' }],
  blocks: [{ key: 'job-list', label: 'Job list' }],
  defaults: { subject: 'New jobs for you', body: '{{jobList}}' },
})
```

### 3. Report types (PJ-53)

```ts
type ReportDefinition = {
  key: string; label: string; order?: number; addOn?: string
  fields: { key: string; label: string; default?: boolean }[]
  run(args: { payload; req?; tenantID; fields: string[]; from?: string; to?: string }):
    Promise<{ columns: string[]; rows: Record<string, unknown>[] }>
}
registry.reports.register({ key: 'jobs-by-month', addOn: 'reports', label: 'Jobs by month', fields: [...], run })
```

### 4. Account tabs (PJ-82 / PJ-83)

```ts
type AccountTabDefinition = { key: string; label: string; order: number; dataEndpoint: string; addOn?: string }
registry.accountTabs.register({ key: 'my-alerts', addOn: 'alerts', label: 'My alerts', order: 40, dataEndpoint: '/account/alerts' })
```

/account maps each `key` to an Astro component; tabs of a disabled add-on are not offered.

### 5. Checkout steps

```ts
type CheckoutStepDefinition = {
  key: string; order: number; addOn?: string
  applies(ctx: CheckoutContext): boolean | Promise<boolean>
  run(ctx: CheckoutContext): CheckoutContext | Promise<CheckoutContext>
}
const done = await runCheckoutSteps(registry, ctx, tenant) // applicable steps, in order
```

Suggested order: coupon 10, credit 20, add-on placements 30, tax 40, payment 50. Money is integer
minor units plus `ctx.currency`.

### 6. Payment providers and invoice sync

```ts
type PaymentProviderRegistration = {
  key: string; label: string; currencies: '*' | string[]; addOn?: string
  createPayment(req: { amount; currency; orderID; payload; req?; tenantID }):
    { status: 'paid' | 'pending' | 'failed'; reference?: string; redirectURL?: string } | Promise<...>
  onWebhook?(request: Request, payload: Payload): Promise<Response> | Response
}
type InvoiceSyncAdapter = {
  key: string; label: string; addOn?: string
  onOrderCreated?(event: OrderEvent): void | Promise<void>
  onOrderStatusChanged?(event: OrderEvent & { from: string }): void | Promise<void>
}
```

Core ships `invoice` (pending until marked paid), `free` and `credit` (settle at once). The orders collection (PJ-23) still validates an order's provider against `orders.paymentProviders` in the plugin options (key and label only); `PaymentProviderRegistration` is the richer registry entry add-ons use to create payments. Hosts that add a provider to the options should register the same key here. Stripe
is a later add-on (PJ-106). `emitOrderEvent(registry, 'created' | 'statusChanged', event, tenant)`
calls the adapters; one failing adapter does not stop the others and its error is returned.

### 7. Job lifecycle hooks

```ts
type JobLifecycleHook = {
  key: string; events: ('published' | 'expired' | 'cancelled')[]; addOn?: string
  handler(ctx: { event; job; jobsSlug; payload; previousStatus: string | null; req?; tenantID }): void | Promise<void>
}
```

Core's jobs collection runs these in `afterChange` when the status changes (also on create).
A failing hook is logged and never fails the save.

## Not in this change

Building the add-on features (PJ-47/48 alerts digest, PJ-53 reports, PJ-54..58 Xero), the
`payload-xero` invoice-sync adapter, Stripe (PJ-106) and npm publishing/renaming.
