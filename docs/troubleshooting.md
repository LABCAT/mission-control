# Troubleshooting

## Admin hangs forever

**Status: fixed in `0.1.3`** by `patches/@vitejs__plugin-rsc@0.5.38.patch`. Seen on the `feature-user-fields` preview (2026-11-05) and on prod `0.1.1` and `0.1.2` (2026-11-07).

### Symptoms

- Admin pages (`/admin`, `/admin/login`) load forever. The server never sends a byte.
- On the same deployment, the home page and `/api/*` respond normally.
- It's per Worker instance: some requests hang and others load, depending on which instance serves them.
- A redeploy clears it, because it replaces every instance. It comes back once a browser visits `/admin` again.
- `wrangler tail` shows hung requests as `canceled`, with no logs or exceptions.

### Cause

`@vitejs/plugin-rsc` memoizes its server-side module loaders (`setRequireModule` in `dist/core/ssr.js` and `dist/core/rsc.js`). The first request that needs a client component caches the pending `import()` promise, and every later request reuses it.

On Cloudflare Workers, a promise belongs to the request that created it. If that request finishes before the promise settles, the promise never settles.

That's what a logged-out browser visit to `/admin` does:

1. TanStack Start streams the page to browsers (`isbot` says not a bot), and the layout loader (`loadLayoutData`) starts decoding `PayloadRootProviders`, which loads client components through that cache.
2. In parallel, the admin page redirects to `/admin/login`.
3. The 307 ends the request while the module load is still pending.
4. Every later layout decode in that instance awaits the dead promise forever.

`curl` never triggered it, because TanStack waits for the full render for bots. Local `vite preview` doesn't either, because local workerd doesn't cancel a finished request's work.

### Fix

The patch swaps `memoize` for `memoizeLoaded`, which caches a module only once it has loaded. Concurrent first requests each start their own `import()`, which is harmless because the runtime still evaluates each module once. This needs reporting upstream to `vitejs/vite-plugin-react` (`packages/plugin-rsc`). When upgrading plugin-rsc, re-apply the patch or confirm upstream has fixed it, then run the check below.

Related fix in `0.1.2`: `pool.max: 10_000` in `apps/cms/src/payload.config.ts`. That fixed a separate real bug where pg-pool handed a waiting query a connection from another request. Keep it.

### Check it

This needs a fresh deploy, because a warm instance has already cached its modules. Use a preview, or re-run its Preview workflow, then:

```bash
B=https://<preview>-orbit-cms.labcat.workers.dev
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
curl -s -A "$UA" -o /dev/null -w '%{http_code}\n' $B/admin   # 307
for i in 1 2 3 4 5; do curl -s -A "$UA" -o /dev/null -w '%{http_code} %{time_total}s\n' --max-time 30 $B/admin/login; done
```

| Build | Result |
|---|---|
| Without the patch | 2–3 of 5 hang |
| With the patch | 14 of 14 returned 200 across two fresh deploys |

Request tracing and a watchdog were used to find this; see the `admin-hang-diagnostics` tag (commit dca2922) if it ever recurs.

To recover, re-run the latest Release workflow, which gives fresh instances:

```bash
gh run rerun $(gh run list --repo LABCAT/orbit --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId') --repo LABCAT/orbit
```
