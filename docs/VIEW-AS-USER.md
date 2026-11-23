# View as user (PJ-119)

A super admin can see the site exactly as one of its account holders (a seeker or an employer) to help with support. It replaces the legacy User Switching plugin. Stories: S-073, S-156 to S-160.

Code: `packages/payload-jobs/src/view-as.ts` (CMS), `audit-log.ts`, `packages/launchpad/src/view-as/` and `apps/vwok/src/view-as-handlers.ts` (site). Needs `tenancy: 'multi'` and account auth; `payloadJobs({ viewAsUser: false })` turns it off.

## Flow

1. **Start (admin).** On a user's admin screen a super admin clicks **View as this user** (one button per tenant the user has a site account on). The button calls `POST /api/users/:id/view-as` with `{ tenant }`. The CMS creates a 30-minute session on that user and answers with a one-time `code` and the site's `startURL` (from the tenant's first domain, never from the request). The page then submits a form POST with the code to the site in a new tab, so the code is never in a URL.
2. **Redeem (site).** `POST {site}/account/view-as/start` calls `POST /api/tenants/:slug/account/view-as/redeem` server to server with the site key. The code works once, for 60 seconds, on its own tenant. The site sets two cookies: `mc_session` (the token, HttpOnly, 30 minutes) and the hint `impersonating=1` (not HttpOnly, no personal data), then redirects to `/account`.
3. **Banner (every page).** `BaseLayout` renders a hidden banner on every page. A tiny inline script shows it when the hint cookie is set and fills in the name from `/api/me` (name and a `viewAs` flag only). HTML is identical for everyone, so there is no cache impact. A hint with no matching session removes itself.
4. **Exit.** The banner's Exit is a same-origin `POST /account/view-as/exit`. It calls `.../account/view-as/exit` (or the ordinary `logout`, which does the same), which revokes the session, clears both cookies and returns to the CMS admin. The super admin's own admin session is never touched. Expiry (30 minutes, no refresh) ends it the same way.

## The token

`mcva1.<claims>.<HMAC-SHA256>`, signed with a key derived from `PAYLOAD_SECRET` for this purpose. It is **not** a Payload JWT: Payload's own strategy rejects it, and only `viewAsAuthStrategy` accepts it, as a `Bearer` header and never a cookie. Claims: session id, target user, super admin, tenant, expiry. On every request the strategy re-reads the database: the session must exist and be unexpired, the super admin must still be a super admin, and the target must still be an eligible site account on that tenant. Every request then carries `req.user._viewAs`, which the guards and the audit log read.

## Guard rails (server side)

| Rule | Where |
| --- | --- |
| Start needs a real super admin session, read fresh from the database, never a view-as session | start endpoint |
| Same-origin, JSON, `x-mc-view-as: start` header, `Sec-Fetch-Site` same-origin | start endpoint (CSRF) |
| Target must be a seeker/employer on that tenant, every membership a site role; never a super admin, staff, or the admin themselves | `viewAsIneligibleReason` |
| Token bound to one tenant, 30 minutes, no refresh, bearer only | strategy, `currentUser` |
| No change to email, password, role, memberships or any sign-in field (only the profile name), no delete, no `refresh`/`forgot`/`reset`/`unlock`/`verify`/`login`/`create` | users hooks (`beforeOperation`, `beforeDelete`) |
| Payload's own `logout` (REST or GraphQL) refused, so it can never reach `allSessions=true` and sign the target out everywhere; ending a view goes through `view-as/exit` | users `afterLogout` hook |
| No purchases: orders cannot be created, changed or deleted | orders hooks |
| Forgot/reset/register/verify account endpoints refused | account-auth |
| No admin panel access | `access.admin` |
| Everything written during a view is logged in the same transaction | `afterChange`/`afterDelete` on every collection |

**Any new code that must never run while viewing** (checkout, account deletion, changing a sign-in) calls `await assertNotViewingAs(req, 'what')` first. It logs the attempt and throws a 403.

## Audit log

`audit-log` collection (S-122 infrastructure): `action`, `actorID` (the super admin), `targetID`, `tenantID`, `sessionID`, `detail`. Actions: `view-as.start`, `.redeem`, `.refused`, `.exit`, `.blocked`, `.create`, `.update`, `.delete`. Readable by super admins only, append only (updates and deletes are refused even for server code), ids are plain text so deleting a user never changes an entry, and no token, code or password is ever written.

## Site configuration

The vwok Worker needs `CMS_URL` and `SITE_KEY` (see `apps/vwok/.dev.vars.example`).
