# payload-xero

Xero invoicing for [Payload](https://payloadcms.com). Today it provides:

- a settings collection (Xero organisation ID, account codes, branding theme, due days, reconciliation account, tracking category), global or per tenant;
- AES-256-GCM helpers (Web Crypto, so they run on Cloudflare Workers) for storing OAuth tokens encrypted.

OAuth connect/refresh and invoicing come in later releases. The plugin never knows about your content model (jobs, orders, products...): see [Invoicing adapter](#invoicing-adapter-planned).

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
