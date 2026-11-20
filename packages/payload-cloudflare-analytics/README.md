# payload-cloudflare-analytics

A [Payload](https://payloadcms.com) plugin that shows [Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/) traffic in the admin panel. It is generic: one site tag per tenant, no collections, no fields and no migrations.

- Reads the Web Analytics (RUM) dataset `rumPageloadEventsAdaptiveGroups` through Cloudflare's GraphQL Analytics API.
- Returns visits, page views, top 10 pages, top 10 referrer hosts and a daily series for 7 or 30 days.
- Adds a dashboard component above the collection list with a 7/30-day toggle.
- Adds a read-only `GET /api/cloudflare-analytics` endpoint, restricted to signed-in users from the admin user collection (`admin.user`).
- Resolves the site tag per tenant with `resolveSiteTag(req)`, so it works alongside the multi-tenant plugin.
- Caches successful responses for one hour per Worker isolate.
- Shows a "not set up" message instead of an error when the tenant has no site tag or the account/token is missing.

> Currently published inside a monorepo as `@mission-control/payload-cloudflare-analytics`. Payload `4.0.0-beta.7` is the tested version.

## Setup

### 1. Create an API token

In the Cloudflare dashboard: **My Profile → API Tokens → Create Token → Custom token**.

- Permissions: **Account → Account Analytics → Read**.
- Account resources: the account that owns the Web Analytics sites.
- No zone permissions are needed.

Store it as a Worker secret. The default names are:

```bash
wrangler secret put CLOUDFLARE_ANALYTICS_API_TOKEN
```

Set the account id as a normal variable (or secret):

```bash
wrangler secret put CLOUDFLARE_ANALYTICS_ACCOUNT_ID
```

### 2. Find the site tag

Open **Web Analytics → your site** and read the JavaScript snippet:

```html
<script defer src="https://static.cloudflareinsights.com/beacon.min.js"
  data-cf-beacon='{"token":"abc123def456"}'></script>
```

`abc123def456` is the site tag. It is public (it is in the page source); it is not the API token.

### 3. Register the plugin

```ts
import { cloudflareAnalyticsPlugin } from '@mission-control/payload-cloudflare-analytics'

export default buildConfig({
  // ...
  plugins: [
    cloudflareAnalyticsPlugin({
      resolveSiteTag: async (req) => {
        // Return this tenant's site tag, or undefined/null when it has none.
        const tenant = await currentTenantFor(req)
        return tenant?.cloudflareAnalyticsSiteTag
      },
    }),
  ],
})
```

`resolveSiteTag` receives a `PayloadRequest`. The endpoint passes the real request; the dashboard component runs without a request, so it rebuilds one with the signed-in `user`, the request `headers` (including cookies), `payload` and the page `searchParams`. Resolve from the user, a tenant cookie or a tenant lookup, not from the response object.

## Options

| Option | Default | |
|---|---|---|
| `resolveSiteTag` | | `(req) => string \| null \| undefined`. Omit it and every tenant shows "not set up". |
| `accountIdEnv` | `CLOUDFLARE_ANALYTICS_ACCOUNT_ID` | Name of the account id variable/secret. |
| `apiTokenEnv` | `CLOUDFLARE_ANALYTICS_API_TOKEN` | Name of the token variable/secret. |
| `endpointPath` | `/cloudflare-analytics` | Root endpoint path. The full URL is `<routes.api><endpointPath>`. |
| `cacheTtlMs` | `3600000` | Per-isolate cache TTL. `0` disables caching. |
| `environment` | `process.env` | Environment override, mainly for tests. |
| `fetch` | global `fetch` | Request override, mainly for tests. |
| `now` | `new Date()` | Clock override, mainly for tests. |

## Endpoint

`GET /api/cloudflare-analytics?range=7` (or `range=30`). Both the browser toggle and the server component's first render use the same loader and cache. The dashboard also renders numbers only for admin users; other users see the "not set up" state and make no Cloudflare request.

- `401` when there is no signed-in user.
- `403` when the signed-in user is from another auth collection (for example a front-end account user).
- `200 { "configured": false }` when the tenant has no site tag or credentials are missing.
- `200 { "configured": true, "data": { visits, pageViews, topPages, topReferrers, daily, range } }` on success.
- `502 { "error": "Cloudflare analytics is unavailable right now." }` on an upstream failure.

Responses are sent with `Cache-Control: no-store`; caching happens on the server, not in the browser.

## Token handling

The API token is read from the configured environment variable at request time. It travels only in the `Authorization` header of the Cloudflare request. It is never put in the GraphQL body, the Payload config, the cache key, a response, a log line or an error message. Upstream error text is discarded and replaced with a fixed message.

## Tests

```bash
pnpm vitest run packages/payload-cloudflare-analytics
```

The suite mocks `fetch` and covers query building, response mapping, the one-hour cache, endpoint access control and token redaction.
