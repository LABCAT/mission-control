# payload-email-smtp

A [Payload](https://payloadcms.com) email adapter and SMTP transport that runs on Cloudflare Workers. It sends over Workers TCP sockets (`cloudflare:sockets`), so it works without a server process.

- `smtpEmail(options)` is a `PayloadEmailAdapter`: default from-address/name, per-call `from` override, console transport for dev, typed errors.
- `sendViaSmtp(config, message)` sends one message directly and returns the `Message-ID` it set.
- STARTTLS on 587, implicit TLS on 465. The password is read from an env var / Worker secret at send time.
- Defaults target Google Workspace (`smtp.gmail.com`, 587 STARTTLS).

SMTP itself is handled by [`worker-mailer`](https://www.npmjs.com/package/worker-mailer): a small, maintained, zero-dependency SMTP client built on `cloudflare:sockets`, rather than hand-rolled protocol code.

> Published inside this monorepo as `@mission-control/payload-email-smtp`; the name will change if it goes to npm. Payload `4.0.0-beta.7` is the tested version.

## Install

```bash
pnpm add @mission-control/payload-email-smtp
```

## Setup

```ts
import { smtpEmail } from '@mission-control/payload-email-smtp'

export default buildConfig({
  email: smtpEmail({
    username: 'billing@example.com',
    defaultFromAddress: 'billing@example.com',
    defaultFromName: 'Example Billing',
  }),
})
```

Set the password as a Worker secret (not in code or config):

```bash
wrangler secret put SMTP_PASSWORD
```

Per-call `from` always wins over the default:

```ts
await payload.sendEmail({
  from: { name: 'Example Jobs', address: 'jobs@example.com' },
  to: 'applicant@example.com',
  subject: 'Application received',
  html: '<p>Thanks!</p>',
})
```

### Google Workspace

```ts
smtpEmail({
  host: 'smtp.gmail.com',
  port: 587,
  secure: 'starttls',
  username: 'billing@your-domain.com', // the Workspace user
  passwordEnv: 'SMTP_PASSWORD', // app password, not the account password
  defaultFromAddress: 'billing@your-domain.com',
  defaultFromName: 'Your Company',
})
```

- Use [an app password](https://support.google.com/accounts/answer/185833) (it requires 2-Step Verification). The account password will not authenticate over SMTP.
- Port 587 negotiates STARTTLS; port 465 with `secure: 'tls'` also works.
- Workspace limits sending to about **2,000 messages per day per user**. Spread sends across users or request a limit increase from Google if you need more.

## Options

| Option | Default | |
|---|---|---|
| `host` | `'smtp.gmail.com'` | SMTP host. |
| `port` | `587` | SMTP port. Use `465` with `secure: 'tls'`. |
| `secure` | `'starttls'` | `'starttls'` (upgrade on 587) or `'tls'` (implicit TLS on 465). |
| `username` | | SMTP username. Without it SMTP counts as unconfigured. |
| `passwordEnv` | `'SMTP_PASSWORD'` | Env var / Worker secret holding the password. |
| `defaultFromAddress` / `defaultFromName` | `''` | Used when a message has no `from`; also what Payload uses for its auth emails. |
| `transport` | | `'console'` forces the console transport: nothing is delivered. |

### Which transport runs

1. `transport: 'console'` → console.
2. `username` and the password secret present → SMTP.
3. Missing either: outside Workers (Node, vitest) → console; inside Workers → throws.

The console transport logs that an email was not sent, never recipients, subject or body.

## Sending directly

```ts
import { sendViaSmtp } from '@mission-control/payload-email-smtp'

const messageId = await sendViaSmtp(
  {
    host: 'smtp.gmail.com',
    port: 587,
    secure: 'starttls',
    username: 'billing@example.com',
    password: env.SMTP_PASSWORD,
    fromAddress: 'billing@example.com',
    fromName: 'Example Billing',
  },
  {
    to: ['a@example.com', { name: 'B', address: 'b@example.com' }],
    cc: 'c@example.com',
    bcc: 'audit@example.com',
    replyTo: 'support@example.com',
    subject: 'Résumé received',
    text: 'Thanks',
    html: '<p>Thanks</p>',
    attachments: [{ filename: 'receipt.txt', content: 'aGk=', encoding: 'base64', contentType: 'text/plain' }],
  },
)
```

`sendViaSmtp` returns the `Message-ID` header set on the message. SMTP servers report only success at the end of `DATA`; some return a queue id there, but `worker-mailer` does not expose it. This is the same contract as nodemailer's client-generated `info.messageId`.

## Attachments

Supply `content` inline (string, `ArrayBuffer`, or typed array; `encoding: 'base64'` for base64 strings) with `filename` and `contentType`. `path`/`href` attachments are rejected rather than silently dropped. `cid` inline parts are not supported by this transport and are ignored.

## Limits

- Workers cannot open port **25**. Use 587 (STARTTLS) or 465 (TLS).
- Each Worker instance has a limited number of concurrent TCP connections. Send one message per connection and close it (the transport does this).
- Workspace limits a user to about **2,000 messages/day**; other providers have their own quotas.
- **No bounce tracking over SMTP.** SMTP fails inline for rejected recipients, but asynchronous bounces arrive as email to the envelope sender; there is no API to read them. For delivery/bounce events, use the Cloudflare `send_email` binding via [`@mission-control/payload-email-cloudflare`](../payload-email-cloudflare).

## Errors

Failures throw `EmailSendError` with `provider: 'smtp' | 'adapter'`. Messages hold the server's response text only: they never include the password, recipients, subject or body. The library logger is disabled, and the password is redacted in both raw and base64 form in case a server echoes it.

## Tests

```bash
pnpm vitest run packages/payload-email-smtp
```
