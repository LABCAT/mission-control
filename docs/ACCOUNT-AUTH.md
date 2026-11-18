# Account auth for the Astro sites (PJ-81)

Seekers, job listers and organisations use dashboards on the Astro sites (`/account/*`), not the Payload admin. These endpoints are what those dashboards call. Only site managers use the admin.

The site calls them **server-side** (an Astro endpoint or middleware), never from the browser, so the site key stays secret and the user's token lives only in an httpOnly cookie on the site's own domain.

Code: `packages/payload-jobs/src/account-auth.ts`. Tests: `account-auth.test.ts` next to it.

## Requests

Every request needs the tenant's site key (PJ-07) and the tenant slug in the path. The key must belong to that tenant: a key from another tenant, or an aggregate (hub) key, gets `403 tenant_mismatch`.

```
POST|GET  {CMS}/api/tenants/{slug}/account/{action}
x-site-key: sk_…
x-end-user-ip: <visitor IP>        (optional, see Rate limits)
authorization: Bearer <token>      (me, logout)
content-type: application/json
```

| Action | Method | Body | Success |
| --- | --- | --- | --- |
| `login` | POST | `email`, `password` | `200 { token, exp, expiresIn, user }` |
| `me` | GET | – | `200 { user }` |
| `logout` | POST | – | `200 { ok: true }` |
| `register` | POST | `email`, `password`, `firstName?`, `lastName?` | `202 { ok: true }` |
| `verify-email` | POST | `token` | `200 { ok: true }` |
| `forgot-password` | POST | `email` | `200 { ok: true }` |
| `reset-password` | POST | `token`, `password` | `200 { ok: true }` |

`user` is `{ id, email, firstName, lastName, role }`, where `role` is the user's role on this tenant (`seeker` or `employer`).

Errors are `{ error: { code, message } }`. Codes: `invalid_site_key` (401), `tenant_mismatch` (403), `tenant_not_found` (404), `invalid_credentials` (401), `email_not_verified` (403), `not_authenticated` (401), `invalid_token` (400), `invalid_password` (400), `invalid_request` (400), `too_many_requests` (429, with `Retry-After`).

Passwords are 8 to 128 characters.

## Cookie contract

The CMS never sets a cookie. The site does, from the `login` response:

| | |
| --- | --- |
| Name | `mc_session` |
| Value | the `token` from `login`, unchanged |
| Flags | `HttpOnly; Secure; SameSite=Lax; Path=/` (drop `Secure` only on `localhost`) |
| Lifetime | `Max-Age` = `expiresIn` (seconds). Payload's default token lifetime is 2 hours. |
| Domain | none, so it is host-only for the site's own domain |

- **`me`**: the site reads the cookie and sends it as `authorization: Bearer <token>`. A `401 not_authenticated` means the token is missing, expired, signed out or belongs to another tenant: clear the cookie and send the visitor to the login page. Call `me` on each dashboard request; it reads the user fresh, so a removed membership takes effect at once.
- **`logout`**: the site sends the same header, then deletes the cookie (`Max-Age=0`). Payload tracks sessions, so the token stops working immediately, not only when it expires. `logout` always answers `200`, even for a missing or expired token, so the site can always clear its cookie.
- **Expiry**: there is no refresh endpoint yet. When the cookie or token expires the visitor logs in again.
- Never put the token in `localStorage`, in a URL, or in HTML sent to the browser.

## Rules

- **Tenant isolation.** A user can sign in only on a tenant they are a member of, in a role that may use the site (`seeker`, `employer`). Someone from tenant A who tries tenant B gets the same `invalid_credentials` as a wrong password, and their password is never checked there. A token from tenant A is rejected by `me` on tenant B. Super-admins, tenant-admins and editors use the admin, not the site. An email address is one account for the whole platform, so a person who has an account on one tenant cannot register on another tenant with it yet.
- **Login is Payload's login.** `login` calls `payload.login`, so `beforeLogin` hooks (the WordPress legacy hash upgrade, PJ-34) and Payload's lockout (5 failed attempts) apply. There is no separate password check.
- **Seekers.** `register` always creates a user with the `seeker` role on this tenant and nothing else, whatever else the body says. Users are created unverified and cannot sign in until `verify-email` succeeds (`403 email_not_verified`). Payload's verification token is single-use. Registering again with an address that is already in use answers `202` and creates nothing, so an address cannot be probed; if that account is an unverified seeker on this tenant, the verification email is sent again. Users created in the admin or by scripts are verified at creation.
- **Seekers have no admin or content access.** A user whose only role is `seeker` cannot open the admin, can read only their own user, and has no access to tenant content (media, folders, tags).
- **Forgot and reset.** `forgot-password` always answers `200` and only sends mail to a member of this tenant. The reset token lasts an hour and works once: using it also signs out every open session. A token from another tenant is `invalid_token`.

## Emails

Verification and reset emails go through the PJ-09 email adapter from the tenant's sender (`emailFromName` / `emailFromAddress`). The link points at the tenant's first domain (`tenants.domains[0]`), never at request input:

- `https://{domain}/account/verify-email?token=…` (the page posts the token to `verify-email`)
- `https://{domain}/account/reset-password?token=…` (the page posts the token and the new password to `reset-password`)

The text is plain inline HTML for now. TODO(PJ-50): switch to the tenant email templates (PJ-27) when the renderer lands.

## Rate limits

`login`, `register` and `forgot-password` (plus `verify-email` and `reset-password`, per visitor only) are limited per tenant, both per visitor IP and per email address, so rotating IPs does not get around the limit. Over the limit gives `429` with `Retry-After`.

The site's server is the caller, so Cloudflare sees the site's IP, not the visitor's. Pass the visitor's IP in `x-end-user-ip` (Astro: `Astro.clientAddress`). Without it the limit is shared by every visitor behind the site's IP. The header is trusted because only a site with a valid key can call these endpoints.

Production uses the Cloudflare Rate Limiting binding `ACCOUNT_RATE_LIMIT` (`apps/cms/wrangler.jsonc`, 10 requests per 60 seconds per key). Without the binding (local dev, tests) an in-memory limiter per isolate is used.

## Reusing this for PJ-29 (employer sign-up)

`packages/payload-jobs/src/account-auth.ts` exports what PJ-29 needs, so it does not copy any of it:

- `registerAccountUser({ payload, tenant, email, password, role: 'employer', … })` creates the unverified user with the tenant membership and sends the verification email. PJ-29 then creates the organisation.
- `resolveAccountTenant(req, options)` checks the site key against the tenant in the path.
- `enforceRateLimit({ action, identifier, req, tenant, options })` applies the same limits.
- `accountResponse` and `AccountAuthError` give the same JSON shape.

PJ-29's `POST /api/tenants/:slug/employer-signup` is a **collection endpoint on `tenants`** with path `/:slug/employer-signup`: Payload sends `/api/tenants/*` to the collection's `endpoints`, not to the config root. Verification, login, `me`, logout and reset then work for employers through the endpoints above (`employer` is already in `accountRoles`).
