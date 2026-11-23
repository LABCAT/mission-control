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

## The invoice link (PJ-58)

An employer needs something to download and pay from, and a Xero invoice only has an online link
once it is submitted or authorised. So the add-on serves both, on the orders collection:

| Request | Answer |
|---|---|
| `GET /api/orders/:id/invoice` | 302 to the Xero online invoice, or the HTML fallback inline |
| `GET /api/orders/:id/invoice?format=json` | the link itself: `{ kind: 'xero', url }` or `{ kind: 'html', filename, total }` |
| `GET /api/orders/:id/invoice?download=1` | the HTML as an attachment |

Who may open it is the orders collection's own rule: the order is loaded with the caller's user
and `overrideAccess: false`, so the order's organisation members and the tenant's site managers
get it, and everyone else (another organisation, another tenant, a seeker) gets `not_found` rather
than a hint that the order exists. A caller with no user gets `not_signed_in` (401), and an order
with no invoice, or a tenant with the `xero` add-on off, gets `no_invoice` (404).

The HTML fallback is rendered by payload-xero from the same money mapping as the Xero invoice
(`orderInvoiceSummary`), so the page and the invoice can never disagree. Prices, tax and
discounts come from the order; the issuer is the tenant's name unless you pass `invoiceIssuer`.

The same link appears on the order's edit view in the admin (`beforeDocumentControls`), as a
server component with no client JS: Xero's page in a new tab, or the fallback endpoint. Pass
`orderInvoiceLink: false` to leave the collection untouched.

```ts
payloadJobsXero({
  // Optional: who the invoice is from. Defaults to the tenant's name.
  invoiceIssuer: (tenant) => ({ name: tenant.name, email: 'accounts@example.com' }),
})
```
