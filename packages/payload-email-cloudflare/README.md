# payload-email-cloudflare

A [Payload](https://payloadcms.com) email adapter for the Cloudflare Workers [`send_email` binding](https://developers.cloudflare.com/email-service/). It has no other runtime dependencies and uses only Workers-compatible APIs (`fetch`).

- Sends through the `send_email` binding (to, cc, bcc, reply-to, html, text, headers, attachments).
- Default from-address and name, with a per-call `from` override.
- Console transport for dev: logs that a send happened, never recipients, subject or body.
- Optional [Resend](https://resend.com) fallback over `fetch`, used when the binding is missing or `provider: 'resend'` is set.

> Currently published inside a monorepo as `@mission-control/payload-email-cloudflare`; the name will change if it goes to npm. Payload `4.0.0-beta.7` is the tested version.

## Install

```bash
pnpm add @mission-control/payload-email-cloudflare
```

Add the binding to `wrangler.jsonc`:

```jsonc
{ "send_email": [{ "name": "EMAIL" }] }
```

## Setup

```ts
import { cloudflareEmail } from '@mission-control/payload-email-cloudflare'

export default buildConfig({
  email: cloudflareEmail({
    defaultFromAddress: 'noreply@example.com',
    defaultFromName: 'Example',
  }),
})
```

Per-call `from` always wins over the default:

```ts
await payload.sendEmail({
  from: { name: 'Acme Jobs', address: 'jobs@acme.example' },
  to: 'applicant@example.com',
  subject: 'Application received',
  html: '<p>Thanks!</p>',
})
```

## Options

| Option | Default | |
|---|---|---|
| `defaultFromAddress` / `defaultFromName` | `''` | Used when a message has no `from`; also what Payload uses for its auth emails. |
| `bindingName` | `'EMAIL'` | Name of the `send_email` binding. |
| `binding` | Workers `env[bindingName]` | Inject a binding (or a function returning one), e.g. in tests. |
| `provider` | `'cloudflare'` | `'resend'` skips the binding and sends through Resend. |
| `transport` | | `'console'` forces the console transport: nothing is delivered. |
| `redirect` | | Redirect-all for previews/staging: `{ to, label }` or a function returning it (or `undefined` to deliver normally). Replaces to/cc/bcc with `to` and prefixes the subject `[label → original recipients]`. With no `to`, nothing is delivered. Applies to every transport. |
| `resend.apiKey` | `RESEND_API_KEY` | String or function. Read from the Workers env (or `process.env` outside Workers). |
| `resend.endpoint`, `resend.fetch` | Resend API, global `fetch` | Overrides for proxies and tests. |

### Which transport runs

1. `transport: 'console'` → console.
2. `provider: 'resend'` → Resend (requires `resend`).
3. Binding present → Cloudflare.
4. Binding missing and `resend` configured → Resend.
5. Nothing available: outside Workers (Node, vitest) → console; inside Workers → throws.

Set the Resend key as a secret (`wrangler secret put RESEND_API_KEY`); don't put it in code.

```ts
cloudflareEmail({ defaultFromAddress: 'noreply@example.com', resend: {} }) // fallback, key from env
cloudflareEmail({ provider: 'resend', resend: {} }) // Resend only
```

## Attachments

The binding supports attachments, and so does the Resend path. Supply them inline as `content` (string, `ArrayBuffer`, or typed array; `encoding: 'base64'` for base64 strings), with `filename` and `contentType`. A `cid` makes the attachment inline. `path`/`href` attachments aren't supported and throw rather than being dropped.

## Errors

Failures throw `EmailSendError` with `provider` (`'cloudflare' | 'resend' | 'adapter'`) and, for Resend, `status`. Messages hold the provider's error text only: never the API key, recipients, subject or body.

## Tests

```bash
pnpm vitest run packages/payload-email-cloudflare
```
