# Email deliverability events (PJ-107)

Cloudflare Email Sending delivery events update the email log and the per-tenant suppression
list. The consumer code ships with the CMS, but the Queue binding is **off** in
`apps/cms/wrangler.jsonc` until the queue exists. Without the binding the `queue()` handler is
never called, and if it is called with email disabled it acknowledges and drops the messages.

## Enable it (founder step)

1. Create the queue: `wrangler queues create mc-email-events`.
2. In the Cloudflare dashboard, point the sending domain's event subscription at that queue.
3. Uncomment the `queues` block in `apps/cms/wrangler.jsonc` and deploy.
4. Send a test email; its email-log row should move from `sent` to `delivered`.

The parser accepts `message.<kind>` or a bare kind, the payload at the top level or under
`payload`/`data`, the bounce type at `payload.bounce.type`, and a message id with or without
angle brackets. Check it against a recorded event when the subscription first produces one.

Numbers: `GET /api/email-log/deliverability?days=30` (sent, delivered, bounced, complaints).
Staff can delete a row in the suppression list to email an address again.
