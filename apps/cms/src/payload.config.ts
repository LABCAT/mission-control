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
import { SystemStatus } from './globals/SystemStatus'
import { heartbeatTask } from './jobs/heartbeat'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// In workerd the database comes from the Hyperdrive binding. The Node CLI (migrations,
// type generation) has no bindings and uses DATABASE_URL.
const workerEnv =
  globalThis.navigator?.userAgent === 'Cloudflare-Workers'
    ? ((await import('cloudflare:workers')).env as { HYPERDRIVE?: { connectionString: string } })
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
  collections: [Users, Media, Folders, Tags],
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
    },
    // Dev schema push needs drizzle-kit, which doesn't run in workerd. Schema changes go
    // through migrations, run with the Node CLI (`pnpm payload migrate`).
    push: false,
  }),
  globals: [SystemStatus],
  jobs: { tasks: [heartbeatTask] },
  plugins: [payloadJobs()],
  localization: {
    locales: [{ code: 'en', label: 'English' }],
    fallback: true,
    defaultLocale: 'en',
  },
})
