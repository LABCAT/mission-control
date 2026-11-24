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
| `login` | POST | `email`, `password`, `keepSignedIn?` | `200 { token, exp, expiresIn, keepSignedIn, user }` |
| `sign-in/request` | POST | `email`, `cf-turnstile-response`, `keepSignedIn?`, `returnTo?` | `202 { ok, expiresInMinutes, resendAfterSeconds }` |
| `sign-in/verify` | POST | `email` + `code`, or `token` | `200 { token, exp, expiresIn, keepSignedIn, returnTo, user }` |
| `me` | GET | – | `200 { user, session? }` |
| `logout` | POST | – | `200 { ok: true }` |
| `register` | POST | `email`, `password`, `firstName?`, `lastName?` | `202 { ok: true }` |
| `verify-email` | POST | `token` | `200 { ok: true }` |
| `forgot-password` | POST | `email` | `200 { ok: true }` |
| `reset-password` | POST | `token`, `password` | `200 { ok: true }` |

`user` is `{ id, email, firstName, lastName, role }`, where `role` is the user's role on this tenant (`seeker` or `employer`).

Errors are `{ error: { code, message } }`. Codes: `invalid_site_key` (401), `tenant_mismatch` (403), `tenant_not_found` (404), `invalid_credentials` (401), `invalid_code` (400), `turnstile_failed` (400), `email_not_verified` (403), `not_authenticated` (401), `invalid_token` (400), `invalid_password` (400), `invalid_request` (400), `too_many_requests` (429, with `Retry-After`).

Passwords are 8 to 128 characters.

## Cookie contract

The CMS never sets a cookie. The site does, from the `login` response:

| | |
| --- | --- |
| Name | `mc_session` |
| Value | the `token` from `login`, unchanged |
| Flags | `HttpOnly; Secure; SameSite=Lax; Path=/` (drop `Secure` only on `localhost`) |
| Lifetime | `Max-Age` = `expiresIn` (seconds): the tenant's session length, see "Sessions and Keep me signed in". |
| Domain | none, so it is host-only for the site's own domain |

- **`me`**: the site reads the cookie and sends it as `authorization: Bearer <token>`. A `401 not_authenticated` means the token is missing, expired, signed out or belongs to another tenant: clear the cookie and send the visitor to the login page. Call `me` on each dashboard request; it reads the user fresh, so a removed membership takes effect at once.
- **`logout`**: the site sends the same header, then deletes the cookie (`Max-Age=0`). Payload tracks sessions, so the token stops working immediately, not only when it expires. `logout` always answers `200`, even for a missing or expired token, so the site can always clear its cookie.
- **Expiry**: when the cookie or token expires the visitor signs in again. A "Keep me signed in" session is renewed by `me` (see below).
- Never put the token in `localStorage`, in a URL, or in HTML sent to the browser.

## Rules

- **Tenant isolation.** A user can sign in only on a tenant they are a member of, in a role that may use the site (`seeker`, `employer`). Someone from tenant A who tries tenant B gets the same `invalid_credentials` as a wrong password, and their password is never checked there. A token from tenant A is rejected by `me` on tenant B. Super-admins, tenant-admins and editors use the admin, not the site. An email address is one account for the whole platform, so a person who has an account on one tenant cannot register on another tenant with it yet.
- **Login is Payload's login.** `login` calls `payload.login`, so `beforeLogin` hooks (the WordPress legacy hash upgrade, PJ-34) and Payload's lockout (5 failed attempts) apply. There is no separate password check.
- **Seekers.** `register` always creates a user with the `seeker` role on this tenant and nothing else, whatever else the body says. Users are created unverified and cannot sign in until `verify-email` succeeds (`403 email_not_verified`). Payload's verification token is single-use. Registering again with an address that is already in use answers `202` and creates nothing, so an address cannot be probed; if that account is an unverified seeker on this tenant, the verification email is sent again. Users created in the admin or by scripts are verified at creation.
- **Seekers have no admin or content access.** A user whose only role is `seeker` cannot open the admin, can read only their own user, and has no access to tenant content (media, folders, tags).
- **Forgot and reset.** `forgot-password` always answers `200` and only sends mail to a member of this tenant. The reset token lasts an hour and works once: using it also signs out every open session. A token from another tenant is `invalid_token`.

## Sessions and Keep me signed in (PJ-109)

Both ways in (password `login` and `sign-in/verify`) take the session length from the tenant, not from Payload's collection-wide `tokenExpiration`:

| Tenant field | Default (vwok) | Used when |
| --- | --- | --- |
| `sessionDefaultDays` | 1 | "Keep me signed in" is not ticked |
| `sessionKeepSignedInDays` | 30 | it is ticked; the session rolls |

- `expiresIn` / `exp` in the response are that length. The site sets `mc_session` **and** the `signed_in=1` hint cookie with the same `Max-Age`.
- **Rolling**: a ticked session carries a `ksi` claim. When `me` is called more than a day after the token was issued, the CMS extends the session and returns `session: { token, exp, expiresIn }`. The site replaces both cookies with it. An unticked session never rolls.
- Sessions are Payload sessions, so sign-out, a password reset and a view-as exit still end them at once.

## Email sign-in: link + code (PJ-109)

`sign-in/request` sends **one** email carrying a magic link (same device) and a 6-digit code (another device). Code: `packages/payload-jobs/src/sign-in.ts`; the sites' pages: `apps/vwok/src/pages/account/sign-in/`.

- **Codes** last 15 minutes and work once. Using the code spends the link, and the link spends the code. Five wrong codes spend it too, so it cannot be brute forced. Only hashes are stored (`payload.kv`, no table), per tenant and address.
- **Resend**: asking again within 30 seconds sends nothing new. After that a new code replaces the old one.
- **Same answer always**: an unknown address, a member of another tenant and a real account all get the same `202`, so addresses cannot be probed. Nothing is sent unless the address is a member of this tenant in an account role.
- **Turnstile** is checked on `sign-in/request` (secret `TURNSTILE_SECRET_KEY`, a Worker secret) and fails closed without one. Both endpoints are rate limited per visitor and per address like `login`.
- **The link** opens `/account/sign-in/verify?token=…` on the site, which only shows a button. The sign-in is the POST, so a mail scanner that opens the link cannot spend it.
- A successful code also confirms an unverified account (the person proved the address).
- **Return URL**: `returnTo` must be a path on the site (`/…`, never `//` or a scheme). The CMS keeps it with the code and returns it from `sign-in/verify`; the site checks it again.
- **Passwords stay optional**: `login` is unchanged apart from the session length, so legacy WordPress hashes still upgrade on first use (PJ-34).

### Signed-in state on cached pages

HTML is cached, so it never says who is signed in. The site sets `signed_in=1` (not HttpOnly, no personal data, same expiry as the session). An inline script on every page swaps the "Sign in" link (`a[href^="/account/sign-in"]`, label from `data-signed-in-label` or "My account") for `/account` when it sees the hint, then asks `/api/me` (never cached). A `401` clears the hint and puts "Sign in" back. Sign-out clears both cookies. `/account` pages (PJ-82/83) send an invalid session to `signInUrl(currentPath)` from `@mission-control/launchpad/sign-in`.

## Emails

Verification and reset emails go through the PJ-09 email adapter from the tenant's sender (`emailFromName` / `emailFromAddress`). The link points at the tenant's first domain (`tenants.domains[0]`), never at request input:

- `https://{domain}/account/verify-email?token=…` (the page posts the token to `verify-email`)
- `https://{domain}/account/reset-password?token=…` (the page posts the token and the new password to `reset-password`)

The text is plain inline HTML for now. TODO(PJ-50): switch to the tenant email templates when the email core lands.

The sign-in email is raised as the event `account.sign_in_code` through the `accountAuth.sendEmail(event, doc)` option, the same shape as `sendTemplate(event, doc)` (PJ-50). Without the option it sends a plain inline email. Variables: `code`, `link`, `expiresInMinutes`, `siteUrl`, `to`, `tenant.name`, `tenant.slug`, `tenant.id`.

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

## Checkout (PJ-31)

Code: `packages/payload-jobs/src/checkout.ts` (`checkoutJob`, `previewCheckout`, `approvePurchase`, `declinePurchase`). Same site key + bearer token contract as above; the user must be an employer of this tenant and of the job's organisation (anyone else gets `404 not_found`).

| Action | Body | Success |
| --- | --- | --- |
| `checkout/quote` | `jobId`, `planId`, `addOnIds?`, `couponCode?`, `useCredit?` | `200 { quote, paymentMethod, needsApproval }`, nothing written |
| `checkout` | as above, plus `closeDate?` (`YYYY-MM-DD`, tenant timezone) | `201 { created: true, order, job, credits, waitingForPurchase }`; a repeat of the same checkout answers `200` with `created: false` and the same order |
| `orders/{id}/approve` | – | owner or site manager: `200` with the invoiced order |
| `orders/{id}/decline` | – | owner or site manager: `200 { order }` (cancelled) |

- **Prices are computed by the CMS** from the plan, add-ons, coupon, tax settings and credit balance. Amounts in the body are ignored.
- **One order per listing.** A job whose order is still open is never charged again: a different checkout gets `409 already_checked_out` (with `orderId`). Cancel the order first to change it.
- **Payment method**: `credit` when a credit pays it all, `free` at 0, otherwise `invoice`. A pack plan's credits go into the ledger and one pays for the job.
- **Purchase rights**: owners and site managers buy. Members use credits unless the owner turned that off, and buy only when allowed (PJ-29's `useCredits` / `canBuy`, defaults on / off). A member who may not buy gets an order `waiting_for_purchase` for the owner to approve.
- **Close date**: optional, after today and at most the plan's duration; without one the job runs the full duration. The job stays `pending`: publishing is PJ-32.
- Errors: `invalid_request` (400), `pricing_error` (400, `pricing` = the `quote()` code), `coupon_invalid` (400, `reason`), `close_date_invalid` (400), `forbidden` (403), `not_found` (404), `already_checked_out`, `job_not_checkoutable`, `insufficient_credits`, `coupon_unavailable`, `order_not_waiting` (409), `payment_failed` (402).
