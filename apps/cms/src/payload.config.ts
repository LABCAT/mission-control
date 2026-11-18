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
import { payloadJobs } from '@mission-control/payload-jobs'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { Tenants } from './collections/Tenants'
import { SiteKeys } from './collections/SiteKeys'
import { SystemStatus } from './globals/SystemStatus'
import { cloudflareEmailAdapter } from './email/cloudflare-email-adapter'
import { heartbeatTask } from './jobs/heartbeat'
import { Documents } from './collections/Documents'
import { createMediaTransformers } from './media'
import { r2Storage } from '@payloadcms/storage-r2'
import { multiTenantOptions } from './tenancy'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// In workerd the database comes from the Hyperdrive binding. The Node CLI (migrations,
// type generation) has no bindings and uses DATABASE_URL.
// mission-control: also gates the sharp import and the R2 adapter below.
const isWorkers = globalThis.navigator?.userAgent === 'Cloudflare-Workers'
const workerEnv =
  isWorkers
    ? ((await import('cloudflare:workers')).env as {
        HYPERDRIVE?: { connectionString: string }
        MEDIA?: R2Bucket // mission-control: R2 bucket `mission-control-media`
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
  email: cloudflareEmailAdapter,
  globals: [SystemStatus],
  jobs: { tasks: [heartbeatTask] },
  // mission-control: resized media variants (PJ-10)
  upload: { transformers: await createMediaTransformers(isWorkers) },
  // mission-control: media and documents live in R2 (binding `MEDIA`). The Node CLI has no
  // bindings, so there the adapter is off and the schema stays identical.
  storage: [
    r2Storage({
      bucket: workerEnv?.MEDIA as R2Bucket,
      collections: { documents: true, media: true },
      enabled: Boolean(workerEnv?.MEDIA),
    }),
  ],
  plugins: [payloadJobs({ tenancy: 'multi' }), multiTenantPlugin(multiTenantOptions)],
  localization: {
    locales: [{ code: 'en', label: 'English' }],
    fallback: true,
    defaultLocale: 'en',
  },
})
