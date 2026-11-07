# Troubleshooting

## Admin hangs forever

Seen on the `feature-user-fields` preview (2026-11-05) and on prod `0.1.1` (2026-11-07). Fixed in `apps/cms/src/payload.config.ts` (`pool.max`).

### Symptoms

- `/admin` loads forever. No error, and the server never sends a byte. Logged-in pages are hit first.
- On the same deployment, the home page and `/api/*` respond normally.
- It stays broken until the Worker is redeployed. Redeploying the same commit "fixes" it.
- workerd logs: `A promise was resolved or rejected from a different request context than the one it was created in. However, the creating request has already been completed or canceled.`

### Cause

Payload's Postgres adapter keeps one pg-pool per Worker instance, shared by every request it serves. When the pool is full (pg-pool's default `max` is 10), a waiting query gets a connection that pg-pool opens inside whichever request releases one. workerd ties I/O to the request that started it, so the waiting request resumes on another request's I/O. Once that request has finished, workerd cancels the waiter's continuations, and the waiter never responds. Its pool slot can be stranded too, so the instance gets worse until it's replaced.

Logged-in admin pages run many queries at once (dashboard, preferences, permissions), so they fill the pool first. Light requests still fit in the slots that are left, which is why the API keeps working.

### Fix

`pool.max: 10_000` in `apps/cms/src/payload.config.ts`, so the pool never queues. Every query opens its own connection inside its own request. `maxUses: 1` already stops connections being shared between requests. In production, Hyperdrive does the real pooling to Neon, and Workers caps each request at six open connections.

Trade-off: without Hyperdrive (previews connect straight to Neon, and local dev uses Docker), heavy load can reach Postgres's connection limit. That fails fast with `sorry, too many clients already` instead of hanging.

Don't lower `max` or remove `maxUses: 1` without running the check below.

### Check it locally

Build for production and serve it in workerd against Docker Postgres:

```bash
cd apps/cms && pnpm build && pnpm exec vite preview --port 8903
```

In another terminal, log in as a local admin and send 40 admin requests at once:

```bash
B=http://localhost:8903; CJ=$(mktemp)
curl -s -c "$CJ" -o /dev/null -H 'Content-Type: application/json' \
  -d '{"email":"<local admin email>","password":"<local admin password>"}' $B/api/users/login
for i in $(seq 1 40); do curl -s -b "$CJ" -o /dev/null -w '%{http_code}\n' --max-time 30 $B/admin & done | sort | uniq -c
```

Then search the `vite preview` output for `different request context`.

- Before the fix: 34 of 40 returned 500, with 94 warnings.
- After the fix: no warnings. At 100 parallel requests, the only failures are local Postgres's 100-connection limit.

### If it happens again

1. **Recover** by redeploying the live tag, which gives fresh Worker instances:

   ```bash
   gh run rerun $(gh run list --repo LABCAT/orbit --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId') --repo LABCAT/orbit
   ```

   For a preview, re-run that branch's Preview workflow instead.
2. **Confirm** by running `cd apps/cms && pnpm exec wrangler tail orbit-cms --format pretty`, loading the admin, and looking for the warning above. `wrangler tail` doesn't stream previews.
3. **Look for** anything shared across requests that does I/O, such as a module-level pool, client or cached promise. The fix is the same: make each request open its own I/O.
