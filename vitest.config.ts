import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // Astro components need Astro's Vite plugin, which only the launchpad project loads.
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            '.github/scripts/*.test.ts',
            'scripts/**/*.test.ts', // mission-control: features catalogue report
            'tools/*/src/**/*.test.ts', // mission-control: include tools/
          ],
          exclude: ['packages/launchpad/**'],
        },
      },
      './packages/launchpad',
    ],
    // The Postgres harness pushes a schema per boot against one TEST_DATABASE_URL; run files
    // one at a time, and allow a boot (schema pull + push) more than the 10s default.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
})
