import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      '.github/scripts/*.test.ts',
      'tools/*/src/**/*.test.ts', // mission-control: include tools/
    ],
    // The Postgres harness pushes the schema for the collections under test, so two test
    // files booting Payload at once would race on the same TEST_DATABASE_URL. Run files one
    // at a time, and allow a boot (schema pull + push) more than the 10s default.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
})
