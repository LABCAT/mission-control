import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      '.github/scripts/**/*.test.ts',
      'tools/*/src/**/*.test.ts', // mission-control: include tools/
    ],
    // The Postgres harness pushes a schema per boot against one TEST_DATABASE_URL; run files
    // one at a time, and allow a boot (schema pull + push) more than the 10s default.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
})
