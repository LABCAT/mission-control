# payload-jobs-xero

The Xero add-on for payload-jobs (PJ-57). It installs the generic `payload-xero` plugin with an
adapter that turns orders into Xero invoices, and registers the `xero` add-on, so each tenant can
switch it on or off (`addOns`).

```ts
plugins: [
  payloadJobs({ tenancy: 'multi' }),
  payloadJobsXero({ xero: { oauth: { encryptionKey: () => env.XERO_TOKEN_ENCRYPTION_KEY /* ... */ } } }),
  multiTenantPlugin({ collections: { /* ... */ ...Object.fromEntries(xeroTenantCollections().map((s) => [s, {}])) } }),
]
```

Rules (defaults follow Vanuatu Wok's old site):

| Order | Invoice |
|---|---|
| paid by invoice, total above 0, `pending` | draft, on the order's creation |
| `invoiced` or `paid` | authorised (unless the tenant's Xero settings keep drafts), due `dueDays` later, online link fetched |
| `waiting_for_purchase`, `cancelled`, `failed`, credit/free, or a legacy import (`legacyId`) | none |

Lines come from the order's frozen quote: the plan (with the job titles) on the plan account
code, each paid add-on on the add-on code, and the credit and coupon discounts as negative lines
on the discount code. Taxed tenants get each line's tax, discount and Xero tax type from the quote.
The Xero invoice is recorded in the order's `externalRefs` (provider `xero`), and the order's
history logs it and, later, its online link.

A Xero failure never fails the order: it is recorded on the `xero-invoices` row and, when a retry
can help, a retry job is queued (see payload-xero's README).

`seedXeroSettings` creates a tenant's settings row once (vwok: `apps/cms/src/seed/vwok-xero.ts`).
