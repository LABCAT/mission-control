import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'

import { Users } from './collections/Users'
import { Media } from './collections/Media'
import { Folders } from './collections/Folders'
import { Tags } from './collections/Tags'

// mission-control: job board plugins. Keep this block small so orbit merges stay clean.
import { payloadJobs, type RateLimiter } from '@mission-control/payload-jobs'
import { ALERT_SUBSCRIPTIONS_SLUG, payloadJobsAlerts } from '@mission-control/payload-jobs-alerts'
import { payloadJobsReports } from '@mission-control/payload-jobs-reports'
import { payloadJobsXero } from '@mission-control/payload-jobs-xero'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
// mission-control: the Payload form builder backs the generic Form block (PJ-102).
import { formBuilderPlugin } from '@payloadcms/plugin-form-builder'
import { Tenants } from './collections/Tenants'
import { SiteKeys } from './collections/SiteKeys'
import { SystemStatus } from './globals/SystemStatus'
// mission-control: email adapter lives in a generic package (PJ-92)
import { cloudflareEmail } from '@mission-control/payload-email-cloudflare'
import { emailRedirect } from './email-redirect'
import { heartbeatTask } from './jobs/heartbeat'
// mission-control: forms collections and the Turnstile check for public submissions (PJ-102).
import { FORMS_SUBMISSIONS_SLUG, FORMS_SLUG, formBuilderOptions } from './forms'
import { Documents } from './collections/Documents'
import { createMediaTransformers } from './media'
import { r2Storage } from '@payloadcms/storage-r2'
// mission-control: the resolved job-board slugs, shared with the plugin and the site-key allowlist
import { payloadJobsCollectionOptions, payloadJobsCollectionSlugs } from './job-board-slugs'
import { multiTenantOptionsFor } from './tenancy'
// mission-control: generic page blocks (PJ-84). Registering them here lets page and
// site-settings fields reference them by slug; the pages collection (PJ-103) offers them.
import {
  bannerBlock,
  cardGridBlock,
  ctaBlock,
  faqBlock,
  featureBoxesBlock,
  formBlock,
  heroBlock,
  mapBlock,
  richTextBlock,
} from '@mission-control/rocketship-payload/blocks'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// In workerd the database comes from the Hyperdrive binding. The Node CLI (migrations,
// type generation) has no bindings and uses DATABASE_URL.
// mission-control: also gates the sharp import and the R2 adapter below.
const isWorkers = globalThis.navigator?.userAgent === 'Cloudflare-Workers'
const workerEnv =
  isWorkers
    ? ((await import('cloudflare:workers')).env as {
        ACCOUNT_RATE_LIMIT?: RateLimiter // mission-control: account auth rate limit (PJ-81)
        HYPERDRIVE?: { connectionString: string }
        JOB_VIEW_RATE_LIMIT?: RateLimiter // mission-control: job page view beacon (PJ-37)
        // mission-control: email safety (PJ-94). Redirect is ON unless ENVIRONMENT is 'production'.
        ENVIRONMENT?: string
        EMAIL_REDIRECT_TO?: string
        MEDIA?: R2Bucket // mission-control: R2 bucket `mission-control-media`
        // mission-control: Xero app and token key (PJ-55/57), Worker secrets. See .dev.vars.example.
        XERO_CLIENT_ID?: string
        XERO_CLIENT_SECRET?: string
        XERO_REDIRECT_URI?: string
        XERO_STATE_SECRET?: string
        XERO_TOKEN_ENCRYPTION_KEY?: string
        // mission-control: Turnstile secret for public form submissions (PJ-102).
        TURNSTILE_SECRET_KEY?: string
      })
    : undefined

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  // Cloudflare Workers rejects PBKDF2 above 100,000 iterations (Payload's default is 600,000).
  auth: { passwordHashIterations: 100000 },
  // mission-control: reusable page blocks (PJ-84). Page and site-settings fields can name
  // these slugs; registering a block here adds no collection or table.
  blocks: [
    heroBlock({ mediaSlug: 'media' }),
    featureBoxesBlock,
    richTextBlock,
    cardGridBlock({ mediaSlug: 'media' }),
    ctaBlock,
    faqBlock,
    bannerBlock({ mediaSlug: 'media' }),
    // mission-control: the contact page's two blocks (PJ-102).
    formBlock({ formsSlug: FORMS_SLUG }),
    mapBlock,
  ],
  collections: [Users, Media, Folders, Tags, Tenants, SiteKeys, Documents], // mission-control: tenants, site keys, documents
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    // workerd can't reuse a socket opened during another request, so every pool checkout
    // gets a fresh connection (Hyperdrive does the real pooling in production).
    pool: {
      // A getter, because workerd forbids reading the Hyperdrive binding at global scope.
      // pg reads it when Payload creates the pool, inside the first request.
      get connectionString() {
        return workerEnv?.HYPERDRIVE?.connectionString ?? process.env.DATABASE_URL ?? ''
      },
      maxUses: 1,
      // Never let the pool queue. When it's full (default max 10), pg-pool opens a waiting
      // query's connection inside whichever request releases one, so the waiter ends up on
      // another request's I/O. workerd cancels it and the request hangs forever.
      // See docs/troubleshooting.md, "Admin hangs forever".
      max: 10_000,
    },
    // Dev schema push needs drizzle-kit, which doesn't run in workerd. Schema changes go
    // through migrations, run with the Node CLI (`pnpm payload migrate`).
    push: false,
  }),
  // mission-control: Cloudflare Email Sending adapter (PJ-09). Sends via the `EMAIL` binding in
  // Workers and logs to the console in dev; tenant emails go through sendTenantEmail.
  // mission-control: redirect-all (PJ-94): everything goes to EMAIL_REDIRECT_TO unless
  // ENVIRONMENT=production; with no inbox set nothing is delivered. Read per send, never at module scope.
  email: cloudflareEmail({ redirect: () => emailRedirect(workerEnv) }),
  globals: [SystemStatus],
  jobs: { tasks: [heartbeatTask] },
  // mission-control: resized media variants (PJ-10)
  upload: { transformers: await createMediaTransformers(isWorkers) },
  // mission-control: media and documents live in R2 (binding `MEDIA`). The Node CLI has no
  // bindings, so there the adapter is off and the schema stays identical.
  storage: [
    r2Storage({
      bucket: workerEnv?.MEDIA as R2Bucket,
      collections: { 'application-files': true, documents: true, media: true },
      enabled: Boolean(workerEnv?.MEDIA),
    }),
  ],
  plugins: [
    // mission-control: account auth endpoints (PJ-81) rate limit with the ACCOUNT_RATE_LIMIT
    // binding in Workers, and fall back to an in-memory limiter in dev.
    payloadJobs({
      accountAuth: { rateLimiter: () => workerEnv?.ACCOUNT_RATE_LIMIT },
      // mission-control: job page views (PJ-37) limit per visitor in Workers, per isolate in dev.
      jobViews: { rateLimiter: () => workerEnv?.JOB_VIEW_RATE_LIMIT },
      // mission-control: the apply endpoint (PJ-45) verifies Turnstile with the same Worker secret
      // and limits per IP and per email with the account limiter. Its three emails go through
      // PJ-50's sendTemplate (the application-* events), so the per-tenant switches, the
      // non-production redirect and the email log apply.
      apply: {
        rateLimiter: () => workerEnv?.ACCOUNT_RATE_LIMIT,
        turnstile: { secret: () => workerEnv?.TURNSTILE_SECRET_KEY ?? process.env.TURNSTILE_SECRET_KEY },
      },
      // mission-control: public form submissions (PJ-102). Turnstile is verified server-side;
      // the secret is a Worker secret, never a tenant field.
      forms: {
        formsSlug: FORMS_SLUG,
        submissionsSlug: FORMS_SUBMISSIONS_SLUG,
        turnstile: { secret: () => workerEnv?.TURNSTILE_SECRET_KEY ?? process.env.TURNSTILE_SECRET_KEY },
      },
      // mission-control: personal data removal deletes the person's alert subscriptions, so it
      // needs the add-on's resolved slug (PJ-89).
      alertSubscriptionsSlug: ALERT_SUBSCRIPTIONS_SLUG,
      // mission-control: one resolved slug set, shared with the multi-tenant plugin below, so a
      // renamed collection keeps its tenant scoping and site-key reads.
      collections: payloadJobsCollectionOptions,
      tenancy: 'multi',
    }),
    // mission-control: add-ons (PJ-115), after payloadJobs(). Tenants switch them with `addOns`.
    payloadJobsAlerts({ slug: ALERT_SUBSCRIPTIONS_SLUG }),
    payloadJobsReports(),
    // mission-control: Xero add-on (PJ-57): settings, OAuth, order invoices and their retry task.
    // Secrets are read per request in Workers; the Node CLI falls back to the XERO_* env vars.
    payloadJobsXero({
      xero: {
        oauth: {
          clientId: () => workerEnv?.XERO_CLIENT_ID,
          clientSecret: () => workerEnv?.XERO_CLIENT_SECRET,
          encryptionKey: () => workerEnv?.XERO_TOKEN_ENCRYPTION_KEY,
          redirectUri: () => workerEnv?.XERO_REDIRECT_URI,
          stateSecret: () => workerEnv?.XERO_STATE_SECRET,
        },
      },
    }),
    // mission-control: the form builder's collections (PJ-102). Before the multi-tenant plugin,
    // so `forms` and `form-submissions` are there for it to scope.
    formBuilderPlugin(formBuilderOptions()),
    multiTenantPlugin(multiTenantOptionsFor(payloadJobsCollectionSlugs)),
  ],
  localization: {
    locales: [{ code: 'en', label: 'English' }],
    fallback: true,
    defaultLocale: 'en',
  },
})
