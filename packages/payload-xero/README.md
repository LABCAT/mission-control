# payload-xero

Xero invoicing for [Payload](https://payloadcms.com). Today it provides:

- a settings collection (Xero organisation ID, account codes, branding theme, due days, reconciliation account, tracking category), global or per tenant;
- OAuth2 connect and refresh per tenant, with tokens encrypted at rest;
- find-or-create for the Xero contacts invoices are addressed to;
- AES-256-GCM helpers (Web Crypto, so they run on Cloudflare Workers) for storing OAuth tokens encrypted.

Invoicing comes in a later release. The plugin never knows about your content model (jobs, orders, products...): see [Invoicing adapter](#invoicing-adapter-planned).

> Currently published inside a monorepo as `@mission-control/payload-xero`; the name will change if it goes to npm. Payload `4.0.0-beta.7` is the tested version.

## Setup

```ts
import { payloadXero } from '@mission-control/payload-xero'

export default buildConfig({
  plugins: [payloadXero()], // one global settings row, authenticated admin users only
})
```

The collection changes your schema, so create a migration (`payload migrate:create`).

### Options

| Option | Default | |
|---|---|---|
| `scope` | `'global'` | `'global'`: one settings row, no tenant field. `'tenant'`: one row per tenant. |
| `settingsSlug` | `'xero-settings'` | Collection slug. |
| `tenantField` | `'tenant'` | `tenant` scope: the field your tenancy layer adds. |
| `access` | see below | `{ create, read, update, delete }`, any left out use the default. |
| `group` | none | Admin panel group. |
| `enabled` | `true` | Turn the plugin off without removing it. |
| `oauth` | `{}` | Xero app credentials for the OAuth endpoints. `false` leaves the endpoints out. |
| `oauthPaths` | none | `{ connectPath, callbackPath, refreshPath }`. |

One row per scope is enforced by a unique index (a hidden `singleton` column in global scope, the tenant field in tenant scope), plus a hook that gives a clear error for ordinary duplicates.

### Access

Default: the request has a user **and** that user's auth collection allows admin access (its `access.admin`, if it defines one). Pass your own rules to change that. For example, a multi-tenant app with super-admins and tenant-admins:

```ts
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import type { Access } from 'payload'
import { payloadXero } from '@mission-control/payload-xero'

const isSuperAdmin = (user: any) => user?.role === 'super-admin'

const superOrTenantAdmin: Access = ({ req }) =>
  isSuperAdmin(req.user) ||
  Boolean((req.user as any)?.tenants?.some((m: any) => m.role === 'tenant-admin'))

export default buildConfig({
  plugins: [
    payloadXero({
      scope: 'tenant',
      access: {
        create: superOrTenantAdmin,
        read: superOrTenantAdmin,
        update: superOrTenantAdmin,
        delete: superOrTenantAdmin,
      },
    }),
    // Registers the tenant field and scopes every query to the user's tenants.
    multiTenantPlugin({
      collections: { 'xero-settings': {} },
      tenantsSlug: 'tenants',
      userHasAccessToAllTenants: isSuperAdmin,
    }),
  ],
})
```

Tenant scope needs a tenancy layer that adds the `tenantField` to the collection; the plugin does not add it itself.

**Read and update are checked separately.** Finding the row is a read; saving tokens over an existing connection is an update. The endpoints check `read` to find the row and then ask Payload for that document's permissions, so your `update` rule — and the tenancy layer's constraints — decide whether the connection may be replaced. A caller with `read` but no `update` gets a `403` and never spends the authorisation code or the refresh token. This matters because the token write itself uses `overrideAccess`, since the hidden `tokens` group refuses API writes by design.

## OAuth2 connect and refresh

The plugin adds three endpoints under the API root:

| Endpoint | |
|---|---|
| `GET /api/xero/connect?tenant=<id or slug>` | Signed-in tenant admin. Creates the tenant's settings row if needed, then redirects to Xero. |
| `GET /api/xero/callback` | Xero's redirect back. Exchanges the code, records the organisation ID, stores the tokens, then redirects to the settings row in the admin. |
| `POST /api/xero/refresh?tenant=<id or slug>` | Refreshes a stale access token on demand and answers `{ refreshed, expiresAt }`. Never returns a token. |

Scopes are fixed: `offline_access accounting.transactions accounting.settings accounting.contacts`. `XeroOAuthOptions` has no `scopes` option, so no caller can widen what a tenant consents to.

In tenant scope the `tenant` parameter is required; a tenant admin can only connect their own tenants, and a super-admin can connect any. Both are decided by your access rules and tenancy layer, not by this plugin.

### Credentials

The Xero app is a confidential client, so it needs a client ID, a client secret, and the redirect URI registered on the Xero app:

| Env var | |
|---|---|
| `XERO_CLIENT_ID` | Xero app client ID. |
| `XERO_CLIENT_SECRET` | Xero app client secret. |
| `XERO_REDIRECT_URI` | Must match the Xero app exactly, e.g. `https://cms.example.com/api/xero/callback`. |
| `XERO_TOKEN_ENCRYPTION_KEY` | base64, 32 bytes. `generateEncryptionKey()` makes one. |
| `XERO_STATE_SECRET` | Optional. HMAC key for the signed `state`; defaults to the Payload secret. |

Anything you pass in `oauth` wins over the env var, and a getter is read per request, which is what Workers needs:

```ts
payloadXero({
  scope: 'tenant',
  oauth: {
    clientId: () => env.XERO_CLIENT_ID,
    clientSecret: () => env.XERO_CLIENT_SECRET,
    encryptionKey: () => env.XERO_TOKEN_ENCRYPTION_KEY,
    redirectUri: () => `${env.CMS_URL}/api/xero/callback`,
    stateSecret: () => env.PAYLOAD_SECRET,
  },
})
```

`stateSecret` defaults to `XERO_STATE_SECRET`, then to the Payload secret. See `.env.example`.

### The signed state

The callback is a cross-site browser navigation from `login.xero.com`, so the admin's cookie is not sent and cannot be relied on. Instead `/connect` signs a short-lived `state` (HMAC-SHA256, 10 minutes) carrying the settings row, the tenant and the user. The callback:

1. verifies the signature and expiry;
2. loads the user named in the state, and reads that exact settings row **as that user**, so your access rules and the tenancy layer run again;
3. refuses if the row or its tenant is not the one the state names.

So a replayed, edited or old link gets a `400`, and a state signed for tenant A can never write tenant B.

The state alone would still leave an account-linking hole: anyone who can start a connection could hand a victim the Xero URL and have the victim's Xero organisation linked to the attacker's settings row. `/connect` therefore also sets a short-lived `HttpOnly; SameSite=Lax` nonce cookie, repeats the nonce inside the signed state, and the callback refuses the flow unless the returning browser presents the same value. The cookie is cleared on the way back, and a callback with no cookie, or with a different browser's, is an `invalid_state` `400`.

### Tokens at rest

Tokens are stored in a hidden `tokens` group on the settings row, encrypted with AES-256-GCM and bound to the row's ID as authenticated data: a token copied to another tenant's row will not decrypt. The group refuses `create`, `read` and `update` through the API, so even a super-admin reading the REST API sees the row without `tokens`.

Refresh happens automatically: `getXeroAccessToken` returns the stored access token while it has more than a minute left, and otherwise refreshes it. Xero rotates the refresh token on every refresh, and the old one dies as soon as Xero answers, so the new pair is written back before the call returns.

Because that rotation is destructive, refresh is single-flight per settings row. A request takes the row's short lease with one conditional update that also compares the refresh token it is about to spend, so of any number of concurrent requests exactly one calls Xero. The others wait for the winner to save and then use its tokens. A lease that is never released — a request that died mid-refresh — expires on its own after `XERO_REFRESH_LEASE_MS` (15 seconds), so it cannot block the tenant forever.

A lapsed lease is not enough on its own, because the request that held it may still be waiting on Xero. Two guards close that:

- the token request is aborted after `XERO_TOKEN_REQUEST_TIMEOUT_MS` (10 seconds), deliberately shorter than the lease, so a hung Xero releases the request before a peer may claim the row;
- the save is a conditional update matched on the lease token. A request whose lease lapsed while Xero was answering gets no row back, writes nothing, and reports `refresh_failed` instead of overwriting the pair a peer has already stored.

Both are configurable: `oauth.tokenRequestTimeoutMs` overrides the request deadline, and `XERO_REFRESH_LEASE_MS` is exported.

```ts
import { findSettingsWithTokens, getXeroAccessToken } from '@mission-control/payload-xero'

const settings = await findSettingsWithTokens({ collection: 'xero-settings', id, payload })
const { accessToken } = await getXeroAccessToken({
  collection: 'xero-settings',
  oauth: { encryptionKey: () => env.XERO_TOKEN_ENCRYPTION_KEY },
  payload,
  settings: settings!,
})
// use accessToken against api.xero.com
```

`getXeroAccessToken` throws `not_connected` (HTTP 409 from the refresh endpoint) when the tenant has never connected, and `refresh_failed` when Xero rejects the refresh token — at that point an admin has to connect again.

## Token encryption

```ts
import { decryptToken, encryptToken, generateEncryptionKey } from '@mission-control/payload-xero'

const key = process.env.XERO_TOKEN_ENCRYPTION_KEY // base64, 32 bytes
const stored = await encryptToken(refreshToken, key, `tenant:${tenantId}`)
const token = await decryptToken(stored, key, `tenant:${tenantId}`)
```

- `generateEncryptionKey()` makes a key. Run it once per environment and keep it in a secret store, never in code.
- Each call uses a fresh IV. Output is `v1.<iv>.<ciphertext+tag>`.
- The optional context string (for example the tenant ID) is bound in as authenticated data, so a token copied to another row fails to decrypt.
- Wrong key, tampering and wrong context all fail with the same generic `XeroCryptoError`. Messages never contain tokens or keys.

The OAuth endpoints use these helpers for you; you only need them directly if you store tokens somewhere other than the settings collection (for example a per-job connection).

## Contacts

Before an invoice is raised, the payer has to be a Xero contact. `findOrCreateXeroContact` looks one up in a fixed order, so re-running an invoicing job reuses the contact it found the first time instead of creating a duplicate:

1. the payer's stored Xero contact code (`xeroContactCode`), as `ContactNumber`;
2. the legacy WordPress user id as `AXI-{legacyUserId}`, which is what the old plugin wrote, so migrated employers invoice against the contacts that already exist;
3. the email address.

A lookup whose only match is archived does not count, because Xero will not put a new invoice on an archived contact. When all three miss, one contact is created from the name, the code and the email; a create needs a name, so callers must supply one.

```ts
import { findOrCreateXeroContact } from '@mission-control/payload-xero'

const { contact, matchedBy } = await findOrCreateXeroContact({
  accessToken, // from getXeroAccessToken
  contact: {
    code: organisation.xeroContactCode,
    email: organisation.billingEmail,
    legacyUserId: organisation.legacyId,
    name: organisation.name,
  },
  tenantId: settings.xeroTenantId,
})
```

`matchedBy` is `'code'`, `'legacyId'`, `'email'` or `'created'`, which is what an order log wants to record. Everything goes through `fetch` with the `xero-tenant-id` header, so it runs on Workers. Failures are `XeroContactError`s with a stable `code`: `not_connected` (no access token or organisation yet), `invalid_contact` (nothing to look up, or no name to create with), `contact_lookup_failed` and `contact_create_failed`.

Xero's filter grammar has no documented escape for a double quote or backslash. A code or email that carries one is refused as `invalid_contact` rather than sent as a filter that may match another contact.

## Invoicing adapter (planned)

Invoicing (a later release) will be driven by an adapter you supply, so the plugin needs no knowledge of your collections. Planned shape, not implemented yet:

```ts
payloadXero({
  invoicing: {
    // Any collection: orders, bookings, subscriptions...
    sourceCollection: 'orders',
    // Map one of your documents to a neutral invoice. Return null to skip it.
    toInvoice: (doc, { settings }) => XeroInvoiceInput | null,
  },
})

type XeroInvoiceInput = {
  contact: { name: string; email?: string; code?: string }
  currency: string
  reference?: string
  lines: { description: string; quantity: number; unitAmount: number; accountCode?: string }[]
  discount?: { description: string; amount: number }
}
```

The plugin would watch `sourceCollection`, call `toInvoice`, create the draft invoice with the stored settings, and expose the result (invoice ID, online URL) for you to save. Mission Control's order-to-invoice work (PJ-57) is the first consumer.

## Payment sync (PJ-118)

`xeroPaymentSyncTask({ oauth, orders })` returns a Payload task that runs hourly (`0 0 * * * *`, six fields, seconds first). For every connected organisation it reads the status of the Xero invoices behind your open orders and calls your `InvoiceOrderStore`:

- `PAID` → `markPaid(order, { amountPaid, paidAt })`. Your app records the history event, sends the "order paid" email and releases any job waiting on payment.
- `VOIDED` / `DELETED` → `markCancelled(order, invoice)`.
- `AUTHORISED` past its due day with money owing → `setOverdue(order, true)` (and `false` once it is no longer overdue).

It is read-only: it never creates a payment in Xero. Calls are batched (40 invoice IDs), spaced one second apart, and a 429 or 5xx is retried up to three times (honouring `Retry-After`). One failing order or organisation does not stop the rest. Register the task in `jobs.tasks` and run the queue from your scheduled handler.
