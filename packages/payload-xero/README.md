# @mission-control/payload-xero

Xero invoicing plugin (PJ-54 skeleton). Adds the tenant-scoped `xero-settings` collection and AES-GCM token helpers.

- Register `payloadXero()` and add `'xero-settings': {}` to the multi-tenant plugin's `collections` when wiring it into `apps/cms` (not done yet).
- `XERO_TOKEN_ENCRYPTION_KEY`: base64, 32 bytes. Generate with `generateEncryptionKey()`. Set as a Worker secret / `.dev.vars`; never commit it.
- `encryptToken` / `decryptToken` bind a token to a context string (use the tenant ID). Errors never contain tokens or keys.
- Adding the collection needs a migration; that comes with the wiring task.
