import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // Astro components need Astro's Vite plugin, which the launchpad and
          // rocketship-payload projects load.
          include: [
            'packages/*/src/**/*.test.ts',
            // mission-control: admin components are TSX (PJ-30, S-117).
            'packages/*/src/**/*.test.tsx',
            'apps/*/src/**/*.test.ts',
            '.github/scripts/*.test.ts',
            'scripts/**/*.test.ts', // mission-control: features catalogue report
            'tools/*/src/**/*.test.ts', // mission-control: include tools/
          ],
          exclude: [
            'packages/launchpad/**',
            'packages/rocketship-payload/**',
            // mission-control: needs Astro's Vite plugin for .astro components.
            'apps/vwok/**',
          ],
        },
      },
      './packages/launchpad',
      './packages/rocketship-payload',
      './apps/vwok',
    ],
    // The Postgres harness pushes a schema per boot against one TEST_DATABASE_URL; run files
    // one at a time, and allow a boot (schema pull + push) more than the 10s default.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
})
